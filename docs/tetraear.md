# TetraEar integration

**Tools → TetraEar** connects a receiving BrowSDR VFO to the Python decoder from
[syrex1013/TetraEar](https://github.com/syrex1013/TetraEar). It works with local
SDRs, the network RTL-TCP source, and development IQ replay. BrowSDR owns tuning
and capture. The bridge never opens the USB receiver and never changes its frequency.

## Start on this computer

Requires Git, Node and Python 3.10 or newer with `venv` support. From the BrowSDR directory:

```sh
npm run setup:tetraear
npm run tetraear
```

The setup command downloads upstream revision
`c46141a62c5aec1a68ea7e3c1c570bcf461833e5` into `.cache/TetraEar` and installs
NumPy, bitstring and websockets in `.cache/tetraear-venv`. It does not install
Qt, a USB driver, or system Python packages. Existing checkouts at another
revision are not overwritten. Upstream sources and codec binaries remain in
the ignored cache; they are not bundled into BrowSDR releases.

In another terminal, run `npm run dev`, then open `http://localhost:5173`.
Connect a receiver, tune a VFO to a TETRA **main downlink carrier**, start
reception, and open **Tools → TetraEar → Connect TetraEar**. Analog VFO audio
can stay muted. The channel must have 36 kHz of headroom on each side inside
the received band. The bridge defaults to `ws://127.0.0.1:8766`.

Stopping reception, removing the VFO, or changing its frequency, receiver
centre or sample rate stops the session. Reconnect explicitly after the change.
Closing the panel hides it; **Disconnect** stops decoding. The enabled-decoder
shortcut reopens a hidden active panel. Session activation is not saved in
settings or bookmarks.

## HTTPS and other local ports

The bridge listens only on IPv4 loopback and accepts browser Origins explicitly.
The defaults are `http://localhost:5173` and `http://127.0.0.1:5173`. For another
dev port:

```sh
npm run tetraear -- --origin http://localhost:5177
```

Repeat `--origin` for additional origins. An HTTPS BrowSDR page requires WSS:

```sh
npm run tetraear -- --cert path/to/trusted-cert.pem --key path/to/key.pem --origin https://your-browsdr-host
```

Use `wss://127.0.0.1:8766` in the panel. The browser must trust that certificate,
and it must cover the bridge hostname or IP. The Origin is the BrowSDR page's
scheme, host and port, without a trailing slash. A page served by the Pi can
connect to this computer's loopback bridge with this configuration; loopback
on a phone refers to the phone, not the PC. WebRTC guest decoding is unsupported.

## What is decoded

- BrowSDR performs channel filtering, resampling to 72 kS/s and pi/4-DQPSK
  demodulation, reusing the native TETRA demodulator. It sends signed soft bits
  to Python, with positive values representing zero, as TetraEar expects.
- The bridge uses TetraEar's `LowerMacDecoder` and `TetraProtocolParser` to
  decode synchronization, control blocks, addresses, and call metadata.
- Only CRC-valid control blocks appear in the table. The upstream BBK path
  has no CRC and is not included in the validated-block counter. Noise cannot
  establish lock without a CRC-valid synchronization block.
- Text extraction is attempted only for an identified SDS message. TetraEar's
  text heuristics otherwise produce apparent GSM7 text from binary SYSINFO.
  Metadata and SDS interpretation retain the limitations of the upstream parser.
- Encryption flags are displayed when available. No keys, brute force or
  decryption are wired into this integration; unknown encryption stays unknown.

**Experimental voice** sends one selected timeslot through TetraEar's native
`cdecoder` / `sdecoder` executables and plays their 8 kHz PCM output in the
browser, using the VFO volume. Enable it before connecting. An unavailable
codec is reported without disabling frame reception. Use `--codec-dir` to
select native binaries; Windows EXEs are not advertised as usable on Linux.
Voice requires clear traffic and prior main-carrier synchronization. This is
not a trunk-following implementation. Upstream traffic classification and
per-block speech decoding remain experimental; intelligible live speech has
not been verified.

## Data flow and bounds

`SDR / RTL-TCP / replay → WASM DDC → browser demodulator → Comlink → WebSocket → TetraEar`

The bridge accepts protocol-1 JSON configuration followed by even-length
signed-int8 soft-bit packets. Every packet receives one JSON batch acknowledgement;
optional binary messages carry little-endian float32 mono PCM. An IQ discontinuity
sends a reset and discards partial symbols and protocol fragments. Each receiver
has its own socket and decoder state. Stale worker messages are rejected by VFO,
frequency and session identity.

The browser retains at most 500 displayed frames and eight unacknowledged packets.
It stops a stalled or overloaded bridge instead of accumulating old traffic.
The service bounds packet size, WebSocket input queue and active connections.
Closing a connection frees that session's decoder. It stores no received frames
or audio on disk; upstream voice processing may use temporary codec files.

## Verification

```sh
npx vitest run test/decoders/tetraear test/decoders/tetra --project client
npx vitest run test/ui/decoders/tetraear.spec.ts --project ui
# Windows
.cache\tetraear-venv\Scripts\python -m unittest discover -s test/tetraear -v
# Linux/macOS
.cache/tetraear-venv/bin/python -m unittest discover -s test/tetraear -v
```

Run the JS tests before the Python suite: they generate soft-bit fixtures using
the actual WASM DDC and browser demodulator, for both int8 and float IQ. Python
then verifies that the real TetraEar modules decode them. Tests also cover
captured synchronization bursts, partial packets, noise, resets, origin checks,
backpressure, session cancellation and UI history bounds.

Browser acceptance uses a synthetic SigMF replay built from captured synchronization
bursts, through the real DSP workers and loopback Python service. It verifies
visible CRC-valid network information and disconnect on replay pause. This is
offline integration validation, not a new over-the-air reception or speech test.
