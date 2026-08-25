package api

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/SuperpositionLabs/shatters/server/internal/crypto"
	"github.com/SuperpositionLabs/shatters/server/internal/ratelimit"
)

// authenticate drives the full challenge/verify flow for an account and
// returns a valid bearer token.
func authenticate(t *testing.T, h http.Handler, fx fixture) string {
	t.Helper()

	nonce := postJSON(t, h, http.MethodPost, "/v1/auth/challenge",
		map[string]string{"account_id": crypto.AccountID(fx.identity)}, http.StatusOK)
	n, ok := decodeB64(nonce["nonce"])
	if !ok || len(n) != 32 {
		t.Fatalf("malformed nonce in response: %v", nonce)
	}

	sig := ed25519.Sign(fx.priv, append([]byte("shatters-auth-v1"), n...))
	tokenResp := postJSON(t, h, http.MethodPost, "/v1/auth/verify", map[string]string{
		"account_id": crypto.AccountID(fx.identity),
		"nonce":      base64.StdEncoding.EncodeToString(n),
		"signature":  base64.StdEncoding.EncodeToString(sig),
	}, http.StatusOK)

	return tokenResp["token"]
}

func TestAuthHappyPathGrantsWorkingToken(t *testing.T) {
	pool := testPool(t)
	h := NewServer(pool)
	fx := makeFixture(t, nil)
	if rec := postRegister(t, h, fx.body); rec.Code != http.StatusCreated {
		t.Fatalf("setup registration failed: %d %s", rec.Code, rec.Body.String())
	}

	token := authenticate(t, h, fx)
	if token == "" {
		t.Fatal("empty token")
	}

	req := httptest.NewRequest(http.MethodGet, "/v1/me", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("/v1/me status = %d, want 200 (%s)", rec.Code, rec.Body.String())
	}
	var body struct {
		AccountID string `json:"account_id"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body.AccountID != crypto.AccountID(fx.identity) {
		t.Errorf("identity mismatch: got %q", body.AccountID)
	}
}

func TestVerifyRejectsTamperedSignature(t *testing.T) {
	pool := testPool(t)
	h := NewServer(pool)
	fx := makeFixture(t, nil)
	if rec := postRegister(t, h, fx.body); rec.Code != http.StatusCreated {
		t.Fatalf("setup: %d", rec.Code)
	}

	nonceResp := postJSON(t, h, http.MethodPost, "/v1/auth/challenge",
		map[string]string{"account_id": crypto.AccountID(fx.identity)}, http.StatusOK)
	n, _ := decodeB64(nonceResp["nonce"])

	sig := ed25519.Sign(fx.priv, append([]byte("shatters-auth-v1"), n...))
	sig[5] ^= 0xff

	postJSON(t, h, http.MethodPost, "/v1/auth/verify", map[string]string{
		"account_id": crypto.AccountID(fx.identity),
		"nonce":      base64.StdEncoding.EncodeToString(n),
		"signature":  base64.StdEncoding.EncodeToString(sig),
	}, http.StatusUnauthorized)
}

func TestNonceIsSingleUse(t *testing.T) {
	pool := testPool(t)
	h := NewServer(pool)
	fx := makeFixture(t, nil)
	if rec := postRegister(t, h, fx.body); rec.Code != http.StatusCreated {
		t.Fatalf("setup: %d", rec.Code)
	}

	accountID := crypto.AccountID(fx.identity)
	nonceResp := postJSON(t, h, http.MethodPost, "/v1/auth/challenge",
		map[string]string{"account_id": accountID}, http.StatusOK)
	n, _ := decodeB64(nonceResp["nonce"])
	encoded := base64.StdEncoding.EncodeToString(n)

	sig := ed25519.Sign(fx.priv, append([]byte("shatters-auth-v1"), n...))
	body := map[string]string{
		"account_id": accountID,
		"nonce":      encoded,
		"signature":  base64.StdEncoding.EncodeToString(sig),
	}

	postJSON(t, h, http.MethodPost, "/v1/auth/verify", body, http.StatusOK)
	postJSON(t, h, http.MethodPost, "/v1/auth/verify", body, http.StatusUnauthorized) // replay
}

func TestMeRejectsMissingToken(t *testing.T) {
	h := NewServer(testPool(t))

	req := httptest.NewRequest(http.MethodGet, "/v1/me", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401", rec.Code)
	}
}

func TestRateLimitReturns429(t *testing.T) {
	pool := testPool(t)
	h := NewServer(pool, WithRateLimiter(ratelimit.NewLimiter(60, 2)))

	body := map[string]string{"account_id": "whatever"}

	for range 2 {
		postJSON(t, h, http.MethodPost, "/v1/auth/challenge", body, http.StatusBadRequest)
	}
	postJSON(t, h, http.MethodPost, "/v1/auth/challenge", body, http.StatusTooManyRequests)
}
