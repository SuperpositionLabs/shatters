package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// postJSON sends a JSON request and asserts the expected status, returning
// the decoded response object.
func postJSON(t *testing.T, h http.Handler, method, path string, payload any, wantStatus int) map[string]string {
	t.Helper()

	raw, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}
	req := httptest.NewRequest(method, path, bytes.NewReader(raw))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != wantStatus {
		t.Fatalf("%s %s status = %d, want %d (body=%s)",
			method, path, rec.Code, wantStatus, rec.Body.String())
	}

	var out map[string]string
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return out
}
