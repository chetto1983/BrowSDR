package main

import (
	"bufio"
	"bytes"
	"testing"
)

func TestAcceptKeyMatchesRFC6455Example(t *testing.T) {
	if got := acceptKey("dGhlIHNhbXBsZSBub25jZQ=="); got != "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=" {
		t.Fatalf("acceptKey = %q", got)
	}
}

func maskedFrame(opcode byte, payload []byte) []byte {
	mask := []byte{0x11, 0x22, 0x33, 0x44}
	frame := []byte{0x80 | opcode, 0x80 | byte(len(payload))}
	frame = append(frame, mask...)
	for i, b := range payload {
		frame = append(frame, b^mask[i%4])
	}
	return frame
}

func TestReadFrameUnmasksClientPayload(t *testing.T) {
	r := bufio.NewReader(bytes.NewReader(maskedFrame(opBinary, []byte{1, 0, 0, 0, 42})))
	opcode, payload, err := readFrame(r)
	if err != nil || opcode != opBinary || !bytes.Equal(payload, []byte{1, 0, 0, 0, 42}) {
		t.Fatalf("readFrame = %d %v %v", opcode, payload, err)
	}
}

func TestWriteFrameRoundTripsEveryLengthEncoding(t *testing.T) {
	for _, size := range []int{0, 125, 126, 65535, 65536, 200000} {
		var buf bytes.Buffer
		payload := bytes.Repeat([]byte{7}, size)
		if err := writeFrame(&buf, opBinary, payload); err != nil {
			t.Fatal(err)
		}
		opcode, got, err := readFrame(bufio.NewReader(&buf))
		if err != nil || opcode != opBinary || len(got) != size {
			t.Fatalf("size %d: opcode %d len %d err %v", size, opcode, len(got), err)
		}
	}
}
