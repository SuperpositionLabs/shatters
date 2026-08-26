package api

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/SuperpositionLabs/shatters/server/internal/crypto"
	"github.com/SuperpositionLabs/shatters/server/internal/db"
)

// party is a registered account with a live session token.
type party struct {
	fx        fixture
	token     string
	accountID string
}

func newParty(t *testing.T, h http.Handler) party {
	t.Helper()
	fx, token := registerAndAuth(t, h)
	return party{fx: fx, token: token, accountID: crypto.AccountID(fx.identity)}
}

func authedRequest(t *testing.T, method, path, token string, payload any) *http.Request {
	t.Helper()
	var req *http.Request
	if payload == nil {
		req = httptest.NewRequest(method, path, nil)
	} else {
		req = httptest.NewRequest(method, path, bytes.NewReader(mustJSONBody(t, payload)))
	}
	req.Header.Set("Authorization", "Bearer "+token)
	return req
}

func do(t *testing.T, h http.Handler, req *http.Request) (map[string]any, int) {
	t.Helper()
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	var body map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &body)
	return body, rec.Code
}

// sendEnvelope posts a payload from one party to another, returning the id.
func sendEnvelope(t *testing.T, h http.Handler, from party, toAccountID string, payload []byte) (string, int) {
	t.Helper()
	body, code := do(t, h, authedRequest(t, http.MethodPost, "/v1/envelopes", from.token,
		map[string]string{
			"recipient_id": toAccountID,
			"payload":      base64.StdEncoding.EncodeToString(payload),
		}))
	id, _ := body["envelope_id"].(string)
	return id, code
}

// fetchEnvelopes reads the caller's queue.
func fetchEnvelopes(t *testing.T, h http.Handler, p party) ([]map[string]any, int) {
	t.Helper()
	body, code := do(t, h, authedRequest(t, http.MethodGet, "/v1/envelopes", p.token, nil))

	raw, _ := body["envelopes"].([]any)
	out := make([]map[string]any, 0, len(raw))
	for _, item := range raw {
		if m, ok := item.(map[string]any); ok {
			out = append(out, m)
		}
	}
	return out, code
}

func ackEnvelopes(t *testing.T, h http.Handler, p party, ids []string) (float64, int) {
	t.Helper()
	body, code := do(t, h, authedRequest(t, http.MethodPost, "/v1/envelopes/ack", p.token,
		map[string]any{"envelope_ids": ids}))
	n, _ := body["acknowledged"].(float64)
	return n, code
}

func TestEnvelopeRoundTrip(t *testing.T) {
	pool := testPool(t)
	h := NewServer(pool)

	alice := newParty(t, h)
	bob := newParty(t, h)

	payload := []byte("opaque ciphertext bytes")
	id, code := sendEnvelope(t, h, alice, bob.accountID, payload)
	if code != http.StatusCreated {
		t.Fatalf("send status = %d, want 201", code)
	}
	if id == "" {
		t.Fatal("no envelope_id returned")
	}

	got, code := fetchEnvelopes(t, h, bob)
	if code != http.StatusOK {
		t.Fatalf("fetch status = %d, want 200", code)
	}
	if len(got) != 1 {
		t.Fatalf("fetched %d envelopes, want 1", len(got))
	}

	if got[0]["id"] != id {
		t.Errorf("envelope id = %v, want %s", got[0]["id"], id)
	}
	// The sender is recorded by the server from the session, not the request.
	if got[0]["sender_id"] != alice.accountID {
		t.Errorf("sender_id = %v, want %s", got[0]["sender_id"], alice.accountID)
	}
	// The payload must come back byte-identical: the server stores it verbatim.
	decoded, err := base64.StdEncoding.DecodeString(got[0]["payload"].(string))
	if err != nil {
		t.Fatalf("payload not base64: %v", err)
	}
	if !bytes.Equal(decoded, payload) {
		t.Errorf("payload = %q, want %q", decoded, payload)
	}
}

func TestFetchIsIdempotentUntilAcknowledged(t *testing.T) {
	pool := testPool(t)
	h := NewServer(pool)

	alice := newParty(t, h)
	bob := newParty(t, h)

	id, _ := sendEnvelope(t, h, alice, bob.accountID, []byte("keep me"))

	// A client that dies mid-transfer must see the envelope again, so fetching
	// alone may never delete.
	for i := range 3 {
		got, _ := fetchEnvelopes(t, h, bob)
		if len(got) != 1 {
			t.Fatalf("fetch %d returned %d envelopes, want 1", i, len(got))
		}
	}

	n, code := ackEnvelopes(t, h, bob, []string{id})
	if code != http.StatusOK || n != 1 {
		t.Fatalf("ack = (%v, %d), want (1, 200)", n, code)
	}

	got, _ := fetchEnvelopes(t, h, bob)
	if len(got) != 0 {
		t.Fatalf("after ack fetched %d envelopes, want 0", len(got))
	}
}

func TestEnvelopesAreScopedToTheRecipient(t *testing.T) {
	pool := testPool(t)
	h := NewServer(pool)

	alice := newParty(t, h)
	bob := newParty(t, h)
	mallory := newParty(t, h)

	id, _ := sendEnvelope(t, h, alice, bob.accountID, []byte("for bob only"))

	// Mallory's queue is her own; she cannot see Bob's mail.
	got, code := fetchEnvelopes(t, h, mallory)
	if code != http.StatusOK {
		t.Fatalf("fetch status = %d, want 200", code)
	}
	if len(got) != 0 {
		t.Fatalf("mallory fetched %d envelopes, want 0", len(got))
	}

	// Nor can she delete it by naming its id: the recipient predicate makes the
	// row invisible rather than reporting that it exists.
	n, code := ackEnvelopes(t, h, mallory, []string{id})
	if code != http.StatusOK {
		t.Fatalf("ack status = %d, want 200", code)
	}
	if n != 0 {
		t.Errorf("mallory acknowledged %v envelopes, want 0", n)
	}

	// Bob still has it.
	bobGot, _ := fetchEnvelopes(t, h, bob)
	if len(bobGot) != 1 {
		t.Fatalf("bob fetched %d envelopes, want 1", len(bobGot))
	}
}

func TestEnvelopeEndpointsRejectUnauthenticated(t *testing.T) {
	pool := testPool(t)
	h := NewServer(pool)
	bob := newParty(t, h)

	cases := []struct {
		method, path string
		payload      any
	}{
		{http.MethodPost, "/v1/envelopes", map[string]string{
			"recipient_id": bob.accountID, "payload": base64.StdEncoding.EncodeToString([]byte("x"))}},
		{http.MethodGet, "/v1/envelopes", nil},
		{http.MethodPost, "/v1/envelopes/ack", map[string]any{"envelope_ids": []string{}}},
	}

	for _, c := range cases {
		var req *http.Request
		if c.payload == nil {
			req = httptest.NewRequest(c.method, c.path, nil)
		} else {
			req = mustJSONRequest(t, c.method, c.path, c.payload)
		}
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)

		if rec.Code != http.StatusUnauthorized {
			t.Errorf("%s %s without token = %d, want 401", c.method, c.path, rec.Code)
		}
	}
}

func TestSendRejectsInvalidRequests(t *testing.T) {
	pool := testPool(t)
	h := NewServer(pool)

	alice := newParty(t, h)
	bob := newParty(t, h)

	oversized := make([]byte, db.MaxEnvelopeBytes+1)
	if _, err := rand.Read(oversized); err != nil {
		t.Fatalf("rand: %v", err)
	}

	cases := []struct {
		name    string
		payload map[string]string
		want    int
	}{
		{"unknown recipient", map[string]string{
			"recipient_id": "definitely-not-an-account",
			"payload":      base64.StdEncoding.EncodeToString([]byte("x")),
		}, http.StatusNotFound},
		{"missing recipient", map[string]string{
			"payload": base64.StdEncoding.EncodeToString([]byte("x")),
		}, http.StatusBadRequest},
		{"empty payload", map[string]string{
			"recipient_id": bob.accountID, "payload": "",
		}, http.StatusBadRequest},
		{"payload not base64", map[string]string{
			"recipient_id": bob.accountID, "payload": "not base64 !!",
		}, http.StatusBadRequest},
		{"payload over cap", map[string]string{
			"recipient_id": bob.accountID,
			"payload":      base64.StdEncoding.EncodeToString(oversized),
		}, http.StatusRequestEntityTooLarge},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, code := do(t, h, authedRequest(t, http.MethodPost, "/v1/envelopes", alice.token, c.payload))
			if code != c.want {
				t.Errorf("status = %d, want %d", code, c.want)
			}
		})
	}

	// Nothing above may have been stored.
	got, _ := fetchEnvelopes(t, h, bob)
	if len(got) != 0 {
		t.Errorf("rejected sends left %d envelopes queued, want 0", len(got))
	}
}

func TestAcceptsPayloadExactlyAtTheCap(t *testing.T) {
	pool := testPool(t)
	h := NewServer(pool)

	alice := newParty(t, h)
	bob := newParty(t, h)

	payload := make([]byte, db.MaxEnvelopeBytes)
	if _, err := rand.Read(payload); err != nil {
		t.Fatalf("rand: %v", err)
	}

	// The boundary itself must be allowed, or the documented cap is a lie.
	if _, code := sendEnvelope(t, h, alice, bob.accountID, payload); code != http.StatusCreated {
		t.Fatalf("send at cap = %d, want 201", code)
	}

	got, _ := fetchEnvelopes(t, h, bob)
	if len(got) != 1 {
		t.Fatalf("fetched %d envelopes, want 1", len(got))
	}
	decoded, _ := base64.StdEncoding.DecodeString(got[0]["payload"].(string))
	if !bytes.Equal(decoded, payload) {
		t.Error("payload at cap did not round-trip intact")
	}
}

func TestAckRejectsMalformedInput(t *testing.T) {
	pool := testPool(t)
	h := NewServer(pool)
	bob := newParty(t, h)

	tooMany := make([]string, db.MaxEnvelopesPerFetch+1)
	for i := range tooMany {
		tooMany[i] = "00000000-0000-0000-0000-000000000000"
	}

	cases := []struct {
		name string
		ids  []string
	}{
		{"empty list", nil},
		{"malformed id", []string{"not-a-uuid"}},
		{"too many ids", tooMany},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			_, code := ackEnvelopes(t, h, bob, c.ids)
			if code != http.StatusBadRequest {
				t.Errorf("status = %d, want 400", code)
			}
		})
	}
}

func TestExpiredEnvelopesAreNeverServed(t *testing.T) {
	pool := testPool(t)
	h := NewServer(pool)

	alice := newParty(t, h)
	bob := newParty(t, h)

	id, _ := sendEnvelope(t, h, alice, bob.accountID, []byte("stale"))

	// Age the envelope past its TTL directly, since waiting 30 days is not an
	// option and the sweep is independent of the read path.
	expireEnvelope(t, pool, id)

	got, _ := fetchEnvelopes(t, h, bob)
	if len(got) != 0 {
		t.Fatalf("expired envelope was served (%d returned)", len(got))
	}

	// And the sweep reclaims it.
	swept, err := db.DeleteExpiredEnvelopes(t.Context(), pool)
	if err != nil {
		t.Fatalf("sweep: %v", err)
	}
	if swept < 1 {
		t.Errorf("sweep removed %d rows, want at least 1", swept)
	}
}

func TestFetchIsBoundedAndOrdered(t *testing.T) {
	pool := testPool(t)
	h := NewServer(pool)

	alice := newParty(t, h)
	bob := newParty(t, h)

	const sent = db.MaxEnvelopesPerFetch + 5
	for i := range sent {
		if _, code := sendEnvelope(t, h, alice, bob.accountID, []byte{byte(i), 0x01}); code != http.StatusCreated {
			t.Fatalf("send %d = %d, want 201", i, code)
		}
	}

	got, _ := fetchEnvelopes(t, h, bob)
	if len(got) != db.MaxEnvelopesPerFetch {
		t.Fatalf("fetched %d envelopes, want the cap of %d", len(got), db.MaxEnvelopesPerFetch)
	}

	// Oldest first, so a client draining its backlog preserves order.
	var previous time.Time
	for i, e := range got {
		created, err := time.Parse(time.RFC3339, e["created_at"].(string))
		if err != nil {
			t.Fatalf("created_at not RFC3339: %v", err)
		}
		if i > 0 && created.Before(previous) {
			t.Errorf("envelope %d is older than its predecessor", i)
		}
		previous = created
	}

	// Draining the first page exposes the remainder.
	ids := make([]string, 0, len(got))
	for _, e := range got {
		ids = append(ids, e["id"].(string))
	}
	if n, _ := ackEnvelopes(t, h, bob, ids); int(n) != db.MaxEnvelopesPerFetch {
		t.Fatalf("acknowledged %v, want %d", n, db.MaxEnvelopesPerFetch)
	}

	rest, _ := fetchEnvelopes(t, h, bob)
	if len(rest) != sent-db.MaxEnvelopesPerFetch {
		t.Errorf("second page had %d envelopes, want %d", len(rest), sent-db.MaxEnvelopesPerFetch)
	}
}

func TestAcknowledgeIsIdempotent(t *testing.T) {
	pool := testPool(t)
	h := NewServer(pool)

	alice := newParty(t, h)
	bob := newParty(t, h)

	id, _ := sendEnvelope(t, h, alice, bob.accountID, []byte("once"))

	if n, _ := ackEnvelopes(t, h, bob, []string{id}); n != 1 {
		t.Fatalf("first ack = %v, want 1", n)
	}
	// A retried acknowledgement after a lost response must not be an error.
	if n, code := ackEnvelopes(t, h, bob, []string{id}); n != 0 || code != http.StatusOK {
		t.Errorf("second ack = (%v, %d), want (0, 200)", n, code)
	}
}

// expireEnvelope backdates an envelope's expiry so TTL behaviour is testable.
func expireEnvelope(t *testing.T, pool *pgxpool.Pool, id string) {
	t.Helper()
	parsed, err := parseUUID(id)
	if err != nil {
		t.Fatalf("parse envelope id: %v", err)
	}
	if _, err := pool.Exec(context.Background(),
		`UPDATE envelopes SET expires_at = now() - interval '1 second' WHERE id = $1`,
		parsed[:]); err != nil {
		t.Fatalf("expire envelope: %v", err)
	}
}
