package api

import (
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/SuperpositionLabs/shatters/server/internal/db"
)

// wsClient is a test client over a real WebSocket connection.
type wsClient struct {
	t    *testing.T
	conn *websocket.Conn
}

// dialWS opens a socket against the test server without authenticating.
func dialWS(t *testing.T, srv *httptest.Server) *wsClient {
	t.Helper()

	url := "ws" + strings.TrimPrefix(srv.URL, "http") + "/v1/ws"
	conn, _, err := websocket.DefaultDialer.Dial(url, nil)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	t.Cleanup(func() { _ = conn.Close() })

	return &wsClient{t: t, conn: conn}
}

// connect dials and completes first-frame authentication.
func connectWS(t *testing.T, srv *httptest.Server, token string) *wsClient {
	t.Helper()

	c := dialWS(t, srv)
	c.send(clientMessage{Type: "auth", Token: token})
	if msg := c.read(); msg.Type != "ready" {
		t.Fatalf("expected ready, got %+v", msg)
	}
	return c
}

func (c *wsClient) send(msg clientMessage) {
	c.t.Helper()
	if err := c.conn.WriteJSON(msg); err != nil {
		c.t.Fatalf("write: %v", err)
	}
}

func (c *wsClient) read() serverMessage {
	c.t.Helper()
	_ = c.conn.SetReadDeadline(time.Now().Add(5 * time.Second))

	var msg serverMessage
	if err := c.conn.ReadJSON(&msg); err != nil {
		c.t.Fatalf("read: %v", err)
	}
	return msg
}

// expectNoMessage asserts nothing arrives within a short window.
func (c *wsClient) expectNoMessage() {
	c.t.Helper()
	_ = c.conn.SetReadDeadline(time.Now().Add(300 * time.Millisecond))

	var msg serverMessage
	err := c.conn.ReadJSON(&msg)
	if err == nil {
		c.t.Fatalf("expected no message, got %+v", msg)
	}
	if !isTimeout(err) {
		c.t.Fatalf("expected a read timeout, got %v", err)
	}
}

func isTimeout(err error) bool {
	type timeout interface{ Timeout() bool }
	t, ok := err.(timeout)
	return ok && t.Timeout()
}

// newWSServer starts a test HTTP server sharing the service under test, so the
// hub is the same instance the REST handlers push through.
func newWSServer(t *testing.T) (*httptest.Server, *Service, *pgxpool.Pool) {
	t.Helper()

	pool := testPool(t)
	svc := NewServer(pool)
	srv := httptest.NewServer(svc)
	t.Cleanup(srv.Close)

	return srv, svc, pool
}

// internalID resolves an opaque account id to the uuid the hub keys on.
func internalID(t *testing.T, pool *pgxpool.Pool, publicID string) [16]byte {
	t.Helper()
	account, err := db.AccountByPublicID(t.Context(), pool, publicID)
	if err != nil {
		t.Fatalf("resolve account: %v", err)
	}
	return account.ID
}

func TestWebSocketRequiresFirstFrameAuth(t *testing.T) {
	srv, _, _ := newWSServer(t)

	c := dialWS(t, srv)
	// A non-auth first frame must be refused.
	c.send(clientMessage{Type: "ack", EnvelopeIDs: []string{"x"}})

	if msg := c.read(); msg.Type != "error" {
		t.Fatalf("expected an error, got %+v", msg)
	}
}

func TestWebSocketRejectsValidTokenInANonAuthFrame(t *testing.T) {
	srv, h, _ := newWSServer(t)
	bob := newParty(t, h)

	c := dialWS(t, srv)
	// A real token, but not presented as an auth message. The handshake is a
	// fixed sequence; smuggling credentials into another frame type must not
	// authenticate, or the first-frame contract means nothing.
	c.send(clientMessage{Type: "ack", Token: bob.token, EnvelopeIDs: []string{
		"00000000-0000-0000-0000-000000000000",
	}})

	if msg := c.read(); msg.Type != "error" {
		t.Fatalf("expected an error, got %+v", msg)
	}
}

func TestWebSocketRejectsBadToken(t *testing.T) {
	srv, _, _ := newWSServer(t)

	c := dialWS(t, srv)
	c.send(clientMessage{Type: "auth", Token: "not-a-real-token"})

	msg := c.read()
	if msg.Type != "error" || msg.Error == "" {
		t.Fatalf("expected an auth error, got %+v", msg)
	}
}

func TestWebSocketPushesToConnectedRecipient(t *testing.T) {
	srv, h, _ := newWSServer(t)

	alice := newParty(t, h)
	bob := newParty(t, h)

	bobSocket := connectWS(t, srv, bob.token)

	payload := []byte("pushed ciphertext")
	id, code := sendEnvelope(t, h, alice, bob.accountID, payload)
	if code != http.StatusCreated {
		t.Fatalf("send status = %d, want 201", code)
	}

	msg := bobSocket.read()
	if msg.Type != "envelope" {
		t.Fatalf("expected an envelope push, got %+v", msg)
	}
	if msg.ID != id {
		t.Errorf("pushed id = %q, want %q", msg.ID, id)
	}
	if msg.SenderID != alice.accountID {
		t.Errorf("pushed sender = %q, want %q", msg.SenderID, alice.accountID)
	}

	decoded, err := base64.StdEncoding.DecodeString(msg.Payload)
	if err != nil || string(decoded) != string(payload) {
		t.Errorf("pushed payload = %q (err %v), want %q", decoded, err, payload)
	}
}

func TestPushDoesNotDeleteTheEnvelope(t *testing.T) {
	srv, h, _ := newWSServer(t)

	alice := newParty(t, h)
	bob := newParty(t, h)

	bobSocket := connectWS(t, srv, bob.token)
	id, _ := sendEnvelope(t, h, alice, bob.accountID, []byte("durable"))
	bobSocket.read()

	// A push that reached the socket but never reached the user must still be
	// waiting: only an acknowledgement deletes.
	queued, _ := fetchEnvelopes(t, h, bob)
	if len(queued) != 1 {
		t.Fatalf("after push, %d envelopes queued, want 1", len(queued))
	}

	bobSocket.send(clientMessage{Type: "ack", EnvelopeIDs: []string{id}})
	if msg := bobSocket.read(); msg.Type != "acked" || msg.Acknowledged != 1 {
		t.Fatalf("ack reply = %+v, want acked/1", msg)
	}

	after, _ := fetchEnvelopes(t, h, bob)
	if len(after) != 0 {
		t.Errorf("after ack, %d envelopes queued, want 0", len(after))
	}
}

func TestPushIsScopedToTheRecipient(t *testing.T) {
	srv, h, _ := newWSServer(t)

	alice := newParty(t, h)
	bob := newParty(t, h)
	mallory := newParty(t, h)

	mallorySocket := connectWS(t, srv, mallory.token)
	bobSocket := connectWS(t, srv, bob.token)

	sendEnvelope(t, h, alice, bob.accountID, []byte("for bob"))

	// Bob gets it...
	if msg := bobSocket.read(); msg.Type != "envelope" {
		t.Fatalf("bob expected an envelope, got %+v", msg)
	}
	// ...and Mallory hears nothing.
	mallorySocket.expectNoMessage()
}

func TestPushReachesEveryConnectionOfAnAccount(t *testing.T) {
	srv, h, _ := newWSServer(t)

	alice := newParty(t, h)
	bob := newParty(t, h)

	// Two devices for the same account: the server cannot know which one the
	// user is looking at, so both must receive the push.
	first := connectWS(t, srv, bob.token)
	second := connectWS(t, srv, bob.token)

	sendEnvelope(t, h, alice, bob.accountID, []byte("multi-device"))

	for i, c := range []*wsClient{first, second} {
		if msg := c.read(); msg.Type != "envelope" {
			t.Errorf("connection %d expected an envelope, got %+v", i, msg)
		}
	}
}

func TestSocketAckCannotTouchAnotherAccountsEnvelopes(t *testing.T) {
	srv, h, _ := newWSServer(t)

	alice := newParty(t, h)
	bob := newParty(t, h)
	mallory := newParty(t, h)

	id, _ := sendEnvelope(t, h, alice, bob.accountID, []byte("for bob"))

	mallorySocket := connectWS(t, srv, mallory.token)
	mallorySocket.send(clientMessage{Type: "ack", EnvelopeIDs: []string{id}})

	msg := mallorySocket.read()
	if msg.Type != "acked" {
		t.Fatalf("expected an acked reply, got %+v", msg)
	}
	// Nothing deleted, and the reply reveals nothing about the id's existence.
	if msg.Acknowledged != 0 {
		t.Errorf("mallory acknowledged %d, want 0", msg.Acknowledged)
	}

	queued, _ := fetchEnvelopes(t, h, bob)
	if len(queued) != 1 {
		t.Errorf("bob has %d envelopes, want 1", len(queued))
	}
}

func TestSocketRejectsMalformedAck(t *testing.T) {
	srv, h, _ := newWSServer(t)
	bob := newParty(t, h)

	c := connectWS(t, srv, bob.token)

	c.send(clientMessage{Type: "ack", EnvelopeIDs: []string{"not-a-uuid"}})
	if msg := c.read(); msg.Type != "error" {
		t.Errorf("malformed id: got %+v, want an error", msg)
	}

	c.send(clientMessage{Type: "ack", EnvelopeIDs: nil})
	if msg := c.read(); msg.Type != "error" {
		t.Errorf("empty list: got %+v, want an error", msg)
	}
}

func TestSocketIgnoresUnknownMessageTypes(t *testing.T) {
	srv, h, _ := newWSServer(t)
	bob := newParty(t, h)

	c := connectWS(t, srv, bob.token)

	// Forward compatibility: an unknown type must not close the socket.
	c.send(clientMessage{Type: "something-from-the-future"})
	c.send(clientMessage{Type: "ping"})

	if msg := c.read(); msg.Type != "pong" {
		t.Fatalf("expected pong after an unknown type, got %+v", msg)
	}
}

func TestHubTracksAndReleasesConnections(t *testing.T) {
	srv, h, pool := newWSServer(t)
	bob := newParty(t, h)

	id := internalID(t, pool, bob.accountID)

	c := connectWS(t, srv, bob.token)
	waitFor(t, func() bool { return h.hub.connectionCount(id) == 1 })

	_ = c.conn.Close()

	// The read loop must notice the closed socket and deregister it, or the hub
	// would leak an entry per disconnect.
	waitFor(t, func() bool { return h.hub.connectionCount(id) == 0 })
}

func TestSendSucceedsWhenRecipientIsOffline(t *testing.T) {
	_, h, _ := newWSServer(t)

	alice := newParty(t, h)
	bob := newParty(t, h)

	// Nobody is connected: sending must still succeed, since delivery cannot
	// depend on the recipient's connectivity.
	if _, code := sendEnvelope(t, h, alice, bob.accountID, []byte("offline")); code != http.StatusCreated {
		t.Fatalf("send to offline recipient = %d, want 201", code)
	}

	queued, _ := fetchEnvelopes(t, h, bob)
	if len(queued) != 1 {
		t.Errorf("offline recipient has %d envelopes, want 1", len(queued))
	}
}

func TestCloseAllDisconnectsSockets(t *testing.T) {
	srv, h, _ := newWSServer(t)
	bob := newParty(t, h)

	c := connectWS(t, srv, bob.token)

	h.Close()

	// The socket must actually close rather than linger until process exit.
	_ = c.conn.SetReadDeadline(time.Now().Add(5 * time.Second))
	var msg serverMessage
	err := c.conn.ReadJSON(&msg)
	if err == nil {
		t.Fatalf("expected the socket to close, read %+v", msg)
	}
	// A read *timeout* would also be a non-nil error, but would mean the socket
	// was merely idle rather than closed - which is how this test previously
	// passed while Close raced connection registration.
	if isTimeout(err) {
		t.Fatalf("socket timed out instead of closing: %v", err)
	}
}

func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("condition not met within the deadline")
}
