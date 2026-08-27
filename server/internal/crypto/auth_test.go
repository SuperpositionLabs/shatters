package crypto

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"testing"
)

func TestRandomNonceLengthAndUniqueness(t *testing.T) {
	seen := make(map[string]bool)
	for range 100 {
		n, err := RandomNonce(32)
		if err != nil {
			t.Fatalf("RandomNonce: %v", err)
		}
		if len(n) != 32 {
			t.Fatalf("len = %d, want 32", len(n))
		}
		key := string(n)
		if seen[key] {
			t.Fatal("duplicate nonce generated")
		}
		seen[key] = true
	}
}

func TestAuthProofKnownVector(t *testing.T) {
	// Cross-language golden vector: the TypeScript client must produce this
	// exact signature for the same seed and nonce, so that its auth proofs
	// verify here (see web/src/lib/crypto/identity.test.ts).
	//
	// seed  = 32 zero bytes -> Ed25519 identity key
	// nonce = 32 zero bytes
	// proof = Ed25519(seed, "shatters-auth-v1" || nonce)
	priv := ed25519.NewKeyFromSeed(make([]byte, 32))
	pub, ok := priv.Public().(ed25519.PublicKey)
	if !ok {
		t.Fatal("unexpected public key type")
	}
	nonce := make([]byte, 32)

	const want = "hW2gkIMjzOoTKetCo5bnVDbOqUYwjzyypFyq5orI8I1DyJqN2M4+EsG8dF/W4dDqqF8FCSqnzTSLo8kFpxoyDw=="
	got := base64.StdEncoding.EncodeToString(ed25519.Sign(priv, append([]byte(domainAuth), nonce...)))
	if got != want {
		t.Errorf("auth proof = %q, want %q", got, want)
	}

	sig, err := base64.StdEncoding.DecodeString(want)
	if err != nil {
		t.Fatalf("decode vector: %v", err)
	}
	if err := VerifyAuthProof(pub, nonce, sig); err != nil {
		t.Errorf("golden proof rejected: %v", err)
	}

	// A proof over the bare nonce - the mistake a client makes when it skips
	// the domain separator - must not verify.
	if err := VerifyAuthProof(pub, nonce, ed25519.Sign(priv, nonce)); err == nil {
		t.Error("proof over undomained nonce accepted")
	}
}

func TestVerifyAuthProof(t *testing.T) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}

	nonce, err := RandomNonce(32)
	if err != nil {
		t.Fatalf("nonce: %v", err)
	}

	msg := append([]byte(domainAuth), nonce...)
	sig := ed25519.Sign(priv, msg)

	if err := VerifyAuthProof(pub, nonce, sig); err != nil {
		t.Fatalf("valid proof rejected: %v", err)
	}

	otherNonce, _ := RandomNonce(32)
	if err := VerifyAuthProof(pub, otherNonce, sig); err == nil {
		t.Error("proof accepted for different nonce")
	}

	tampered := bytes.Clone(sig)
	tampered[10] ^= 0x01
	if err := VerifyAuthProof(pub, nonce, tampered); err == nil {
		t.Error("tampered proof accepted")
	}
}

func TestVerifyRejectsMalformedInputWithoutPanicking(t *testing.T) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	nonce, _ := RandomNonce(32)
	good := ed25519.Sign(priv, append([]byte(domainAuth), nonce...))

	// ed25519.Verify panics on a wrong-sized public key. Every caller happens
	// to validate first today, but a verification routine that crashes on bad
	// input is one refactor away from being a denial of service. Found by
	// fuzzing.
	cases := []struct {
		name string
		key  []byte
		sig  []byte
	}{
		{"empty key", nil, good},
		{"short key", pub[:31], good},
		{"long key", append(bytes.Clone(pub), 0), good},
		{"empty signature", pub, nil},
		{"short signature", pub, good[:63]},
		{"long signature", pub, append(bytes.Clone(good), 0)},
		{"both empty", nil, nil},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if err := VerifyAuthProof(c.key, nonce, c.sig); err == nil {
				t.Error("malformed input was accepted")
			}
		})
	}
}
