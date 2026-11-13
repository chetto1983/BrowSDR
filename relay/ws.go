package main

import (
	"bufio"
	"crypto/sha1"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
)

// Minimal RFC 6455 server side: enough for binary IQ out and 5-byte rtl_tcp commands in.
const (
	opContinuation = 0x0
	opText         = 0x1
	opBinary       = 0x2
	opClose        = 0x8
	opPing         = 0x9
	opPong         = 0xa

	wsGUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
	// Clients only send commands; anything this large is not an rtl_tcp client.
	maxClientFrame = 1 << 20
)

func acceptKey(key string) string {
	sum := sha1.Sum([]byte(key + wsGUID))
	return base64.StdEncoding.EncodeToString(sum[:])
}

func readFrame(r *bufio.Reader) (byte, []byte, error) {
	var head [2]byte
	if _, err := io.ReadFull(r, head[:]); err != nil {
		return 0, nil, err
	}
	opcode := head[0] & 0x0f
	masked := head[1]&0x80 != 0
	size := uint64(head[1] & 0x7f)
	switch size {
	case 126:
		var ext [2]byte
		if _, err := io.ReadFull(r, ext[:]); err != nil {
			return 0, nil, err
		}
		size = uint64(binary.BigEndian.Uint16(ext[:]))
	case 127:
		var ext [8]byte
		if _, err := io.ReadFull(r, ext[:]); err != nil {
			return 0, nil, err
		}
		size = binary.BigEndian.Uint64(ext[:])
	}
	if size > maxClientFrame {
		return 0, nil, fmt.Errorf("websocket frame of %d bytes is too large", size)
	}
	var mask [4]byte
	if masked {
		if _, err := io.ReadFull(r, mask[:]); err != nil {
			return 0, nil, err
		}
	}
	payload := make([]byte, size)
	if _, err := io.ReadFull(r, payload); err != nil {
		return 0, nil, err
	}
	if masked {
		for i := range payload {
			payload[i] ^= mask[i%4]
		}
	}
	return opcode, payload, nil
}

// writeFrame sends one unmasked, unfragmented server frame.
func writeFrame(w io.Writer, opcode byte, payload []byte) error {
	header := make([]byte, 2, 10)
	header[0] = 0x80 | opcode
	switch n := len(payload); {
	case n < 126:
		header[1] = byte(n)
	case n <= 0xffff:
		header[1] = 126
		header = binary.BigEndian.AppendUint16(header, uint16(n))
	default:
		header[1] = 127
		header = binary.BigEndian.AppendUint64(header, uint64(n))
	}
	buffers := net.Buffers{header, payload}
	_, err := buffers.WriteTo(w)
	return err
}

func headerHasToken(h http.Header, name, token string) bool {
	for _, value := range h.Values(name) {
		for _, part := range strings.Split(value, ",") {
			if strings.EqualFold(strings.TrimSpace(part), token) {
				return true
			}
		}
	}
	return false
}

// upgrade completes the handshake and hands back the raw connection with its buffered reader.
func upgrade(w http.ResponseWriter, r *http.Request) (net.Conn, *bufio.Reader, error) {
	key := r.Header.Get("Sec-WebSocket-Key")
	if !headerHasToken(r.Header, "Upgrade", "websocket") || key == "" {
		return nil, nil, errors.New("not a WebSocket upgrade request")
	}
	hijacker, ok := w.(http.Hijacker)
	if !ok {
		return nil, nil, errors.New("connection cannot be hijacked")
	}
	conn, rw, err := hijacker.Hijack()
	if err != nil {
		return nil, nil, err
	}
	response := "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
		"Sec-WebSocket-Accept: " + acceptKey(key) + "\r\n"
	// websockify clients may ask for the "binary" subprotocol; it is what this server speaks anyway.
	if headerHasToken(r.Header, "Sec-WebSocket-Protocol", "binary") {
		response += "Sec-WebSocket-Protocol: binary\r\n"
	}
	if _, err := rw.WriteString(response + "\r\n"); err != nil {
		conn.Close()
		return nil, nil, err
	}
	if err := rw.Flush(); err != nil {
		conn.Close()
		return nil, nil, err
	}
	return conn, rw.Reader, nil
}
