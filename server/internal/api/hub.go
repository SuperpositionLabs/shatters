package api

import (
	"sync"
)

// hubSendBuffer bounds how many pushes may queue for one connection.
//
// A slow or wedged consumer must not be able to grow the server's memory or
// block the sender. When the buffer fills the connection is dropped: the
// envelope stays in the database until acknowledged, so the client simply
// receives it on reconnect. Losing a socket is cheap; losing a message is not.
const hubSendBuffer = 32

// hub tracks live WebSocket connections per account.
//
// One account may hold several connections at once (multiple devices or tabs),
// and every one receives each push, since the server cannot know which device
// the user is looking at.
type hub struct {
	mu          sync.RWMutex
	connections map[[16]byte]map[*wsConn]struct{}
}

func newHub() *hub {
	return &hub{connections: make(map[[16]byte]map[*wsConn]struct{})}
}

// add registers a connection for an account.
func (h *hub) add(accountID [16]byte, c *wsConn) {
	h.mu.Lock()
	defer h.mu.Unlock()

	set, ok := h.connections[accountID]
	if !ok {
		set = make(map[*wsConn]struct{})
		h.connections[accountID] = set
	}
	set[c] = struct{}{}
}

// remove deregisters a connection, dropping the account entry when its last
// connection goes so the map does not grow without bound.
func (h *hub) remove(accountID [16]byte, c *wsConn) {
	h.mu.Lock()
	defer h.mu.Unlock()

	set, ok := h.connections[accountID]
	if !ok {
		return
	}
	delete(set, c)
	if len(set) == 0 {
		delete(h.connections, accountID)
	}
}

// push delivers a payload to every live connection of an account and reports
// how many accepted it.
//
// Delivery is best effort by design: the envelope is already durable, and a
// push that never lands is redelivered when the client next fetches. Treating
// a failed push as an error would make sending depend on the recipient's
// connectivity.
func (h *hub) push(accountID [16]byte, payload []byte) int {
	h.mu.RLock()
	targets := make([]*wsConn, 0, len(h.connections[accountID]))
	for c := range h.connections[accountID] {
		targets = append(targets, c)
	}
	h.mu.RUnlock()

	// Sending happens outside the lock: a blocked send must never stall
	// registration or another account's push.
	delivered := 0
	for _, c := range targets {
		if c.trySend(payload) {
			delivered++
		}
	}
	return delivered
}

// connectionCount reports live connections for an account (tests and metrics).
func (h *hub) connectionCount(accountID [16]byte) int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.connections[accountID])
}

// closeAll shuts every connection down, used on graceful shutdown.
func (h *hub) closeAll() {
	h.mu.Lock()
	targets := make([]*wsConn, 0)
	for _, set := range h.connections {
		for c := range set {
			targets = append(targets, c)
		}
	}
	h.connections = make(map[[16]byte]map[*wsConn]struct{})
	h.mu.Unlock()

	for _, c := range targets {
		c.close()
	}
}
