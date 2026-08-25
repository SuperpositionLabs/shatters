package api

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"

	"github.com/SuperpositionLabs/shatters/server/internal/crypto"
	"github.com/SuperpositionLabs/shatters/server/internal/db"
)

// buildOTKs creates count syntactically valid one-time prekey entries.
func buildOTKs(t *testing.T, fromID uint32, count int) []otkRequest {
	t.Helper()
	otks := make([]otkRequest, 0, count)
	for i := fromID; i < fromID+uint32(count); i++ {
		k := make([]byte, crypto.PublicKeySize)
		if _, err := rand.Read(k); err != nil {
			t.Fatalf("rand: %v", err)
		}
		otks = append(otks, otkRequest{ID: i, PublicKey: base64.StdEncoding.EncodeToString(k)})
	}
	return otks
}

func uploadOTKs(t *testing.T, h http.Handler, token string, otks []otkRequest) {
	t.Helper()

	req := mustJSONRequest(t, http.MethodPost, "/v1/accounts/me/prekeys",
		map[string]any{"one_time_prekeys": otks})
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusCreated {
		t.Fatalf("upload status = %d, want 201 (%s)", rec.Code, rec.Body.String())
	}
}

func fetchBundle(t *testing.T, h http.Handler, accountID, token string) (map[string]any, int) {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/v1/accounts/"+accountID+"/bundle", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	var body map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &body)
	return body, rec.Code
}

// registerAndAuth is the common fixture: registered account with session.
func registerAndAuth(t *testing.T, h http.Handler) (fixture, string) {
	t.Helper()
	fx := makeFixture(t, nil)
	if rec := postRegister(t, h, fx.body); rec.Code != http.StatusCreated {
		t.Fatalf("setup registration failed: %d %s", rec.Code, rec.Body.String())
	}
	return fx, authenticate(t, h, fx)
}

func TestBundleFlowConsumesOneTimePrekeysAtomically(t *testing.T) {
	pool := testPool(t)
	h := NewServer(pool)

	// Register WITHOUT any one-time prekeys so consumption math is exact.
	fx := makeFixture(t, func(r *registerRequest) { r.OneTimePrekeys = nil })
	if rec := postRegister(t, h, fx.body); rec.Code != http.StatusCreated {
		t.Fatalf("setup registration failed: %d %s", rec.Code, rec.Body.String())
	}
	accountID := crypto.AccountID(fx.identity)
	token := authenticate(t, h, fx)

	const n = 5
	uploadOTKs(t, h, token, buildOTKs(t, 100, n))

	seen := make(map[float64]bool)
	for range n {
		body, code := fetchBundle(t, h, accountID, token)
		if code != http.StatusOK {
			t.Fatalf("bundle status = %d (%v)", code, body)
		}
		otk, ok := body["one_time_prekey"].(map[string]any)
		if !ok {
			t.Fatalf("expected one_time_prekey in bundle: %v", body)
		}
		id := otk["id"].(float64)
		if seen[id] {
			t.Fatalf("one-time prekey id %.0f handed out twice", id)
		}
		seen[id] = true
	}

	body, code := fetchBundle(t, h, accountID, token)
	if code != http.StatusOK {
		t.Fatalf("exhausted bundle status = %d", code)
	}
	if _, present := body["one_time_prekey"]; present {
		t.Error("exhausted bundle still contained a one-time prekey")
	}
	if _, present := body["signed_prekey"]; !present {
		t.Error("bundle lost its signed prekey")
	}
}

func TestBundleConcurrentFetchNeverDuplicatesOTKs(t *testing.T) {
	if testing.Short() {
		t.Skip("concurrency check skipped in short mode")
	}
	pool := testPool(t)
	h := NewServer(pool)

	// No registration OTKs: exactly `workers` keys exist for the race.
	fx := makeFixture(t, func(r *registerRequest) { r.OneTimePrekeys = nil })
	if rec := postRegister(t, h, fx.body); rec.Code != http.StatusCreated {
		t.Fatalf("setup: %d", rec.Code)
	}
	accountID := crypto.AccountID(fx.identity)
	token := authenticate(t, h, fx)

	const workers = 8
	uploadOTKs(t, h, token, buildOTKs(t, 500, workers))

	results := make(chan float64, workers)
	var wg sync.WaitGroup
	for range workers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			body, code := fetchBundle(t, h, accountID, token)
			if code != http.StatusOK {
				return
			}
			if otk, ok := body["one_time_prekey"].(map[string]any); ok {
				results <- otk["id"].(float64)
			}
		}()
	}
	wg.Wait()
	close(results)

	seen := make(map[float64]bool)
	for id := range results {
		if seen[id] {
			t.Errorf("atomicity violated: prekey %.0f delivered twice", id)
		}
		seen[id] = true
	}
	if len(seen) != workers {
		t.Errorf("delivered %d unique prekeys to %d workers", len(seen), workers)
	}
}

func TestPrekeyEndpointsRejectUnauthenticated(t *testing.T) {
	h := NewServer(testPool(t))

	req := mustJSONRequest(t, http.MethodPost, "/v1/accounts/me/prekeys",
		map[string]any{"one_time_prekeys": buildOTKs(t, 1, 1)})
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("upload without token status = %d, want 401", rec.Code)
	}

	req = httptest.NewRequest(http.MethodGet, "/v1/accounts/abc/bundle", nil)
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Errorf("bundle without token status = %d, want 401", rec.Code)
	}
}

func TestUploadEnforcesStorageCap(t *testing.T) {
	pool := testPool(t)
	h := NewServer(pool)

	fx, token := registerAndAuth(t, h)
	_ = fx

	// A single upload above MaxStoredPrekeysPerAccount can never fit and is rejected.
	otks := buildOTKs(t, 9000, db.MaxStoredPrekeysPerAccount+10)
	req := mustJSONRequest(t, http.MethodPost, "/v1/accounts/me/prekeys",
		map[string]any{"one_time_prekeys": otks})
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusBadRequest {
		t.Errorf("oversized upload status = %d, want 400", rec.Code)
	}
}
