// Package crypto contains the minimal cryptographic operations the shatters
// server is allowed to perform: Ed25519 signature verification, SHA-256
// hashing for opaque identifier derivation, and constant-time comparisons.
//
// The server never decrypts anything and never holds user secret material.
// All primitives come from the Go standard library (crypto/ed25519, crypto/sha256).
package crypto

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
)

const (
	// PublicKeySize is the size of an Ed25519 or X25519 public key in bytes.
	PublicKeySize = 32
	// SignatureSize is the size of an Ed25519 signature in bytes.
	SignatureSize = 64
)

// Domain separation prefixes. These MUST match the values used by clients and
// are part of the protocol surface documented in docs/protocol.md.
const (
	domainAccount    = "shatters-account-v1"
	domainSignedPrek = "shatters-spk-v1"
)

var (
	// ErrBadKey indicates a public key with wrong length or encoding.
	ErrBadKey = errors.New("crypto: malformed public key")
	// ErrBadSignature indicates a signature that fails verification.
	ErrBadSignature = errors.New("crypto: signature verification failed")
)

// DecodeKey decodes a base64 (std or URL) encoded 32-byte public key.
func DecodeKey(s string) ([]byte, error) {
	b, err := base64.StdEncoding.DecodeString(s)
	if err != nil {
		if b, err = base64.URLEncoding.DecodeString(s); err != nil {
			return nil, fmt.Errorf("%w: %v", ErrBadKey, err)
		}
	}
	if len(b) != PublicKeySize {
		return nil, fmt.Errorf("%w: got %d bytes, want %d", ErrBadKey, len(b), PublicKeySize)
	}
	return b, nil
}

// DecodeSignature decodes a base64 encoded Ed25519 signature.
func DecodeSignature(s string) ([]byte, error) {
	b, err := base64.StdEncoding.DecodeString(s)
	if err != nil {
		if b, err = base64.URLEncoding.DecodeString(s); err != nil {
			return nil, fmt.Errorf("%w: %v", ErrBadKey, err)
		}
	}
	if len(b) != SignatureSize {
		return nil, fmt.Errorf("%w: got %d bytes, want %d", ErrBadKey, len(b), SignatureSize)
	}
	return b, nil
}

// AccountID derives the opaque account identifier from an identity key:
// base64url(SHA-256(domain || identity_key)). It leaks nothing beyond what the
// published public key already makes derivable by anyone.
func AccountID(identityKey []byte) string {
	h := sha256.New()
	h.Write([]byte(domainAccount))
	h.Write(identityKey)
	return base64.RawURLEncoding.EncodeToString(h.Sum(nil))
}

// VerifySignedPrekey checks that sig is a valid Ed25519 signature by
// identityKey over domain || spkPublicKey || id (big-endian uint32).
func VerifySignedPrekey(identityKey, spkPublicKey, sig []byte, id uint32) error {
	msg := make([]byte, 0, len(domainSignedPrek)+len(spkPublicKey)+4)
	msg = append(msg, domainSignedPrek...)
	msg = append(msg, spkPublicKey...)
	msg = binary.BigEndian.AppendUint32(msg, id)

	if !ed25519.Verify(ed25519.PublicKey(identityKey), msg, sig) {
		return ErrBadSignature
	}
	return nil
}
