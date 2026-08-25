package crypto

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
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
