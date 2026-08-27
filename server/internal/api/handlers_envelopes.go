package api

import (
	"encoding/base64"
	"errors"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5/pgtype"

	"github.com/SuperpositionLabs/shatters/server/internal/db"
)

// maxAckIDs caps how many envelope ids one acknowledgement may name.
const maxAckIDs = db.MaxEnvelopesPerFetch

// formatUUID renders a raw account/envelope id in canonical form. pgtype is
// already a dependency, so no UUID library is pulled in for this.
func formatUUID(id [16]byte) string {
	return pgtype.UUID{Bytes: id, Valid: true}.String()
}

// parseUUID accepts the canonical form emitted by formatUUID.
func parseUUID(s string) ([16]byte, error) {
	var u pgtype.UUID
	if err := u.Scan(s); err != nil {
		return [16]byte{}, err
	}
	if !u.Valid {
		return [16]byte{}, errors.New("api: null uuid")
	}
	return u.Bytes, nil
}

type sendEnvelopeRequest struct {
	RecipientID string `json:"recipient_id"`
	Payload     string `json:"payload"` // base64, opaque to the server
}

type envelopeResponse struct {
	ID        string `json:"id"`
	SenderID  string `json:"sender_id"`
	Payload   string `json:"payload"`
	CreatedAt string `json:"created_at"`
	ExpiresAt string `json:"expires_at"`
}

// handleSendEnvelope implements POST /v1/envelopes (docs/protocol.md §9).
//
// The payload is stored verbatim; the server decodes base64 only to enforce
// the size cap, and never inspects the bytes.
func (s *Server) handleSendEnvelope(w http.ResponseWriter, r *http.Request) {
	account, ok := authenticatedAccount(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthenticated")
		return
	}

	var req sendEnvelopeRequest
	if err := jsonDecode(r, w, &req); err != nil {
		return
	}

	payload, err := base64.StdEncoding.DecodeString(req.Payload)
	if err != nil {
		writeError(w, http.StatusBadRequest, "payload: invalid base64")
		return
	}
	if len(payload) == 0 {
		writeError(w, http.StatusBadRequest, "payload: empty")
		return
	}
	if len(payload) > db.MaxEnvelopeBytes {
		writeError(w, http.StatusRequestEntityTooLarge, "payload: too large")
		return
	}
	if req.RecipientID == "" {
		writeError(w, http.StatusBadRequest, "recipient_id: required")
		return
	}

	stored, err := db.StoreEnvelope(r.Context(), s.pool,
		account.PublicID, account.ID, req.RecipientID, payload)
	switch {
	case errors.Is(err, db.ErrNotFound):
		writeError(w, http.StatusNotFound, "unknown recipient")
		return
	case errors.Is(err, db.ErrRecipientQueueFull):
		writeError(w, http.StatusServiceUnavailable, "recipient queue is full")
		return
	case errors.Is(err, db.ErrEnvelopeTooLarge):
		writeError(w, http.StatusRequestEntityTooLarge, "payload: too large")
		return
	case err != nil:
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}

	// The row is committed, so the send has succeeded regardless of whether the
	// recipient is connected. A push that does not land is picked up by the
	// recipient's next fetch.
	s.pushEnvelope(stored.RecipientID, stored.Envelope)

	writeJSON(w, http.StatusCreated, map[string]string{
		"envelope_id": formatUUID(stored.ID),
	})
}

// handleFetchEnvelopes implements GET /v1/envelopes.
//
// The recipient is always the authenticated account: there is no parameter to
// request someone else's queue.
func (s *Server) handleFetchEnvelopes(w http.ResponseWriter, r *http.Request) {
	account, ok := authenticatedAccount(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthenticated")
		return
	}

	envelopes, err := db.FetchEnvelopes(r.Context(), s.pool, account.ID)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}

	out := make([]envelopeResponse, 0, len(envelopes))
	for i := range envelopes {
		out = append(out, envelopeResponse{
			ID:        formatUUID(envelopes[i].ID),
			SenderID:  envelopes[i].SenderPublicID,
			Payload:   base64.StdEncoding.EncodeToString(envelopes[i].Payload),
			CreatedAt: envelopes[i].CreatedAt.UTC().Format(time.RFC3339),
			ExpiresAt: envelopes[i].ExpiresAt.UTC().Format(time.RFC3339),
		})
	}

	writeJSON(w, http.StatusOK, map[string]any{"envelopes": out})
}

// handleAckEnvelopes implements POST /v1/envelopes/ack.
//
// Deletion is deliberately separated from fetching: a client that dies partway
// through a transfer must see its envelopes again rather than lose them.
func (s *Server) handleAckEnvelopes(w http.ResponseWriter, r *http.Request) {
	account, ok := authenticatedAccount(r)
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthenticated")
		return
	}

	var req struct {
		IDs []string `json:"envelope_ids"`
	}
	if err := jsonDecode(r, w, &req); err != nil {
		return
	}

	if len(req.IDs) == 0 {
		writeError(w, http.StatusBadRequest, "envelope_ids: required")
		return
	}
	if len(req.IDs) > maxAckIDs {
		writeError(w, http.StatusBadRequest, "envelope_ids: too many")
		return
	}

	ids := make([][16]byte, 0, len(req.IDs))
	for _, raw := range req.IDs {
		parsed, err := parseUUID(raw)
		if err != nil {
			writeError(w, http.StatusBadRequest, "envelope_ids: malformed id")
			return
		}
		ids = append(ids, parsed)
	}

	// Scoped to the caller's own account, so ids belonging to anyone else match
	// nothing and reveal nothing.
	deleted, err := db.AcknowledgeEnvelopes(r.Context(), s.pool, account.ID, ids)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
		return
	}

	writeJSON(w, http.StatusOK, map[string]int64{"acknowledged": deleted})
}
