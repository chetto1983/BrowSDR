// Command rtl-relay shares one rtl_tcp server between several clients: the first (or the one that
// takes control) tunes, the others hear the same band. It serves plain rtl_tcp and WebSocket.
package main

import (
	"flag"
	"log"
	"net"
	"net/http"
)

func main() {
	upstream := flag.String("upstream", "127.0.0.1:1234", "rtl_tcp server to share")
	tcpAddr := flag.String("tcp", "", "listen address for plain rtl_tcp clients (empty: off)")
	httpAddr := flag.String("http", "127.0.0.1:8765", "listen address for WebSocket clients and /status")
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
	mux := http.NewServeMux()
	mux.Handle("/status", StatusHandler(hub))
	mux.Handle("/", ServeWS(hub))
	log.Printf("WebSocket clients and /status on %s, sharing %s", *httpAddr, *upstream)
	log.Fatal(http.ListenAndServe(*httpAddr, mux))
}
