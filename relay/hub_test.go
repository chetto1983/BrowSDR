package main

import (
	"encoding/binary"
	"io"
	"net"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeRtlTcp is a minimal rtl_tcp: a header, then a byte stream whose value is its offset mod 256.
type fakeRtlTcp struct {
	ln       net.Listener
	mu       sync.Mutex
	commands [][]byte
	conns    []net.Conn
	accepted chan net.Conn
}

func newFakeRtlTcp(t *testing.T) *fakeRtlTcp {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	f := &fakeRtlTcp{ln: ln, accepted: make(chan net.Conn, 4)}
	t.Cleanup(func() { ln.Close(); f.closeAll() })
	go f.serve()
	return f
}

func (f *fakeRtlTcp) serve() {
	for {
		conn, err := f.ln.Accept()
		if err != nil {
			return
		}
		f.mu.Lock()
		f.conns = append(f.conns, conn)
		f.mu.Unlock()
		f.accepted <- conn
		header := []byte{'R', 'T', 'L', '0', 0, 0, 0, 6, 0, 0, 0, 29}
		conn.Write(header)
		go func() {
			offset := 0
			chunk := make([]byte, 999) // odd on purpose: upstream reads need not be pair-aligned
			for {
				for i := range chunk {
					chunk[i] = byte(offset + i)
				}
				if _, err := conn.Write(chunk); err != nil {
					return
				}
				offset += len(chunk)
				time.Sleep(time.Millisecond)
			}
		}()
		go func() {
			cmd := make([]byte, 5)
			for {
				if _, err := io.ReadFull(conn, cmd); err != nil {
					return
				}
				f.mu.Lock()
				f.commands = append(f.commands, append([]byte(nil), cmd...))
				f.mu.Unlock()
			}
		}()
	}
}

func (f *fakeRtlTcp) closeAll() {
	f.mu.Lock()
	defer f.mu.Unlock()
	for _, c := range f.conns {
		c.Close()
	}
}

func (f *fakeRtlTcp) received() [][]byte {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([][]byte(nil), f.commands...)
}

// testLogf logs through t until the test starts cleaning up. Connection goroutines still log
// (client left) after their test returns, and testing forbids t.Logf at that point.
func testLogf(t *testing.T) func(string, ...any) {
	var mu sync.Mutex
	done := false
	t.Cleanup(func() {
		mu.Lock()
		done = true
		mu.Unlock()
	})
	return func(format string, args ...any) {
		mu.Lock()
		defer mu.Unlock()
		if !done {
			t.Logf(format, args...)
		}
	}
}

func startRelay(t *testing.T, upstream string) (*Hub, string) {
	t.Helper()
	hub := NewHub(upstream, testLogf(t))
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	go ServeTCP(ln, hub)
	return hub, ln.Addr().String()
}

func dial(t *testing.T, addr string) net.Conn {
	t.Helper()
	conn, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close() })
	conn.SetDeadline(time.Now().Add(5 * time.Second))
	return conn
}

func command(code byte, value uint32) []byte {
	cmd := []byte{code, 0, 0, 0, 0}
	binary.BigEndian.PutUint32(cmd[1:], value)
	return cmd
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestEveryClientGetsTheHeaderThenPairAlignedIQ(t *testing.T) {
	fake := newFakeRtlTcp(t)
	_, addr := startRelay(t, fake.ln.Addr().String())
	for i := 0; i < 2; i++ {
		conn := dial(t, addr)
		buf := make([]byte, 12+64)
		if _, err := io.ReadFull(conn, buf); err != nil {
			t.Fatal(err)
		}
		if string(buf[:4]) != "RTL0" || binary.BigEndian.Uint32(buf[4:8]) != 6 {
			t.Fatalf("client %d header %v", i, buf[:12])
		}
		// Stream byte value == stream offset (mod 256); an I byte sits at an even offset.
		if first := buf[12]; first%2 != 0 {
			t.Fatalf("client %d starts on stream offset %d (a Q byte)", i, first)
		}
		for j := 13; j < len(buf); j++ {
			if buf[j] != buf[j-1]+1 {
				t.Fatalf("client %d stream not contiguous at %d", i, j)
			}
		}
	}
}

func TestOnlyTheControllerTunesAndControlPassesOnWhenItLeaves(t *testing.T) {
	fake := newFakeRtlTcp(t)
	hub, addr := startRelay(t, fake.ln.Addr().String())
	first := dial(t, addr)
	io.ReadFull(first, make([]byte, 12))
	second := dial(t, addr)
	io.ReadFull(second, make([]byte, 12))

	second.Write(command(0x01, 100_000_000))
	first.Write(command(0x01, 1_090_000_000))
	waitFor(t, "controller command upstream", func() bool { return len(fake.received()) == 1 })
	time.Sleep(50 * time.Millisecond)
	if got := fake.received(); len(got) != 1 || binary.BigEndian.Uint32(got[0][1:]) != 1_090_000_000 {
		t.Fatalf("upstream commands = %v", got)
	}
	if hub.Status().State.FrequencyHz != 1_090_000_000 {
		t.Fatalf("status frequency = %d", hub.Status().State.FrequencyHz)
	}

	first.Close()
	waitFor(t, "control handover", func() bool { return len(hub.Status().Clients) == 1 })
	second.Write(command(0x01, 433_920_000))
	waitFor(t, "new controller command upstream", func() bool { return len(fake.received()) == 2 })
}

func TestTakeControlPreemptsTheCurrentController(t *testing.T) {
	fake := newFakeRtlTcp(t)
	hub, _ := startRelay(t, fake.ln.Addr().String())
	a := hub.Join("tcp", "a", "", false)
	b := hub.Join("ws", "b", "", true)
	defer hub.Leave(a)
	defer hub.Leave(b)
	if hub.Command(a, command(0x01, 1)) {
		t.Fatal("previous controller still forwards after a take")
	}
	if !hub.Command(b, command(0x01, 2)) {
		t.Fatal("taking client cannot tune")
	}
}

func TestUpstreamOpensForTheFirstClientAndClosesAfterTheLast(t *testing.T) {
	fake := newFakeRtlTcp(t)
	_, addr := startRelay(t, fake.ln.Addr().String())
	select {
	case <-fake.accepted:
		t.Fatal("upstream opened with no clients")
	case <-time.After(100 * time.Millisecond):
	}
	conn := dial(t, addr)
	io.ReadFull(conn, make([]byte, 12))
	var up net.Conn
	select {
	case up = <-fake.accepted:
	case <-time.After(2 * time.Second):
		t.Fatal("upstream not opened for the first client")
	}
	conn.Close()
	up.SetReadDeadline(time.Now().Add(3 * time.Second))
	// The relay may close with unread IQ queued, which Linux turns into a reset: any end but a timeout counts.
	if _, err := io.ReadAll(up); err != nil {
		if ne, ok := err.(net.Error); ok && ne.Timeout() {
			t.Fatal("upstream not closed after the last client")
		}
	}
}

func TestClientsAreClosedWhenRtlTcpGoesAway(t *testing.T) {
	fake := newFakeRtlTcp(t)
	_, addr := startRelay(t, fake.ln.Addr().String())
	conn := dial(t, addr)
	io.ReadFull(conn, make([]byte, 12))
	<-fake.accepted
	fake.closeAll()
	if _, err := io.Copy(io.Discard, conn); err != nil {
		t.Fatalf("client not closed cleanly: %v", err)
	}
}

func TestASlowClientDropsChunksInsteadOfBlocking(t *testing.T) {
	c := newClient(1, "tcp", "slow", "", 2)
	c.deliver([]byte{1, 2})
	c.deliver([]byte{3, 4})
	c.deliver([]byte{5, 6})
	if c.drops.Load() != 1 || len(c.out) != 2 {
		t.Fatalf("drops=%d queued=%d", c.drops.Load(), len(c.out))
	}
}

func TestStatusReportsEachClientsToken(t *testing.T) {
	fake := newFakeRtlTcp(t)
	hub, _ := startRelay(t, fake.ln.Addr().String())
	a := hub.Join("ws", "a", "a1", false)
	b := hub.Join("tcp", "b", "", false)
	defer hub.Leave(a)
	defer hub.Leave(b)
	clients := hub.Status().Clients
	if clients[0].Token != "a1" || clients[1].Token != "" {
		t.Fatalf("tokens = %q, %q", clients[0].Token, clients[1].Token)
	}
}

func TestInvalidTokenIsDropped(t *testing.T) {
	fake := newFakeRtlTcp(t)
	hub, _ := startRelay(t, fake.ln.Addr().String())
	for _, token := range []string{"bad token!", strings.Repeat("x", 65)} {
		c := hub.Join("ws", "a", token, false)
		if got := hub.Status().Clients[0].Token; got != "" {
			t.Fatalf("token %q stored as %q", token, got)
		}
		hub.Leave(c)
	}
}
