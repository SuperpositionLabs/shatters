package crypto

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"testing"
)

// Every decoder here parses bytes an attacker chooses, before anything has
// been authenticated. The unit tests cover the malformed cases someone thought
// of; these cover the ones nobody did.
//
// The bar is the same throughout: returning an error is always acceptable, and
// panicking, hanging or allocating on an attacker-supplied length is not.

func FuzzDecodeKey(f *testing.F) {
	pub, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		f.Fatalf("generate key: %v", err)
	}

	// Seeded from structurally valid input, so the fuzzer starts from shapes
	// the parser accepts rather than from noise it rejects immediately.
	f.Add(base64.StdEncoding.EncodeToString(pub))
	f.Add(base64.URLEncoding.EncodeToString(pub))
	f.Add(base64.StdEncoding.EncodeToString(make([]byte, 31)))
	f.Add(base64.StdEncoding.EncodeToString(make([]byte, 33)))
	f.Add("")
	f.Add("not base64 at all")
	f.Add("////////////////////////////////////////////")

	f.Fuzz(func(t *testing.T, encoded string) {
		key, err := DecodeKey(encoded)
		if err != nil {
			return
		}

		// Anything accepted must be exactly a key, or callers downstream are
		// indexing into something the wrong size.
		if len(key) != PublicKeySize {
			t.Fatalf("accepted a %d-byte key from %q", len(key), encoded)
		}
	})
}

func FuzzDecodeSignature(f *testing.F) {
	_, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		f.Fatalf("generate key: %v", err)
	}

	f.Add(base64.StdEncoding.EncodeToString(ed25519.Sign(priv, []byte("m"))))
	f.Add(base64.StdEncoding.EncodeToString(make([]byte, 63)))
	f.Add(base64.StdEncoding.EncodeToString(make([]byte, 65)))
	f.Add("")
	f.Add("=====")

	f.Fuzz(func(t *testing.T, encoded string) {
		sig, err := DecodeSignature(encoded)
		if err != nil {
			return
		}
		if len(sig) != SignatureSize {
			t.Fatalf("accepted a %d-byte signature from %q", len(sig), encoded)
		}
	})
}

func FuzzVerifySignedPrekey(f *testing.F) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		f.Fatalf("generate key: %v", err)
	}
	spk := make([]byte, PublicKeySize)
	if _, err := rand.Read(spk); err != nil {
		f.Fatalf("rand: %v", err)
	}

	msg := append([]byte(domainSignedPrek), spk...)
	msg = append(msg, 0, 0, 0, 1)
	f.Add([]byte(pub), spk, ed25519.Sign(priv, msg), uint32(1))
	f.Add([]byte{}, []byte{}, []byte{}, uint32(0))

	f.Fuzz(func(t *testing.T, identityKey, spkPublic, sig []byte, id uint32) {
		// Called with whatever survives decoding, so it must tolerate keys and
		// signatures of any length rather than trusting its caller. A panic
		// here is a denial of service on an unauthenticated endpoint.
		_ = VerifySignedPrekey(identityKey, spkPublic, sig, id)
	})
}

func FuzzVerifyAuthProof(f *testing.F) {
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		f.Fatalf("generate key: %v", err)
	}
	nonce := make([]byte, 32)
	if _, err := rand.Read(nonce); err != nil {
		f.Fatalf("rand: %v", err)
	}

	f.Add([]byte(pub), nonce, ed25519.Sign(priv, append([]byte(domainAuth), nonce...)))
	f.Add([]byte{}, []byte{}, []byte{})

	f.Fuzz(func(t *testing.T, identityKey, nonce, sig []byte) {
		_ = VerifyAuthProof(identityKey, nonce, sig)
	})
}

func FuzzAccountID(f *testing.F) {
	f.Add(make([]byte, 32))
	f.Add([]byte{})
	f.Add(make([]byte, 1024))

	f.Fuzz(func(t *testing.T, identityKey []byte) {
		id := AccountID(identityKey)

		// The identifier is used in URLs and as a database key, so it must be
		// a fixed-length, path-safe string whatever it was derived from.
		if len(id) != 43 {
			t.Fatalf("account id length = %d for a %d-byte key", len(id), len(identityKey))
		}
		for _, c := range id {
			base64url := (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') ||
				(c >= '0' && c <= '9') || c == '-' || c == '_'
			if !base64url {
				t.Fatalf("account id %q contains %q, which is not base64url", id, c)
			}
		}
	})
}
