package api

import (
	"encoding/json"
	"net/http"
	"strconv"

	"github.com/SuperpositionLabs/shatters/server/internal/crypto"
	"github.com/SuperpositionLabs/shatters/server/internal/db"
)

type registerRequest struct {
	IdentityKey         string `json:"identity_key"`
	IdentityDHKey       string `json:"identity_dh_key"`
	IdentityDHSignature string `json:"identity_dh_signature"`
	SignedPrekey        struct {
		ID        uint32 `json:"id"`
		PublicKey string `json:"public_key"`
		Signature string `json:"signature"`
	} `json:"signed_prekey"`
	OneTimePrekeys []struct {
		ID        uint32 `json:"id"`
		PublicKey string `json:"public_key"`
	} `json:"one_time_prekeys"`
}

// handleRegister implements POST /v1/accounts (docs/protocol.md §4).
// Only public key material is accepted; everything is validated before any
// database write, so rejected requests never leave partial state.
func (s *Server) handleRegister(w http.ResponseWriter, r *http.Request) {
	var req registerRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}

	identityKey, err := crypto.DecodeKey(req.IdentityKey)
	if err != nil {
		writeError(w, http.StatusBadRequest, "identity_key: "+err.Error())
		return
	}
	dhKey, err := crypto.DecodeKey(req.IdentityDHKey)
	if err != nil {
		writeError(w, http.StatusBadRequest, "identity_dh_key: "+err.Error())
		return
	}
	dhSig, err := crypto.DecodeSignature(req.IdentityDHSignature)
	if err != nil {
		writeError(w, http.StatusBadRequest, "identity_dh_signature: "+err.Error())
		return
	}
	// Refused rather than stored unverified: a bundle is only as trustworthy
	// as the weakest thing in it, and this key had nothing vouching for it.
	if err := crypto.VerifyIdentityDHKey(identityKey, dhKey, dhSig); err != nil {
		writeError(w, http.StatusBadRequest, "identity DH key signature rejected")
		return
	}

	spkPub, err := crypto.DecodeKey(req.SignedPrekey.PublicKey)
	if err != nil {
		writeError(w, http.StatusBadRequest, "signed_prekey.public_key: "+err.Error())
		return
	}
	sig, err := crypto.DecodeSignature(req.SignedPrekey.Signature)
	if err != nil {
		writeError(w, http.StatusBadRequest, "signed_prekey.signature: "+err.Error())
		return
	}
	if err := crypto.VerifySignedPrekey(identityKey, spkPub, sig, req.SignedPrekey.ID); err != nil {
		writeError(w, http.StatusBadRequest, "signed prekey signature rejected")
		return
	}

	if len(req.OneTimePrekeys) > db.MaxPrekeysPerRequest {
		writeError(w, http.StatusBadRequest, "too many one_time_prekeys")
		return
	}
	otks := make([]db.Prekey, 0, len(req.OneTimePrekeys))
	for i, k := range req.OneTimePrekeys {
		pub, err := crypto.DecodeKey(k.PublicKey)
		if err != nil {
			writeError(w, http.StatusBadRequest,
				"one_time_prekeys["+strconv.Itoa(i)+"].public_key: "+err.Error())
			return
		}
		otks = append(otks, db.Prekey{ID: k.ID, PublicKey: pub})
	}

	publicID, created, err := db.CreateAccount(r.Context(), s.pool, db.CreateAccountParams{
		PublicID:            crypto.AccountID(identityKey),
		IdentityKey:         identityKey,
		IdentityDHKey:       dhKey,
		IdentityDHSignature: dhSig,
		SignedPrekey: db.SignedPrekey{
			ID:        req.SignedPrekey.ID,
			PublicKey: spkPub,
			Signature: sig,
		},
		OneTimePrekeys: otks,
	})
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}

	status := http.StatusCreated
	if !created {
		status = http.StatusOK
	}
	writeJSON(w, status, map[string]string{"account_id": publicID})
}
