package api

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"

	"github.com/SuperpositionLabs/shatters/server/internal/db"
)

const (
	// authDeadline is how long an unauthenticated socket may stay open. A
	// connection that never proves who it is costs a file descriptor, so the
	// window is short.
	authDeadline = 10 * time.Second

	// pongWait is how long a connection may go without answering a ping.
	pongWait = 60 * time.Second

	// pingInterval must be shorter than pongWait so a slow reply is not
	// mistaken for a dead peer.
	pingInterval = 25 * time.Second

	// writeWait bounds a single frame write.
	writeWait = 10 * time.Second

	// maxClientFrame caps an inbound frame. Clients only ever send small
	// control messages, so this is generous.
	maxClientFrame = 64 * 1024
)

// upgrader rejects cross-origin handshakes by default.
//
// The browser same-origin policy does not apply to WebSockets, so without an
// origin check any site could open an authenticated socket in a visitor's
// browser. Only same-origin and non-browser (originless) clients are allowed.
var upgrader = websocket.Upgrader{
	HandshakeTimeout: 10 * time.Second,
	ReadBufferSize:   1024,
	WriteBufferSize:  1024,
	CheckOrigin: func(r *http.Request) bool {
		origin := r.Header.Get("Origin")
		if origin == "" {
			return true // native clients send no Origin
		}
		return originMatchesHost(origin, r.Host)
	},
}

// originMatchesHost reports whether an Origin header refers to the same host
// the request was addressed to.
func originMatchesHost(origin, host string) bool {
	for _, prefix := range []string{"http://", "https://"} {
		if len(origin) > len(prefix) && origin[:len(prefix)] == prefix {
			return origin[len(prefix):] == host
		}
	}
	return false
}

// clientMessage is the small control vocabulary a client may send.
type clientMessage struct {
	Type string `json:"type"`
	// Token is present only on the initial auth message.
	Token string `json:"token,omitempty"`
	// EnvelopeIDs is present on ack messages.
	EnvelopeIDs []string `json:"envelope_ids,omitempty"`
}

// serverMessage is what the server emits.
type serverMessage struct {
	Type string `json:"type"`
	// Envelope fields, set on push.
	ID        string `json:"id,omitempty"`
	SenderID  string `json:"sender_id,omitempty"`
	Payload   string `json:"payload,omitempty"`
	CreatedAt string `json:"created_at,omitempty"`
	// Acknowledged is set on ack replies.
	Acknowledged int64 `json:"acknowledged,omitempty"`
	// Error carries a human-readable reason before a close.
	Error string `json:"error,omitempty"`
}

// wsConn is one authenticated socket with a serialized writer.
//
// Every write goes through the send channel, because a WebSocket connection
// permits only one concurrent writer and pushes arrive from arbitrary request
// goroutines.
type wsConn struct {
	conn      *websocket.Conn
	send      chan []byte
	closeOnce sync.Once
	done      chan struct{}
}

func newWSConn(conn *websocket.Conn) *wsConn {
	return &wsConn{
		conn: conn,
		send: make(chan []byte, hubSendBuffer),
		done: make(chan struct{}),
	}
}

// trySend queues a payload, reporting false when the buffer is full or the
// connection is closing. A full buffer means a wedged consumer: the caller
// drops the connection rather than blocking.
func (c *wsConn) trySend(payload []byte) bool {
	select {
	case <-c.done:
		return false
	default:
	}

	select {
	case c.send <- payload:
		return true
	default:
		// Buffer full: give up on the socket, not on the message. The envelope
		// is durable and will be redelivered on reconnect.
		c.close()
		return false
	}
}

func (c *wsConn) close() {
	c.closeOnce.Do(func() {
		close(c.done)
		_ = c.conn.Close()
	})
}

// handleWebSocket implements GET /v1/ws.
//
// The route is deliberately outside the bearer middleware: browsers cannot set
// an Authorization header on a WebSocket handshake, and putting the token in
// the query string would leak it into proxy logs, browser history and Referer
// headers. Instead the socket authenticates with its first frame, so the token
// only ever appears in a message body.
func (s *Server) handleWebSocket(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		// Upgrade already wrote a response.
		return
	}

	conn.SetReadLimit(maxClientFrame)

	account, ok := s.authenticateSocket(r.Context(), conn)
	if !ok {
		_ = conn.Close()
		return
	}

	c := newWSConn(conn)

	// Register before announcing readiness. A client that has seen "ready" may
	// legitimately expect pushes, so if registration came second an envelope
	// sent in that window would be dropped from the socket - recoverable via
	// the queue, but a needless gap the client cannot observe or compensate for.
	s.hub.add(account.ID, c)
	defer func() {
		s.hub.remove(account.ID, c)
		c.close()
	}()

	go c.writeLoop()
	c.trySend(mustJSON(serverMessage{Type: "ready"}))

	s.readLoop(r.Context(), c, account)
}

// authenticateSocket waits for the first frame and validates the bearer token
// it carries. Anything else closes the socket.
func (s *Server) authenticateSocket(ctx context.Context, conn *websocket.Conn) (db.AccountLookup, bool) {
	if err := conn.SetReadDeadline(time.Now().Add(authDeadline)); err != nil {
		return db.AccountLookup{}, false
	}

	var msg clientMessage
	if err := conn.ReadJSON(&msg); err != nil {
		return db.AccountLookup{}, false
	}
	if msg.Type != "auth" || msg.Token == "" {
		writeCloseReason(conn, "expected an auth message")
		return db.AccountLookup{}, false
	}

	sum := sha256.Sum256([]byte(msg.Token))
	account, err := db.AccountIDByTokenHash(ctx, s.pool, sum[:])
	if err != nil {
		writeCloseReason(conn, "invalid or expired token")
		return db.AccountLookup{}, false
	}

	// Authenticated: switch to the keepalive deadline.
	if err := conn.SetReadDeadline(time.Now().Add(pongWait)); err != nil {
		return db.AccountLookup{}, false
	}
	conn.SetPongHandler(func(string) error {
		return conn.SetReadDeadline(time.Now().Add(pongWait))
	})

	// "ready" is sent by the caller, after the connection joins the hub.
	return account, true
}

func writeCloseReason(conn *websocket.Conn, reason string) {
	_ = conn.SetWriteDeadline(time.Now().Add(writeWait))
	_ = conn.WriteJSON(serverMessage{Type: "error", Error: reason})
}

// writeLoop is the sole writer for a connection, draining the send channel and
// emitting keepalive pings.
func (c *wsConn) writeLoop() {
	ticker := time.NewTicker(pingInterval)
	defer func() {
		ticker.Stop()
		c.close()
	}()

	for {
		select {
		case <-c.done:
			return

		case payload := <-c.send:
			_ = c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := c.conn.WriteMessage(websocket.TextMessage, payload); err != nil {
				return
			}

		case <-ticker.C:
			_ = c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

// readLoop handles the client's control messages until the socket closes.
func (s *Server) readLoop(ctx context.Context, c *wsConn, account db.AccountLookup) {
	for {
		var msg clientMessage
		if err := c.conn.ReadJSON(&msg); err != nil {
			return
		}

		switch msg.Type {
		case "ack":
			s.handleSocketAck(ctx, c, account, msg)
		case "ping":
			c.trySend(mustJSON(serverMessage{Type: "pong"}))
		default:
			// Unknown types are ignored rather than fatal, so adding message
			// types later does not break older servers.
			continue
		}
	}
}

// handleSocketAck deletes the named envelopes, scoped to this account.
func (s *Server) handleSocketAck(ctx context.Context, c *wsConn, account db.AccountLookup, msg clientMessage) {
	if len(msg.EnvelopeIDs) == 0 || len(msg.EnvelopeIDs) > maxAckIDs {
		c.trySend(mustJSON(serverMessage{Type: "error", Error: "envelope_ids: invalid count"}))
		return
	}

	ids := make([][16]byte, 0, len(msg.EnvelopeIDs))
	for _, raw := range msg.EnvelopeIDs {
		parsed, err := parseUUID(raw)
		if err != nil {
			c.trySend(mustJSON(serverMessage{Type: "error", Error: "envelope_ids: malformed id"}))
			return
		}
		ids = append(ids, parsed)
	}

	// Same recipient-scoped delete as the REST path: ids belonging to another
	// account match nothing.
	deleted, err := db.AcknowledgeEnvelopes(ctx, s.pool, account.ID, ids)
	if err != nil {
		c.trySend(mustJSON(serverMessage{Type: "error", Error: "internal error"}))
		return
	}

	c.trySend(mustJSON(serverMessage{Type: "acked", Acknowledged: deleted}))
}

// pushEnvelope notifies a recipient's live connections about a stored envelope.
//
// Best effort on purpose: the row is already durable, so a push that does not
// land is picked up by the next fetch. Sending must not depend on whether the
// recipient happens to be online.
func (s *Server) pushEnvelope(recipientID [16]byte, e db.Envelope) {
	if s.hub == nil {
		return
	}

	payload, err := json.Marshal(serverMessage{
		Type:      "envelope",
		ID:        formatUUID(e.ID),
		SenderID:  e.SenderPublicID,
		Payload:   base64.StdEncoding.EncodeToString(e.Payload),
		CreatedAt: e.CreatedAt.UTC().Format(time.RFC3339),
	})
	if err != nil {
		slog.Error("websocket: marshal push", "err", err)
		return
	}

	s.hub.push(recipientID, payload)
}

func mustJSON(v serverMessage) []byte {
	raw, err := json.Marshal(v)
	if err != nil {
		// serverMessage is a flat struct of strings and ints; marshalling it
		// cannot fail. Returning empty rather than panicking keeps a bug here
		// from taking down a connection.
		slog.Error("websocket: marshal server message", "err", err)
		return []byte(`{"type":"error"}`)
	}
	return raw
}
