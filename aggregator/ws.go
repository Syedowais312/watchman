package main

import (
	"context"
	"log"
	"math"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{
	// Local demo tool: the Vite dev server runs on a different port, so any
	// origin is accepted. Not suitable for anything exposed beyond localhost.
	CheckOrigin: func(*http.Request) bool { return true },
}

type client struct {
	conn *websocket.Conn
	send chan any
}

// Hub fans state out to browsers: a full snapshot on connect, then diffs.
type Hub struct {
	st *State

	mu      sync.Mutex
	clients map[*client]struct{}
	last    map[string]PodView // previous tick, for diffing
}

func NewHub(st *State) *Hub {
	return &Hub{st: st, clients: map[*client]struct{}{}, last: map[string]PodView{}}
}

func (h *Hub) ClientCount() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return len(h.clients)
}

func (h *Hub) ServeWS(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("ws: upgrade failed: %v", err)
		return
	}
	c := &client{conn: conn, send: make(chan any, 32)}

	pods, edges, namespaces := h.st.View()
	snap := Snapshot{
		Type:       "snapshot",
		Namespaces: namespaces,
		Pods:       pods,
		Edges:      edges,
		Overload:   h.st.Config(),
		TS:         time.Now().UnixMilli(),
	}

	h.mu.Lock()
	h.clients[c] = struct{}{}
	n := len(h.clients)
	h.mu.Unlock()
	log.Printf("ws: client connected (%d total)", n)

	c.send <- snap

	go h.writeLoop(c)
	go h.readLoop(c) // drains control frames so closes are noticed
}

func (h *Hub) readLoop(c *client) {
	defer h.drop(c)
	c.conn.SetReadLimit(4096)
	for {
		if _, _, err := c.conn.ReadMessage(); err != nil {
			return
		}
	}
}

func (h *Hub) writeLoop(c *client) {
	defer h.drop(c)
	for msg := range c.send {
		if err := c.conn.SetWriteDeadline(time.Now().Add(5 * time.Second)); err != nil {
			return
		}
		if err := c.conn.WriteJSON(msg); err != nil {
			return
		}
	}
}

func (h *Hub) drop(c *client) {
	h.mu.Lock()
	if _, ok := h.clients[c]; ok {
		delete(h.clients, c)
		close(c.send)
	}
	h.mu.Unlock()
	c.conn.Close()
}

func (h *Hub) broadcast(msg any) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for c := range h.clients {
		select {
		case c.send <- msg:
		default:
			// Slow client: drop this frame rather than stalling the tick. The
			// next diff supersedes it anyway.
		}
	}
}

// changed reports whether a pod's state moved enough to be worth sending.
// Small CPU/rate jitter is ignored so idle pods don't generate constant diffs.
func changed(a, b PodView) bool {
	if a.Overload != b.Overload || a.Ready != b.Ready || a.Phase != b.Phase || a.HasCPU != b.HasCPU {
		return true
	}
	if a.CPUMilli != b.CPUMilli || a.MemBytes != b.MemBytes {
		return true
	}
	if math.Abs(a.RxRate-b.RxRate) > 0.05 || math.Abs(a.TxRate-b.TxRate) > 0.05 {
		return true
	}
	return false
}

// Run pushes a diff to all clients on every tick.
func (h *Hub) Run(ctx context.Context, interval time.Duration) {
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			pods, edges, _ := h.st.View()

			cur := make(map[string]PodView, len(pods))
			for _, p := range pods {
				cur[p.Key] = p
			}

			var added, updated []PodView
			var removed []string

			h.mu.Lock()
			prev := h.last
			for k, p := range cur {
				old, existed := prev[k]
				switch {
				case !existed:
					added = append(added, p)
				case changed(old, p):
					updated = append(updated, p)
				}
			}
			for k := range prev {
				if _, ok := cur[k]; !ok {
					removed = append(removed, k)
				}
			}
			h.last = cur
			h.mu.Unlock()

			// Edges are sent in full each tick (only those with live traffic).
			// They drive the moving dots, so the client needs the current set,
			// not just what changed.
			live := edges[:0:0]
			for _, e := range edges {
				if e.Rate > 0 {
					live = append(live, e)
				}
			}

			if len(added) == 0 && len(updated) == 0 && len(removed) == 0 && len(live) == 0 {
				continue
			}
			h.broadcast(Diff{
				Type:    "diff",
				Added:   added,
				Removed: removed,
				Updated: updated,
				Edges:   live,
				TS:      time.Now().UnixMilli(),
			})
		}
	}
}
