package api

import (
	"encoding/base64"
	"testing"
)

// FuzzParseUUID exercises the envelope-id parser, which runs on ids taken
// straight from an authenticated but otherwise untrusted request body.
func FuzzParseUUID(f *testing.F) {
	f.Add("00000000-0000-0000-0000-000000000000")
	f.Add("9b2d5f70-1a3c-4d5e-8f01-2233445566aa")
	f.Add("")
	f.Add("not-a-uuid")
	f.Add("00000000000000000000000000000000")
	f.Add("--------------------------------")
	// A form the parser might accept loosely; round-tripping catches it.
	f.Add("0-0-0-0-0")

	f.Fuzz(func(t *testing.T, raw string) {
		id, err := parseUUID(raw)
		if err != nil {
			return
		}

		// Anything accepted must render back to a canonical form that parses
		// to the same value. Otherwise two spellings of one id exist, and an
		// acknowledgement could name a row the sender did not mean.
		formatted := formatUUID(id)
		reparsed, err := parseUUID(formatted)
		if err != nil {
			t.Fatalf("formatUUID(%q) = %q, which does not parse: %v", raw, formatted, err)
		}
		if reparsed != id {
			t.Fatalf("round trip changed the value: %q -> %q -> %x", raw, formatted, reparsed)
		}
	})
}

// FuzzDecodeB64 covers the helper that reads nonces and signatures out of
// authentication requests, before anything about the caller is known.
func FuzzDecodeB64(f *testing.F) {
	f.Add(base64.StdEncoding.EncodeToString(make([]byte, 32)))
	f.Add("")
	f.Add("=")
	f.Add("A")
	f.Add("////")
	f.Add("\x00\x01\x02")

	f.Fuzz(func(t *testing.T, raw string) {
		decoded, ok := decodeB64(raw)
		if !ok {
			return
		}
		// Decoding must not invent bytes: base64 expands by exactly 4/3.
		if len(decoded) > len(raw) {
			t.Fatalf("decoded %d bytes from %d characters", len(decoded), len(raw))
		}
	})
}

// FuzzOriginMatching covers the same-origin fallback, which decides whether a
// cross-origin browser request is answered at all.
func FuzzOriginMatching(f *testing.F) {
	f.Add("https://api.example", "api.example")
	f.Add("http://localhost:3000", "localhost:3000")
	f.Add("", "")
	f.Add("null", "api.example")
	f.Add("https://", "")

	f.Fuzz(func(t *testing.T, origin, host string) {
		matched := sameOrigin(origin, host)
		if !matched {
			return
		}

		// A match means the request is answered with CORS headers, so an empty
		// or schemeless origin must never satisfy it - that is how a null
		// origin ends up trusted.
		if origin == "" {
			t.Fatal("an empty Origin was treated as same-origin")
		}
		if len(origin) <= len("http://") {
			t.Fatalf("origin %q is too short to carry a scheme and a host", origin)
		}
	})
}
