package api

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"

	"github.com/SuperpositionLabs/shatters/server/internal/crypto"
	"github.com/SuperpositionLabs/shatters/server/internal/db"
)

const maxBodyBytes = 1 << 20

// jsonDecode decodes the request body into v, answering 400 on failure.
func jsonDecode(r *http.Request, w http.ResponseWriter, v any) error {
	err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxBodyBytes)).Decode(v)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return err
	}
	return nil
}

func decodeB64(s string) ([]byte, bool) {
	b, err := base64.StdEncoding.DecodeString(s)
	if err != nil {
		return nil, false
	}
	return b, true
}

// handleChallenge implements POST /v1/auth/challenge.
func (s *Server) handleChallenge(w http.ResponseWriter, r *http.Request) {
	var req struct {
		AccountID string `json:"account_id"`
	}
	if err := jsonDecode(r, w, &req); err != nil {
		return
	}

	account, err := db.AccountByPublicID(r.Context(), s.pool, req.AccountID)
	if err != nil {
		writeError(w, http.StatusBadRequest, "unknown account")
		return
	}

	nonce, err := crypto.RandomNonce(32)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	if err := db.CreateChallenge(r.Context(), s.pool, account.ID, nonce); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{
		"nonce": base64.StdEncoding.EncodeToString(nonce),
	})
}

// handleVerify implements POST /v1/auth/verify.
func (s *Server) handleVerify(w http.ResponseWriter, r *http.Request) {
	var req struct {
		AccountID string `json:"account_id"`
		Nonce     string `json:"nonce"`
		Signature string `json:"signature"`
	}
	if err := jsonDecode(r, w, &req); err != nil {
		return
	}

	nonce, ok := decodeB64(req.Nonce)
	if !ok || len(nonce) != 32 {
		writeError(w, http.StatusBadRequest, "malformed nonce")
		return
	}
	sig, ok := decodeB64(req.Signature)
	if !ok || len(sig) != crypto.SignatureSize {
		writeError(w, http.StatusBadRequest, "malformed signature")
		return
	}

	account, err := db.AccountByPublicID(r.Context(), s.pool, req.AccountID)
	if err != nil {
		writeError(w, http.StatusUnauthorized, "authentication failed")
		return
	}

	if err := crypto.VerifyAuthProof(account.IdentityKey, nonce, sig); err != nil {
		writeError(w, http.StatusUnauthorized, "authentication failed")
		return
	}

	consumed, err := db.ConsumeChallenge(r.Context(), s.pool, account.ID, nonce)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	if !consumed {
		writeError(w, http.StatusUnauthorized, "unknown or expired nonce")
		return
	}

	token, err := crypto.RandomNonce(32)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}
	// The session token IS this base64 string: clients send exactly what they
	// received as a bearer credential, so the hash must cover the same bytes.
	tokenB64 := base64.StdEncoding.EncodeToString(token)
	sum := sha256.Sum256([]byte(tokenB64))
	if err := db.CreateSessionToken(r.Context(), s.pool, account.ID, sum[:]); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}

	writeJSON(w, http.StatusOK, map[string]string{
		"token": tokenB64,
	})
}
