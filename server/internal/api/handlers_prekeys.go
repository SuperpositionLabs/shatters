package api

import (
	"encoding/base64"
	"errors"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"

	"github.com/SuperpositionLabs/shatters/server/internal/crypto"
	"github.com/SuperpositionLabs/shatters/server/internal/db"
)

type otkRequest struct {
	ID        uint32 `json:"id"`
	PublicKey string `json:"public_key"`
}

// handleUploadPrekeys implements POST /v1/accounts/me/prekeys.
func (s *Server) handleUploadPrekeys(w http.ResponseWriter, r *http.Request) {
	account, ok := authenticatedAccount(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthenticated")
		return
	}

	var req struct {
		OneTimePrekeys []otkRequest `json:"one_time_prekeys"`
	}
	if err := jsonDecode(r, w, &req); err != nil {
		return
	}

	if len(req.OneTimePrekeys) == 0 {
		writeError(w, http.StatusBadRequest, "empty one_time_prekeys list")
		return
	}
	if len(req.OneTimePrekeys) > db.MaxPrekeysPerRequest {
		writeError(w, http.StatusBadRequest, "too many one_time_prekeys")
		return
	}

	keys := make([]db.Prekey, 0, len(req.OneTimePrekeys))
	for i, k := range req.OneTimePrekeys {
		pub, err := crypto.DecodeKey(k.PublicKey)
		if err != nil {
			writeError(w, http.StatusBadRequest,
				"one_time_prekeys["+strconv.Itoa(i)+"].public_key: invalid key length")
			return
		}
		keys = append(keys, db.Prekey{ID: k.ID, PublicKey: pub})
	}

	if err := db.AddOneTimePrekeys(r.Context(), s.pool, account.ID, keys); err != nil {
		writeError(w, http.StatusBadRequest, "prekey upload rejected")
		return
	}

	writeJSON(w, http.StatusCreated, map[string]int{"uploaded": len(keys)})
}

// handleGetBundle implements GET /v1/accounts/{accountID}/bundle.
func (s *Server) handleGetBundle(w http.ResponseWriter, r *http.Request) {
	publicID := chi.URLParam(r, "accountID")

	bundle, err := db.FetchBundle(r.Context(), s.pool, publicID)
	switch {
	case errors.Is(err, db.ErrNotFound):
		writeError(w, http.StatusNotFound, "unknown account")
		return
	case err != nil:
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}

	resp := map[string]any{
		"identity_key":          base64.StdEncoding.EncodeToString(bundle.IdentityKey),
		"identity_dh_key":       base64.StdEncoding.EncodeToString(bundle.IdentityDHKey),
		"identity_dh_signature": base64.StdEncoding.EncodeToString(bundle.IdentityDHSignature),
		"signed_prekey": map[string]any{
			"id":         bundle.SignedPrekey.ID,
			"public_key": base64.StdEncoding.EncodeToString(bundle.SignedPrekey.PublicKey),
			"signature":  base64.StdEncoding.EncodeToString(bundle.SignedPrekey.Signature),
		},
	}
	if bundle.OneTimePrekey != nil {
		resp["one_time_prekey"] = map[string]any{
			"id":         bundle.OneTimePrekey.ID,
			"public_key": base64.StdEncoding.EncodeToString(bundle.OneTimePrekey.PublicKey),
		}
	}
	writeJSON(w, http.StatusOK, resp)
}
