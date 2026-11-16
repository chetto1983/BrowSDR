package main

import (
	"encoding/binary"
	"io"
	"net"
	"sync"
	"sync/atomic"
	"time"
)

const (
	rtlTcpHeaderBytes = 12
	commandBytes      = 5
	upstreamReadBytes = 32 * 1024
	// About 0.4 s of 2.4 MS/s IQ per client before a slow client starts losing chunks.
	clientQueueDepth = 64
)

// State mirrors the settings the controller has sent; zero means "never set through the relay".
type State struct {
	FrequencyHz    uint32 `json:"frequency_hz"`
	SampleRate     uint32 `json:"sample_rate"`
	GainMode       uint32 `json:"gain_mode"`
	GainTenthsDb   uint32 `json:"gain_tenths_db,omitempty"`
	GainIndex      uint32 `json:"gain_index"`
	BiasTee        uint32 `json:"bias_tee"`
	PpmCorrection  int32  `json:"ppm"`
	AGC            uint32 `json:"agc"`
	DirectSampling uint32 `json:"direct_sampling"`
}

func (s *State) apply(cmd []byte) {
	value := binary.BigEndian.Uint32(cmd[1:])
	switch cmd[0] {
	case 0x01:
		s.FrequencyHz = value
	case 0x02:
		s.SampleRate = value
	case 0x03:
		s.GainMode = value
	case 0x04:
		s.GainTenthsDb = value
	case 0x05:
		s.PpmCorrection = int32(value)
	case 0x08:
		s.AGC = value
	case 0x09:
		s.DirectSampling = value
	case 0x0d:
		s.GainIndex = value
	case 0x0e:
		s.BiasTee = value
	}
}

type Client struct {
	ID     int
	Kind   string
	Remote string
	Token  string // chosen by the client so it can find itself in /status
	Since  time.Time

	out        chan []byte
	done       chan struct{}
	closeOnce  sync.Once
	headerSent bool // guarded by Hub.mu

	sent    atomic.Int64
	drops   atomic.Int64
	ignored atomic.Int64
}

func newClient(id int, kind, remote, token string, depth int) *Client {
	return &Client{ID: id, Kind: kind, Remote: remote, Token: validToken(token), Since: time.Now(), out: make(chan []byte, depth), done: make(chan struct{})}
}

// deliver never blocks: a client that cannot keep up loses whole chunks, which keeps I/Q pairs intact.
func (c *Client) deliver(chunk []byte) {
	select {
	case c.out <- chunk:
	default:
		c.drops.Add(1)
	}
}

func (c *Client) close() { c.closeOnce.Do(func() { close(c.done) }) }

type ClientStatus struct {
	ID              int       `json:"id"`
	Kind            string    `json:"kind"`
	Remote          string    `json:"remote"`
	Token           string    `json:"client,omitempty"`
	Controller      bool      `json:"controller"`
	Since           time.Time `json:"since"`
	SentBytes       int64     `json:"sent_bytes"`
	DroppedChunks   int64     `json:"dropped_chunks"`
	IgnoredCommands int64     `json:"ignored_commands"`
}

type Status struct {
	Upstream  string         `json:"upstream"`
	Connected bool           `json:"connected"`
	State     State          `json:"state"`
	Clients   []ClientStatus `json:"clients"`
}

// Hub shares one rtl_tcp connection: every client hears the same band, only the controller tunes it.
type Hub struct {
	upstreamAddr string
	logf         func(string, ...any)

	mu         sync.Mutex
	clients    []*Client
	controller *Client
	nextID     int
	up         net.Conn
	connecting bool
	header     []byte
	pending    [][]byte
	state      State
}

func NewHub(upstreamAddr string, logf func(string, ...any)) *Hub {
	return &Hub{upstreamAddr: upstreamAddr, logf: logf}
}

// Join registers a client; the first one (or one that takes control) becomes the controller.
func (h *Hub) Join(kind, remote, token string, takeControl bool) *Client {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.nextID++
	c := newClient(h.nextID, kind, remote, token, clientQueueDepth)
	h.clients = append(h.clients, c)
	if h.controller == nil || takeControl {
		h.controller = c
	}
	if h.header != nil {
		c.deliver(h.header)
		c.headerSent = true
	}
	h.logf("client %d joined (%s %s, controller=%v)", c.ID, kind, remote, h.controller == c)
	if h.up == nil && !h.connecting {
		h.connecting = true
		go h.runUpstream()
	}
	return c
}

func (h *Hub) Leave(c *Client) {
	h.mu.Lock()
	defer h.mu.Unlock()
	index := -1
	for i, existing := range h.clients {
		if existing == c {
			index = i
		}
	}
	if index < 0 {
		return
	}
	h.clients = append(h.clients[:index], h.clients[index+1:]...)
	c.close()
	if h.controller == c {
		h.controller = nil
		if len(h.clients) > 0 {
			h.controller = h.clients[0]
		}
	}
	h.logf("client %d left", c.ID)
	if len(h.clients) == 0 && h.up != nil {
		h.closeUpstreamLocked()
	}
}

// Command forwards a controller's 5-byte command; other clients' commands are counted and dropped.
func (h *Hub) Command(c *Client, cmd []byte) bool {
	if len(cmd) != commandBytes {
		return false
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if c != h.controller {
		c.ignored.Add(1)
		return false
	}
	h.state.apply(cmd)
	command := append([]byte(nil), cmd...)
	if h.up == nil {
		h.pending = append(h.pending, command)
		return true
	}
	if _, err := h.up.Write(command); err != nil {
		h.logf("upstream write: %v", err)
	}
	return true
}

func (h *Hub) Status() Status {
	h.mu.Lock()
	defer h.mu.Unlock()
	status := Status{Upstream: h.upstreamAddr, Connected: h.up != nil, State: h.state, Clients: []ClientStatus{}}
	for _, c := range h.clients {
		status.Clients = append(status.Clients, ClientStatus{
			ID: c.ID, Kind: c.Kind, Remote: c.Remote, Token: c.Token, Controller: c == h.controller, Since: c.Since,
			SentBytes: c.sent.Load(), DroppedChunks: c.drops.Load(), IgnoredCommands: c.ignored.Load(),
		})
	}
	return status
}

func (h *Hub) runUpstream() {
	conn, err := net.DialTimeout("tcp", h.upstreamAddr, 5*time.Second)
	header := make([]byte, rtlTcpHeaderBytes)
	if err == nil {
		conn.SetReadDeadline(time.Now().Add(5 * time.Second))
		_, err = io.ReadFull(conn, header)
		conn.SetReadDeadline(time.Time{})
	}
	h.mu.Lock()
	h.connecting = false
	if err != nil {
		h.logf("upstream %s: %v", h.upstreamAddr, err)
		if conn != nil {
			conn.Close()
		}
		h.kickAllLocked()
		h.mu.Unlock()
		return
	}
	if len(h.clients) == 0 {
		conn.Close()
		h.mu.Unlock()
		return
	}
	h.up, h.header = conn, header
	for _, c := range h.clients {
		if !c.headerSent {
			c.deliver(header)
			c.headerSent = true
		}
	}
	for _, cmd := range h.pending {
		conn.Write(cmd)
	}
	h.pending = nil
	h.logf("upstream %s connected", h.upstreamAddr)
	h.mu.Unlock()
	h.pump(conn)
}

// pump fans the IQ stream out in even-length chunks, so every chunk (and every late joiner) starts on an I byte.
func (h *Hub) pump(conn net.Conn) {
	buf := make([]byte, upstreamReadBytes)
	var carry []byte
	for {
		n, err := conn.Read(buf)
		if n > 0 {
			chunk := make([]byte, 0, len(carry)+n)
			chunk = append(append(chunk, carry...), buf[:n]...)
			carry = nil
			if len(chunk)%2 == 1 {
				carry = []byte{chunk[len(chunk)-1]}
				chunk = chunk[:len(chunk)-1]
			}
			if len(chunk) > 0 {
				h.broadcast(chunk)
			}
		}
		if err != nil {
			h.mu.Lock()
			if h.up == conn { // a deliberate close already cleared h.up
				h.logf("upstream lost: %v", err)
				h.closeUpstreamLocked()
				h.kickAllLocked()
			}
			h.mu.Unlock()
			return
		}
	}
}

func (h *Hub) broadcast(chunk []byte) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, c := range h.clients {
		if c.headerSent {
			c.deliver(chunk)
		}
	}
}

func (h *Hub) closeUpstreamLocked() {
	h.up.Close()
	h.up, h.header = nil, nil
}

func (h *Hub) kickAllLocked() {
	for _, c := range h.clients {
		c.close()
	}
}

// validToken keeps a client token only if it is 1-64 characters of [A-Za-z0-9_-]; anything else is dropped.
func validToken(token string) string {
	if len(token) > 64 {
		return ""
	}
	for _, r := range token {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '_' || r == '-') {
			return ""
		}
	}
	return token
}
