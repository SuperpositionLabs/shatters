package crypto

import (
	"crypto/ed25519"
	"crypto/rand"
	"errors"
)

// domainAuth separates authentication proofs from every other signed message.
const domainAuth = "shatters-auth-v1"

// ErrBadProof wraps any failure of an authentication proof.
var ErrBadProof = errors.New("crypto: authentication proof rejected")

// RandomNonce returns cryptographically secure random bytes for challenges
// and session tokens.
func RandomNonce(n int) ([]byte, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return nil, err
	}
	return b, nil
}

// VerifyAuthProof checks that sig is a valid Ed25519 signature by identityKey
// over domainAuth || nonce.
func VerifyAuthProof(identityKey, nonce, sig []byte) error {
	msg := make([]byte, 0, len(domainAuth)+len(nonce))
	msg = append(msg, domainAuth...)
	msg = append(msg, nonce...)

	if !ed25519.Verify(ed25519.PublicKey(identityKey), msg, sig) {
		return ErrBadProof
	}
	return nil
}
