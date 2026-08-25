package api

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/SuperpositionLabs/shatters/server/internal/crypto"
)

// registerFixture builds a syntactically valid registration request body.
type fixture struct {
	body     []byte
	identity ed25519.PublicKey
	priv     ed25519.PrivateKey
}

func makeFixture(t *testing.T, mutate func(*registerRequest)) fixture {
	t.Helper()

	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate identity: %v", err)
	}

	dh := make([]byte, crypto.PublicKeySize)
	if _, err := rand.Read(dh); err != nil {
		t.Fatalf("rand dh: %v", err)
	}
	spk := make([]byte, crypto.PublicKeySize)
	if _, err := rand.Read(spk); err != nil {
		t.Fatalf("rand spk: %v", err)
	}

	msg := append([]byte("shatters-spk-v1"), spk...)
	msg = binary.BigEndian.AppendUint32(msg, 0)
	sig := ed25519.Sign(priv, msg)

	req := registerRequest{}
	req.IdentityKey = base64.StdEncoding.EncodeToString(pub)
	req.IdentityDHKey = base64.StdEncoding.EncodeToString(dh)
	req.SignedPrekey.ID = 0
	req.SignedPrekey.PublicKey = base64.StdEncoding.EncodeToString(spk)
	req.SignedPrekey.Signature = base64.StdEncoding.EncodeToString(sig)
	for i := range 3 {
		k := make([]byte, crypto.PublicKeySize)
		if _, err := rand.Read(k); err != nil {
			t.Fatalf("rand otk: %v", err)
		}
		req.OneTimePrekeys = append(req.OneTimePrekeys, struct {
			ID        uint32 `json:"id"`
			PublicKey string `json:"public_key"`
		}{ID: uint32(i + 1), PublicKey: base64.StdEncoding.EncodeToString(k)})
	}

	if mutate != nil {
		mutate(&req)
	}
	body, err := json.Marshal(req)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return fixture{body: body, identity: pub, priv: priv}
}

func postRegister(t *testing.T, h http.Handler, body []byte) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/v1/accounts", bytes.NewReader(body))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestRegisterCreatesAccountAndIsIdempotent(t *testing.T) {
	pool := testPool(t)
	h := NewServer(pool)
	fx := makeFixture(t, nil)

	rec := postRegister(t, h, fx.body)
	if rec.Code != http.StatusCreated {
		t.Fatalf("first registration status = %d, want 201 (%s)", rec.Code, rec.Body.String())
	}
	var first struct {
		AccountID string `json:"account_id"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &first); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if len(first.AccountID) != 43 {
		t.Errorf("account_id length = %d, want 43", len(first.AccountID))
	}
	if first.AccountID != crypto.AccountID(fx.identity) {
		t.Error("account_id does not match derivation from identity key")
	}

	rec = postRegister(t, h, fx.body)
	if rec.Code != http.StatusOK {
		t.Fatalf("duplicate registration status = %d, want 200", rec.Code)
	}
	var second struct {
		AccountID string `json:"account_id"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &second); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	if second.AccountID != first.AccountID {
		t.Errorf("idempotent registration returned %q, want %q", second.AccountID, first.AccountID)
	}
}

func TestRegisterRejectsInvalidRequests(t *testing.T) {
	pool := testPool(t)
	h := NewServer(pool)

	cases := map[string]fixture{
		"bad identity key": makeFixture(t, func(r *registerRequest) { r.IdentityKey = "!!!not-base64!!!" }),
		"short dh key": makeFixture(t, func(r *registerRequest) {
			r.IdentityDHKey = base64.StdEncoding.EncodeToString(make([]byte, 16))
		}),
		"wrong signature": makeFixture(t, func(r *registerRequest) {
			r.SignedPrekey.Signature = base64.StdEncoding.EncodeToString(make([]byte, crypto.SignatureSize))
		}),
		"signature wrong length": makeFixture(t, func(r *registerRequest) {
			r.SignedPrekey.Signature = base64.StdEncoding.EncodeToString([]byte("tiny"))
		}),
	}
	cases["invalid json"] = fixture{body: []byte("{nope"), identity: nil}

	for name, fx := range cases {
		t.Run(name, func(t *testing.T) {
			rec := postRegister(t, h, fx.body)
			if rec.Code != http.StatusBadRequest {
				t.Errorf("status = %d, want 400 (body=%s)", rec.Code, rec.Body.String())
			}
		})
	}
}

func TestRegisterRejectsTooManyPrekeys(t *testing.T) {
	pool := testPool(t)
	h := NewServer(pool)

	fx := makeFixture(t, func(r *registerRequest) {
		r.OneTimePrekeys = nil
		for i := range 101 {
			k := make([]byte, crypto.PublicKeySize)
			_, _ = rand.Read(k)
			r.OneTimePrekeys = append(r.OneTimePrekeys, struct {
				ID        uint32 `json:"id"`
				PublicKey string `json:"public_key"`
			}{ID: uint32(i), PublicKey: base64.StdEncoding.EncodeToString(k)})
		}
	})

	rec := postRegister(t, h, fx.body)
	if rec.Code != http.StatusBadRequest {
		t.Errorf("status = %d, want 400 for oversized prekey list", rec.Code)
	}
}

func TestRegisterNoPartialWritesOnInvalidOTK(t *testing.T) {
	pool := testPool(t)
	h := NewServer(pool)

	fx := makeFixture(t, func(r *registerRequest) {
		// Last OTK is malformed; the whole request must be rejected before
		// any write happens.
		last := len(r.OneTimePrekeys) - 1
		r.OneTimePrekeys[last].PublicKey = "not-valid-key!"
	})

	if rec := postRegister(t, h, fx.body); rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rec.Code)
	}

	var n int
	if err := pool.QueryRow(t.Context(),
		`SELECT count(*) FROM accounts WHERE identity_key = $1`, fx.identity).Scan(&n); err != nil {
		t.Fatalf("query accounts: %v", err)
	}
	if n != 0 {
		t.Errorf("%d account rows found after rejected request, want 0", n)
	}
}

func testPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	url := os.Getenv("DATABASE_URL")
	if url == "" {
		t.Skip("DATABASE_URL not set; skipping integration test")
	}
	pool, err := pgxpool.New(t.Context(), url)
	if err != nil {
		t.Skipf("cannot reach database: %v", err)
	}
	t.Cleanup(pool.Close)
	return pool
}
