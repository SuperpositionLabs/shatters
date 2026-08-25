package crypto

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"testing"
)

func testIdentity(t *testing.T) (ed25519.PublicKey, ed25519.PrivateKey) {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	return pub, priv
}

func TestDecodeKeyAcceptsValid32Bytes(t *testing.T) {
	pub, _ := testIdentity(t)

	k, err := DecodeKey(base64.StdEncoding.EncodeToString(pub))
	if err != nil {
		t.Fatalf("DecodeKey(valid) error = %v", err)
	}
	if string(k) != string(pub) {
		t.Error("decoded key differs from original")
	}
}

func TestDecodeKeyRejectsWrongLength(t *testing.T) {
	for _, s := range []string{"", base64.StdEncoding.EncodeToString([]byte("short")), base64.StdEncoding.EncodeToString(make([]byte, 33))} {
		if _, err := DecodeKey(s); !errors.Is(err, ErrBadKey) {
			t.Errorf("DecodeKey(%q) error = %v, want ErrBadKey", s, err)
		}
	}
}

func TestAccountIDIsDeterministicAndKeyBound(t *testing.T) {
	pub, _ := testIdentity(t)
	id1 := AccountID(pub)
	id2 := AccountID(pub)
	if id1 != id2 {
		t.Fatal("AccountID not deterministic")
	}
	other, _ := testIdentity(t)
	if AccountID(other) == id1 {
		t.Fatal("different identity keys produced the same account ID")
	}
	if len(id1) != 43 { // base64url of 32 bytes without padding
		t.Errorf("account ID length = %d, want 43", len(id1))
	}
}

func TestVerifySignedPrekey(t *testing.T) {
	pub, priv := testIdentity(t)

	spk := make([]byte, PublicKeySize)
	if _, err := rand.Read(spk); err != nil {
		t.Fatalf("rand: %v", err)
	}
	var id uint32 = 42

	msg := append([]byte("shatters-spk-v1"), spk...)
	msg = binary.BigEndian.AppendUint32(msg, id)
	sig := ed25519.Sign(priv, msg)

	if err := VerifySignedPrekey(pub, spk, sig, id); err != nil {
		t.Fatalf("VerifySignedPrekey(valid) = %v, want nil", err)
	}

	if err := VerifySignedPrekey(pub, spk, sig, id+1); err == nil {
		t.Error("verification passed with tampered prekey id")
	}

	wrongPub, _ := testIdentity(t)
	if err := VerifySignedPrekey(wrongPub, spk, sig, id); err == nil {
		t.Error("verification passed with wrong identity key")
	}

	badSig := append([]byte(nil), sig...)
	badSig[0] ^= 0xff
	if err := VerifySignedPrekey(pub, spk, badSig, id); err == nil {
		t.Error("verification passed with corrupted signature")
	}
}
