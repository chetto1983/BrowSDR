// Command rtl-relay shares one rtl_tcp server between several clients: the first (or the one that
// takes control) tunes, the others hear the same band. It serves plain rtl_tcp and WebSocket, and
// with -https also BrowSDR itself, so a phone can open the receiver straight from the Pi.
package main

import (
	"crypto/tls"
	"flag"
	"log"
	"net"
	"net/http"
)

func main() {
	upstream := flag.String("upstream", "127.0.0.1:1234", "rtl_tcp server to share")
	tcpAddr := flag.String("tcp", "", "listen address for plain rtl_tcp clients (empty: off)")
	httpAddr := flag.String("http", "127.0.0.1:8765", "listen address for WebSocket clients and /status")
	httpsAddr := flag.String("https", "", "listen address for BrowSDR, the radio and /status over HTTPS (empty: off)")
	staticDir := flag.String("static", "", "BrowSDR build (npm run build) served by -https")
	certDir := flag.String("certdir", "/var/lib/rtl-relay", "where -https keeps its self-signed certificate")
	flag.Parse()

	hub := NewHub(*upstream, log.Printf)
	if *tcpAddr != "" {
		ln, err := net.Listen("tcp", *tcpAddr)
		if err != nil {
			log.Fatal(err)
		}
		log.Printf("rtl_tcp clients on %s", *tcpAddr)
		go func() { log.Fatal(ServeTCP(ln, hub)) }()
	}
	if *httpsAddr != "" {
		if *staticDir == "" {
			log.Fatal("-https needs -static: the BrowSDR build to serve")
		}
		cert, err := LoadOrCreateCert(*certDir, localHosts())
		if err != nil {
			log.Fatal(err)
		}
		srv := &http.Server{
			Addr:      *httpsAddr,
			Handler:   App(hub, *staticDir),
			TLSConfig: &tls.Config{Certificates: []tls.Certificate{cert}},
		}
		log.Printf("BrowSDR, radio and /status over HTTPS on %s (static %s)", *httpsAddr, *staticDir)
		go func() { log.Fatal(srv.ListenAndServeTLS("", "")) }()
	}
	mux := http.NewServeMux()
	mux.Handle("/status", StatusHandler(hub))
	mux.Handle("/", ServeWS(hub))
	log.Printf("WebSocket clients and /status on %s, sharing %s", *httpAddr, *upstream)
	log.Fatal(http.ListenAndServe(*httpAddr, mux))
}
