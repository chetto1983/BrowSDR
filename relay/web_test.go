package main

import (
	"bufio"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// newAppServer serves a tiny stand-in for BrowSDR's build next to a relay sharing a fake rtl_tcp.
func newAppServer(t *testing.T) *httptest.Server {
	t.Helper()
	static := t.TempDir()
	if err := os.WriteFile(filepath.Join(static, "index.html"), []byte("<title>BrowSDR</title>"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(static, "wasm"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(static, "wasm", "dsp.wasm"), []byte{0, 'a', 's', 'm'}, 0o644); err != nil {
		t.Fatal(err)
	}
	upstream := newFakeRtlTcp(t)
	srv := httptest.NewServer(App(NewHub(upstream.ln.Addr().String(), testLogf(t)), static))
	t.Cleanup(srv.Close)
	return srv
}

func get(t *testing.T, client *http.Client, url string) (*http.Response, string) {
	t.Helper()
	res, err := client.Get(url)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	body, err := io.ReadAll(res.Body)
	if err != nil {
		t.Fatal(err)
	}
	return res, string(body)
}

func TestAppServesTheBrowserAppForPlainRequests(t *testing.T) {
	srv := newAppServer(t)
	res, body := get(t, srv.Client(), srv.URL+"/")
	if res.StatusCode != http.StatusOK || !strings.Contains(body, "BrowSDR") {
		t.Fatalf("GET / = %d %q", res.StatusCode, body)
	}
	if got := res.Header.Get("Cache-Control"); got != "no-cache" {
		t.Fatalf("index Cache-Control = %q; a stale page would outlive an upgrade", got)
	}
	res, _ = get(t, srv.Client(), srv.URL+"/wasm/dsp.wasm")
	if res.StatusCode != http.StatusOK || res.Header.Get("Content-Type") != "application/wasm" {
		t.Fatalf("GET wasm = %d %q", res.StatusCode, res.Header.Get("Content-Type"))
	}
}

func TestAppKeepsStatus(t *testing.T) {
	srv := newAppServer(t)
	res, body := get(t, srv.Client(), srv.URL+"/status")
	var status Status
	if res.StatusCode != http.StatusOK || json.Unmarshal([]byte(body), &status) != nil {
		t.Fatalf("GET /status = %d %q", res.StatusCode, body)
	}
}

func TestAppUpgradesWebSocketsOnTheRoot(t *testing.T) {
	srv := newAppServer(t)
	conn, err := net.Dial("tcp", strings.TrimPrefix(srv.URL, "http://"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	conn.SetDeadline(time.Now().Add(5 * time.Second))
	io.WriteString(conn, "GET / HTTP/1.1\r\nHost: radiopi\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"+
		"Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n")
	reader := bufio.NewReader(conn)
	line, err := reader.ReadString('\n')
	if err != nil || !strings.HasPrefix(line, "HTTP/1.1 101") {
		t.Fatalf("handshake answer %q %v", line, err)
	}
	for {
		header, err := reader.ReadString('\n')
		if err != nil {
			t.Fatal(err)
		}
		if header == "\r\n" {
			break
		}
	}
	_, payload, err := readFrame(reader)
	if err != nil || !strings.HasPrefix(string(payload), "RTL0") {
		t.Fatalf("first frame %q %v, want the rtl_tcp header", payload, err)
	}
}

func TestCertificateIsCreatedOnceAndReused(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "certs")
	first, err := LoadOrCreateCert(dir, []string{"192.168.1.83", "radiopi.local"})
	if err != nil {
		t.Fatal(err)
	}
	leaf, err := x509.ParseCertificate(first.Certificate[0])
	if err != nil {
		t.Fatal(err)
	}
	if len(leaf.IPAddresses) != 1 || leaf.IPAddresses[0].String() != "192.168.1.83" || len(leaf.DNSNames) != 1 || leaf.DNSNames[0] != "radiopi.local" {
		t.Fatalf("SANs = %v %v", leaf.IPAddresses, leaf.DNSNames)
	}
	if info, err := os.Stat(filepath.Join(dir, "key.pem")); err != nil || info.Mode().Perm()&0o077 != 0 {
		t.Fatalf("key.pem must be private: %v %v", info, err)
	}
	again, err := LoadOrCreateCert(dir, []string{"10.0.0.9"})
	if err != nil {
		t.Fatal(err)
	}
	if again2, _ := x509.ParseCertificate(again.Certificate[0]); again2.SerialNumber.Cmp(leaf.SerialNumber) != 0 {
		t.Fatal("a second start made a new certificate; every phone would have to accept it again")
	}
}

func TestAppWorksOverTLS(t *testing.T) {
	cert, err := LoadOrCreateCert(t.TempDir(), []string{"127.0.0.1"})
	if err != nil {
		t.Fatal(err)
	}
	static := t.TempDir()
	os.WriteFile(filepath.Join(static, "index.html"), []byte("<title>BrowSDR</title>"), 0o644)
	srv := httptest.NewUnstartedServer(App(NewHub(newFakeRtlTcp(t).ln.Addr().String(), testLogf(t)), static))
	srv.TLS = &tls.Config{Certificates: []tls.Certificate{cert}}
	srv.StartTLS()
	t.Cleanup(srv.Close)
	pool := x509.NewCertPool()
	leaf, _ := x509.ParseCertificate(cert.Certificate[0])
	pool.AddCert(leaf)
	client := &http.Client{Transport: &http.Transport{TLSClientConfig: &tls.Config{RootCAs: pool}}}
	res, body := get(t, client, srv.URL+"/")
	if res.StatusCode != http.StatusOK || !strings.Contains(body, "BrowSDR") {
		t.Fatalf("GET / over TLS = %d %q", res.StatusCode, body)
	}
}

func TestWebSocketClientTokenFromQuery(t *testing.T) {
	upstream := newFakeRtlTcp(t)
	hub := NewHub(upstream.ln.Addr().String(), testLogf(t))
	srv := httptest.NewServer(ServeWS(hub))
	t.Cleanup(srv.Close)
	conn, err := net.Dial("tcp", strings.TrimPrefix(srv.URL, "http://"))
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	conn.SetDeadline(time.Now().Add(5 * time.Second))
	io.WriteString(conn, "GET /?client=abc&control=take HTTP/1.1\r\nHost: radiopi\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"+
		"Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n")
	line, err := bufio.NewReader(conn).ReadString('\n')
	if err != nil || !strings.HasPrefix(line, "HTTP/1.1 101") {
		t.Fatalf("handshake answer %q %v", line, err)
	}
	waitFor(t, "client registered", func() bool { return len(hub.Status().Clients) == 1 })
	if c := hub.Status().Clients[0]; c.Token != "abc" || !c.Controller {
		t.Fatalf("status client = %+v", c)
	}
}
