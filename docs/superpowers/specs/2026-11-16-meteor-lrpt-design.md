# Meteor-M LRPT weather images in BrowSDR — design

Date: 2026-11-16. Status: draft for approval (builder check done).

## Intent

The station owner wants to receive images from the Russian Meteor-M weather satellites **inside BrowSDR**, rather than with scripts on the PC. The feature has to work from the phone in the field, and it has to work unattended.

- **From the phone in the field:** the Pi serves BrowSDR over HTTPS. The long-term goal is a portable hill station used from a phone.
- **Unattended, at home only (owner's decision):** a pass can happen while nobody has the browser open. At home the PC records it with `browsdr-cli`. Unattended capture in the field (Pi + phone only) is a later, separate project.

Success means two things:
- during a pass, the image builds up line by line in a BrowSDR panel and can be saved as a PNG;
- the same pass can be captured by `browsdr-cli` with no browser open.

## Background (facts the builder can rely on)

- **Satellites:**
  - Meteor-M2-3 is NORAD 57166. It is weaker because of an antenna deployment problem.
  - Meteor-M2-4 is NORAD 59051. It is the better target.
  - Both send LRPT on **137.900 MHz**, with 137.100 MHz as backup. The signal is QPSK at 72 ksym/s ("72k" mode), about 120 kHz wide. Doppler is about ±3.5 kHz.
- **NOAA APT:** the NOAA 15/18/19 satellites were switched off in 2025 and are out of scope.
- **Pass predictions:** TLEs come from Celestrak (`https://celestrak.org/NORAD/elements/gp.php?CATNR=<id>&FORMAT=TLE`). A pass above 20° elevation lasts about 8–11 minutes. Daytime passes carry visible channels; night passes carry IR only.
- **Upstream code**, both MIT licensed, by dbdexter-dev:
  - `meteor_decode` (C, about 70 KB) turns 8-bit soft QPSK symbols into an image. Its entry points:
    - `decode_init(diffcoded, interleaved)`;
    - `decode_soft_cadu(Mpdu*, read_samples)`, which is pull-based;
    - the MPDU → MCU → JPEG → `Channel` strips path in `main.c`;
    - `decode_get_rs()` and `decode_get_vit()` for stats.
  - `meteor_demod` (C, about 15 KB of DSP) is the reference demodulator. It has an AGC, an RRC filter (order 32), a Costas PLL, Gardner/interpolating timing recovery (oversampling 5) and soft 8-bit symbol output.
- **Relevant BrowSDR patterns:**
  - Per-VFO decoder streams live in `src/client/worker/decoders/`. The model is `TetraStream`, with a VFO flag and a `configure`/`process`/`reset` lifecycle. It gets its channel from `DspProcessor` (DDC) and posts status messages.
  - The channel rate table is in `worker/streams/channel-plan.ts`. Routing is in `worker/streams/vfo-workers.ts` and `channel-dispatch.ts`. About 26 files are touched when a decoder flag is added; the `tetra` flag is the template.
  - C libraries are compiled to Wasm under `wasm/<name>/`. That folder holds a pinned upstream commit with its SHA-256, `wrapper.c`, `build.sh`, and a committed `pkg/` containing the licence and NOTICE. `mbelib` is the template, and `worker/decoders/mbelib-init.ts` is the lazy loader template. The pkg is served from `/wasm/<name>/`.
  - `browsdr-cli` (`src/cli/`) runs the real `dsp-worker` in Node. It has `decode <decoder>` with listener/`--take` semantics and NDJSON output.
  - Emscripten is not installed on the dev PC; Docker is. The `emscripten/emsdk:4.0.7` image matches the version pinned for mbelib.
  - Lint limits: files ≤600 lines, functions ≤100 lines, types in `types.ts`, ≤14 files per folder.
- **Station constraints:**
  - All decoding runs on the client (PC or phone); the Pi 2 only relays IQ.
  - The Pi's Wi-Fi moved about 6 Mbit/s in practice. Over Wi-Fi the receiver therefore has to run at the lowest usable RTL rate (about 0.25–0.3 MS/s, ≈4–5 Mbit/s). On the cable link any rate works.

## Goals

1. **Live decoding.** A `meteor` VFO decoder demodulates LRPT and feeds `meteor_decode` running as Wasm. The panel (Tools → Meteor) shows:
   - lock state, signal quality, carrier offset, Viterbi cost and RS errors;
   - the image growing as strips arrive.
2. **Image output.** The panel shows a composite (meteor_decode's automatic RGB123/RGB125 choice, from the active APIDs) and the individual channels. It can save the current image as PNG.
3. **Pass list.** The panel lists the next passes of M2-3 and M2-4 over the station for 48 h: start, maximum elevation, duration and direction. Passes under 20° are greyed out.
4. **Tune for a pass.** A one-click action sets the receiver for a pass:
   - center frequency and VFO on 137.900 MHz;
   - a sample rate that fits the link (lowest usable rate when the page is served over the Wi-Fi address; otherwise 1.024 MS/s);
   - the meteor decoder turned on.

   The action follows relay etiquette: it tunes only when this client is the controller, and otherwise explains why it cannot.
5. **Arm a pass.** The panel can arm a pass: if the tab is still open and in control at the start of the pass, it tunes as in goal 4, records to the end of the pass, and keeps the image.
6. **CLI.**
   - `npm run -s cli -- passes [--json]` lists passes.
   - `decode meteor --seconds N` decodes live as a listener (inside the controller's band) or with `--take`. It writes NDJSON status and a PNG at the end.
   - `decode meteor --next-pass` waits for the next pass above 20°, decodes from AOS to LOS, and writes a PNG named with satellite, UTC time and pass.
   - `--repeat` keeps doing this pass after pass. It is meant to run on the home PC, started once (for example by Windows Task Scheduler at logon). Repeat mode instead of one scheduled task per pass is the designer's call: TLEs and passes change daily, and one long-running process avoids regenerating tasks.
   - The usual safety applies: tune only a free dongle, or with `--take`.
7. **Station location.** The pass predictions need the station location, which is set in the panel. A "use my position" option uses browser geolocation, which works on the HTTPS page. The value is stored locally per browser. The CLI takes `--lat/--lon`, or `BROWSDR_LAT`/`BROWSDR_LON`.

## Non-goals

- Unattended capture in the field, meaning a recorder on the Pi with decoding afterwards on the phone. It is a later project, once live reception works.
- NOAA APT and other satellites (Metop HRPT, GOES): not now.
- 80k interleaved and OQPSK modes: `meteor_decode` supports them. The demodulator stays QPSK-only for now, and the mode is fixed to 72k.
- Map projection/georeferencing of images, and rotator control.
- Decoding on the Pi.

## Anti-goals

- Retuning the user's session without control, or taking control silently. An armed pass must never steal control.
- Anything that breaks the other decoders, or the plain-HTTP dev setup.
- Modifying the upstream C decoder's logic. Only the wrapper adapts it. That keeps it diffable against upstream.

## Approaches considered

- **A. TypeScript demodulator + `meteor_decode` compiled to Wasm.** Picked by the owner.
  - The demodulator follows the TETRA pattern: a pure-TS stream in the DSP worker, ported from `meteor_demod`'s design.
  - The proven C decoder is reused as-is.
  - The image builds live in the app, and the same code runs in the CLI.
- **B. Port everything to TypeScript.**
  - No Wasm toolchain needed.
  - Viterbi, RS, CCSDS framing and the JPEG-like decoder would all be rewritten by hand. That is more risk for no user-visible gain.
- **C. Record IQ in the app and decode with SatDump on the PC.**
  - Least work.
  - No image in the app, and nothing usable from the phone in the field.

## Design

### Demodulator (`worker/decoders/meteor/demodulator.ts`)

- **Input:** complex baseband from a DDC at a channel rate of at least 2 samples per symbol. 144 kS/s is suggested; the channel plan gets a `meteor` entry.
- **Chain:** AGC → RRC matched filter (α = 0.6 as in meteor_demod; check upstream) → Costas loop for QPSK carrier tracking, wide enough to pull in ±3.5 kHz of Doppler plus dongle offset → symbol timing recovery → soft symbols clipped to int8, in the order meteor_decode expects.
- **Exposed metrics:** lock (from a phase-error variance), carrier offset in Hz, and quality.
- **Behaviour:** gaps (chunk discontinuities) reset the loops, as in TETRA.

### Wasm decoder (`wasm/meteor/`)

- **Packaging:** pinned upstream `meteor_decode` commit, with its archive SHA-256 verified. `build.sh` runs `emcc` 4.0.7, either directly or inside the `emscripten/emsdk:4.0.7` Docker image. The committed `pkg/` holds the LICENSE and a NOTICE. PNG/BMP output and `main.c` are not compiled; the wrapper takes `main.c`'s role.
- **Wrapper API (push model):**
  - `meteor_init()`.
  - `meteor_push(int8* symbols, n)`: appends to an internal buffer. While a full soft CADU chunk is available, it runs `decode_soft_cadu` with a `read_samples` that reads from that buffer. Each returned MPDU goes through the MCU/JPEG path into `Channel` strips for APIDs 64–69. It returns the number of new strip rows.
  - Getters: per-APID width, height and pixel pointer; active APIDs; RS errors; Viterbi cost; VCDU sequence; the satellite time of the last MPDU.
  - `meteor_reset()`.
- **Loader:** `worker/decoders/meteor-init.ts` loads the module lazily, like `mbelib-init.ts`, and works in Node for the CLI.

### Stream (`worker/decoders/meteor.ts`, `MeteorStream`)

- `configure` validates the frequency (137.0–138.0 MHz) and that a 150 kHz channel fits inside the received band.
- `process` runs the DDC, the demodulator and `meteor_push`.
- **Status:** posted every ~500 ms.
- **Image rows:** new rows are posted incrementally (APID plus row range plus bytes). Only new rows are sent; the whole image is never re-sent.
- **Messages:** follow the existing callback/route pattern.

### App panel (`app/decoders/meteor/`)

- The panel follows the TETRA/radiosonde panels.
- **Stats strip** at the top.
- **Canvas** showing the composite, with channel tabs below. It shows grey rows for lost strips: meteor_decode compensates for these by sequence number.
- **Pass table** with "Tune" and "Arm" actions.
- **Location** setting.
- **Save PNG** uses `canvas.toBlob`.
- **TLE handling:** TLEs are cached in localStorage with their age shown. They are refetched when older than 2 days and an internet connection is available. In the field without internet, the last cached TLEs keep working, since they are good for about a week.
- **Pass maths:** a small SGP4 library, `satellite.js` (MIT). The pass search (rise above 10°, max elevation, set, azimuths) lives in a shared module so that the CLI uses the same code.

### Relay control identity (designer's call, from the builder check)

**Why it is needed:** goals 4 and 5 need the app to know reliably whether it is the relay controller. Today it cannot: `/status` lists clients by IP:port, and the CLI guesses its own id (`src/cli/decode.ts:49`).

**The change:** the relay accepts an optional `?client=<random token>` query parameter on the WebSocket URL and reports it in `/status` for each client, alongside `controller: true|false`. The app and the CLI generate a token per connection and find themselves by it.
- **Compatibility:** clients without a token behave as before.
- **Code and tests:** Go change plus tests in `BrowSDR/relay/`.
- **Deploy:** redeploy on the Pi, which needs the owner's sudo password.

### Arm on the phone (designer's call)

- **What is guaranteed:** Arm is reliable only while the page is in the foreground. The panel takes a Screen Wake Lock while a pass is armed and warns that the phone must stay on with the tab in front.
- **If the stream dies mid-pass:** the partial image is kept.
- **Desktop:** it is the primary target for Arm.

### Station bookmarks

Add "Meteor-M LRPT 137.900" and "Meteor-M backup 137.100", with the meteor decoder on, to `stations/radiopi.json`.

### CLI

- **New pieces:** a `passes` command and the `meteor` decoder in `src/cli/plan.ts` and `types.ts`.
- **PNG writing:** in Node, use `node:zlib` with a minimal PNG encoder, or a tiny dependency; this is the builder's call.
- **`--next-pass`:** sleeps until AOS minus 1 minute. It then follows the same control rules as `decode`, records until LOS plus 30 s, and writes the PNG plus an NDJSON summary.

## Testing

- **Demodulator:** a synthetic QPSK signal at 72 ksym/s with an RRC shape, frequency offset, Doppler ramp, timing offset and noise. Assert lock, carrier offset accuracy and a low symbol error rate.
- **Wasm wrapper:**
  - A short real soft-symbol excerpt, a few seconds and ≤ 1 MB, committed as a fixture. It must decode to at least one MPDU/strip row with RS errors not equal to −1.
  - The first fixture comes from our own first pass, and an excerpt is cut from it. Until then, a public LRPT soft-symbol sample may be used if its licence allows.
- **Pass prediction:** compare with skyfield's output for a fixed TLE and time; for example the passes computed on 2026-11-16 from the TLEs of epoch 26319. Rise times must match within 30 s.
- **Live validation:** the M2-4 passes on 2026-11-16 at 14:10 (50°) and 21:28 (M2-3, 49°) are candidates, depending on antenna availability. The design is validated when a real pass produces a recognisable image in the panel and via the CLI.

## Left to the builder

- Exact RRC roll-off, loop bandwidths and channel rate (follow meteor_demod's defaults).
- The wire format of image row messages.
- The PNG encoder choice for Node.
- The exact rate picked when the page is on Wi-Fi.
- How "Arm" survives a page reload. It is acceptable if it does not.
