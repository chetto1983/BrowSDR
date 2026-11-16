package main

import (
	"bufio"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"sync"
)

// ServeTCP speaks plain rtl_tcp to each client, for SDR++, rtl_tcp tools and headless code.
func ServeTCP(ln net.Listener, hub *Hub) error {
	for {
		conn, err := ln.Accept()
		if err != nil {
			return err
		}
		go serveTCPConn(conn, hub)
	}
}

func serveTCPConn(conn net.Conn, hub *Hub) {
	defer conn.Close()
	c := hub.Join("tcp", conn.RemoteAddr().String(), "", false)
	defer hub.Leave(c)
	go pumpTo(c, conn, func(b []byte) error { _, err := conn.Write(b); return err })
	cmd := make([]byte, commandBytes)
	for {
		if _, err := io.ReadFull(conn, cmd); err != nil {
			return
		}
		hub.Command(c, cmd)
	}
}

// pumpTo writes the client's queue until it is closed, then closes the connection to end the reader.
func pumpTo(c *Client, conn net.Conn, write func([]byte) error) {
	defer conn.Close()
	for {
		select {
		case <-c.done:
			return
		case chunk := <-c.out:
			if err := write(chunk); err != nil {
				return
			}
			c.sent.Add(int64(len(chunk)))
		}
	}
}

// ServeWS bridges browsers (BrowSDR's rtl_tcp source); "?control=take" makes the client the controller and
// "?client=<token>" names it in /status.
func ServeWS(hub *Hub) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		conn, reader, err := upgrade(w, r)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		defer conn.Close()
		c := hub.Join("ws", r.RemoteAddr, r.URL.Query().Get("client"), r.URL.Query().Get("control") == "take")
		defer hub.Leave(c)
		var writeMu sync.Mutex
		send := func(opcode byte, payload []byte) error {
			writeMu.Lock()
			defer writeMu.Unlock()
			return writeFrame(conn, opcode, payload)
		}
		go pumpTo(c, conn, func(b []byte) error { return send(opBinary, b) })
		readCommands(hub, c, reader, send)
	}
}

func readCommands(hub *Hub, c *Client, reader *bufio.Reader, send func(byte, []byte) error) {
	var pending []byte
	for {
		opcode, payload, err := readFrame(reader)
		if err != nil {
			return
		}
		switch opcode {
		case opBinary, opContinuation, opText:
			pending = append(pending, payload...)
			for len(pending) >= commandBytes {
				hub.Command(c, pending[:commandBytes])
				pending = pending[commandBytes:]
			}
		case opPing:
			send(opPong, payload)
		case opClose:
			send(opClose, nil)
			return
		}
	}
}

func StatusHandler(hub *Hub) http.HandlerFunc {
	return func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		enc := json.NewEncoder(w)
		enc.SetIndent("", "  ")
		enc.Encode(hub.Status())
	}
}
