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
//
// Lengths are checked here rather than assumed. ed25519.Verify panics on a
// public key of the wrong size, and this function is reached with material
// that originated outside the process; today every caller validates first, but
// a verification routine that panics on bad input is one refactor away from
// being a denial of service. Found by fuzzing.
func VerifyAuthProof(identityKey, nonce, sig []byte) error {
	if len(identityKey) != PublicKeySize || len(sig) != SignatureSize {
		return ErrBadProof
	}

	msg := make([]byte, 0, len(domainAuth)+len(nonce))
	msg = append(msg, domainAuth...)
	msg = append(msg, nonce...)

	if !ed25519.Verify(ed25519.PublicKey(identityKey), msg, sig) {
		return ErrBadProof
	}
	return nil
}
