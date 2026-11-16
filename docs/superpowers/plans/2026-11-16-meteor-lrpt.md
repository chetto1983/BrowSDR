# Meteor-M LRPT Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Receive Meteor-M2-3/M2-4 LRPT images in BrowSDR, both live in a Tools → Meteor panel and unattended through `browsdr-cli` on the home PC. Pass predictions and relay-safe tuning are part of it.

**Architecture:**
- A pure-TypeScript QPSK demodulator in the DSP worker (`MeteorStream`, same lifecycle as `TetraStream`) feeds int8 soft symbols to upstream `meteor_decode` compiled to Wasm (`wasm/meteor/`, mbelib-style packaging).
- Image rows flow back to the app panel and to the CLI.
- Pass prediction (satellite.js SGP4) lives in one shared module that both use.
- The relay learns a per-client token, so clients know for certain whether they are the controller.

**Tech Stack:** TypeScript, Vite, vitest, Rust/Wasm DSP (`DspProcessor`, existing), Emscripten 4.0.7 via Docker (`emscripten/emsdk:4.0.7`), Go (relay), satellite.js.

**Spec:** `docs/superpowers/specs/2026-11-16-meteor-lrpt-design.md`

## Global Constraints

- **Satellites:** Meteor-M2-3 is NORAD 57166; Meteor-M2-4 is NORAD 59051.
- **Signal:** LRPT 72k QPSK, 72000 sym/s, on 137.900 MHz (backup 137.100 MHz). Doppler is ±3.5 kHz.
- **Decoder frequency window:** 137.0–138.0 MHz. A channel 150 kHz wide must fit inside the received band.
- **Pass limits:** passes are found above 10°. Passes under 20° are "poor": greyed out in the app and skipped by `--next-pass`.
- **TLE source and caching:** `https://celestrak.org/NORAD/elements/gp.php?CATNR=<id>&FORMAT=TLE` (it sends CORS `*`). Cache TLEs and refetch them when older than 2 days.
- **Upstream code:** `meteor_decode` pinned at commit `e7ca456ea969dc4834b5544c3789de1dd5d2f663`, MIT, by dbdexter-dev. It is unmodified; only `wrapper.c` adapts it. `meteor_demod` is the design reference for the demodulator.
- **Lint limits:** files ≤600 lines, functions ≤100 lines, types in `types.ts`, ≤14 files per folder, no `async` without `await`. `core.autocrlf=true`, so check formatting with `npx prettier --check --end-of-line auto <files>`.
- **Relay control safety:** the app and the CLI tune only when they are the controller (or with an explicit `--take`). An armed pass never takes control.
- **Go:** builds and tests run in WSL (`wsl -- bash -lc 'cd /mnt/d/SDR/BrowSDR/relay && go test -race ./...'`).
- **Unattended capture:** at home only, through the CLI. The Pi does no decoding.

## Review Focus

1. **The dongle is on a different band when a pass starts.** The user is listening elsewhere and is the controller. The CLI `--next-pass` must stay a listener, log that 137.9 MHz is outside the band, wait for the next pass, and leave the user's tuning alone. → test in Task 9.
2. **Stream gaps mid-pass** (Wi-Fi drop, brownout). The demodulator and decoder must recover, and the image so far must be kept. Rows are never re-sent from zero. → tests in Task 5 (gap reset) and Task 6 (rows continue after a gap).
3. **No internet in the field.** The TLE fetch fails, and the cached TLEs (with their age shown) must still give passes. With no cache at all, show a clear message, not an exception. → test in Task 3.
4. **No station location yet.** The pass list shows "set the station location" instead of passes computed for 0,0. → test in Task 3 (`predictPasses` rejects a missing site) and Task 7.
5. **A pass over the date line or past midnight, and a pass still in progress at "now".** It must be listed as in progress, with its real AOS in the past, not dropped. → test in Task 3.

---

### Task 1: Relay client tokens

**Files:**
- Modify: `relay/hub.go` (`Client` gets `Token string`; `ClientStatus` gets `Token string \`json:"client,omitempty"\``; `Join(kind, remote, token string, takeControl bool)`)
- Modify: `relay/serve.go:62` (pass `r.URL.Query().Get("client")`; the TCP path passes `""`)
- Modify: `relay/README.md` (document `?client=`)
- Test: `relay/hub_test.go`, `relay/ws_test.go`

**Interfaces:**
- Produces: `GET /status` → `clients[i].client` is the token the client connected with. The field is omitted when the client gave none. A token is limited to 64 chars of `[A-Za-z0-9_-]`; anything else is stored as `""`.

- [ ] **Step 1: Write failing tests**
  - `TestStatusReportsEachClientsToken`: two `Join` calls with tokens `"a1"` and `""`. `Status().Clients[0].Token == "a1"`, `Clients[1].Token == ""`.
  - `TestInvalidTokenIsDropped`: token `"bad token!"` → `""`.
  - `TestWebSocketClientTokenFromQuery` (ws_test): connect to `/?client=abc&control=take`. Status shows `client: "abc"` with `controller: true`.
- [ ] **Step 2:** `wsl -- bash -lc 'cd /mnt/d/SDR/BrowSDR/relay && go test -race ./...'` → FAIL (does not compile: `Join` takes 3 args).
- [ ] **Step 3:** Implement. Update every existing `Join` call in the tests with `""`.
- [ ] **Step 4:** Same command → PASS.
- [ ] **Step 5: Build the ARM binary** (do not deploy yet; deployment needs the owner's sudo password and is done in Task 10): `wsl -- bash -lc 'cd /mnt/d/SDR/BrowSDR/relay && CGO_ENABLED=0 GOOS=linux GOARCH=arm GOARM=7 go build -trimpath -ldflags="-s -w" -o ~/build/rtl-relay .'` → exit 0.
- [ ] **Step 6: Commit** `relay: report a per-client token in /status`.

### Task 2: Clients identify themselves to the relay

**Files:**
- Modify: `src/client/devices/rtltcp/protocol.ts` (add `withRelayClient`)
- Create: `src/client/devices/rtltcp/relay-control.ts` (status URL, token, control check)
- Modify: `src/client/worker/runtime/rtl-tcp.ts` (connect with the token)
- Modify: `src/cli/decode.ts` (replace the max-id guess at line 49), `src/cli/plan.ts` (`bandChange` takes a token), `src/cli/types.ts` (`RelayStatus.clients[].client?: string`)
- Test: `test/devices/…` is full, so tests go in `test/cli/relay-control.spec.js`; update `test/cli/plan.spec.js`

**Interfaces:**
- Produces:
  - `withRelayClient(wsUrl: string, token: string, take?: boolean): string`: adds `client=<token>`, and `control=take` when `take`, keeping existing query params.
  - `relayStatusUrl(wsUrl: string): string`: `ws(s)://host/...` → `http(s)://host/status`.
  - `newRelayToken(): string`: 16 chars from `crypto.getRandomValues`, base36.
  - `relayRole(status: { clients: Array<{ controller: boolean; client?: string }> }, token: string): 'controller' | 'listener' | 'absent'`.
  - `fetchRelayRole(wsUrl: string, token: string): Promise<'controller' | 'listener' | 'absent' | 'unknown'>`: returns `'unknown'` when `/status` cannot be read, for example from a plain-http page.
  - `bandChange(plan, status, ownToken?: string)` replaces `ownClientId`.
- The worker runtime keeps the token of its open connection and exposes it through `backend.relayToken(): string | null`. Wire it like the existing backend calls in `worker/runtime/backend.ts`.

- [ ] **Step 1: Write failing tests**
  - `withRelayClient('wss://h:8443/', 'abc', true)` === `'wss://h:8443/?client=abc&control=take'`.
  - `withRelayClient('ws://h/?x=1', 'abc')` keeps `x=1`.
  - `relayStatusUrl('wss://h:8443/')` === `'https://h:8443/status'`.
  - `relayRole` returns all three outcomes.
  - In `plan.spec.js`, `bandChange` for a controller with token `'t1'` reports "Another client took control" when the controller's `client` is `'t2'`, and `null` when it is `'t1'`.
- [ ] **Step 2:** `npx vitest run test/cli --project client` → FAIL.
- [ ] **Step 3:** Implement. The CLI's `openSource` builds its URL with `withRelayClient(relayEndpoints(relay).ws, token, plan.take)`.
- [ ] **Step 4:** Run the same tests, then `npm run typecheck` and `npm run lint` → PASS.
- [ ] **Step 5: Commit** `Identify app and CLI connections to the relay with a client token`.

### Task 3: Satellite pass prediction

**Files:**
- Modify: `package.json` (`satellite.js` dependency, MIT)
- Create: `src/client/satellites/types.ts`, `src/client/satellites/passes.ts`, `src/client/satellites/tle.ts`
- Test: `test/satellites/passes.spec.js`, `test/satellites/tle.spec.js`

**Interfaces:**
- Produces (types in `types.ts`):
  - `interface Site { lat: number; lon: number; altM: number }`
  - `interface Tle { name: string; norad: number; line1: string; line2: string; epoch: Date }`
  - `interface Pass { satellite: string; norad: number; aos: Date; tca: Date; los: Date; maxElevation: number; aosAzimuth: number; losAzimuth: number; inProgress: boolean; poor: boolean }`
  - `METEOR_SATELLITES: ReadonlyArray<{ name: string; norad: number; freqMHz: number }>`: `[{name:'Meteor-M2 3', norad:57166, freqMHz:137.9}, {name:'Meteor-M2 4', norad:59051, freqMHz:137.9}]`
- Produces (functions):
  - `parseTle(text: string): Tle[]`, in `tle.ts`.
  - `fetchTles(norads: number[], fetchFn = fetch): Promise<Tle[]>`, in `tle.ts`.
  - `class TleCache { constructor(storage: Pick<Storage,'getItem'|'setItem'> | null); get(): { tles: Tle[]; fetchedAt: Date } | null; put(tles: Tle[], at: Date): void; stale(now: Date): boolean }`: key `browsdr.meteorTles`; stale after 2 days.
  - `predictPasses(tles: Tle[], site: Site | null, from: Date, hours: number, minElevation = 10): Pass[]`, in `passes.ts`. It throws `Error('Set the station location first.')` when `site` is null. Results are sorted by `aos`. `poor = maxElevation < 20`. A pass already above the horizon at `from` is returned with `inProgress: true` and the real AOS, searched back up to 20 min.
  - `azimuthName(deg: number): string` → one of N, NE, E, SE, S, SW, W, NW.

- [ ] **Step 1: Write failing tests** with this fixture (Celestrak, epoch 26319). Expected values come from skyfield 1.55 for the site 44.42 N, 7.43 E, 550 m, from `2026-11-16T07:00:00Z` for 24 h.

```
METEOR-M2 3
1 57166U 23091A   26319.93474027 -.00000007  00000+0  15802-4 0  9994
2 57166  98.5893  11.6541 0005071  90.4668 269.7093 14.24056567176115
METEOR-M2 4
1 59051U 24039A   26319.98070929  .00000024  00000+0  30586-4 0  9994
2 59051  98.7247 277.5227 0008135  90.3361 269.8749 14.22443441140841
```

  - `predictPasses` returns 10 passes. Each check below is within ±30 s for times and ±1.5° for elevation:

| Satellite | AOS | Max elevation | Other checks |
|---|---|---|---|
| M2 3 | 2026-11-16T09:05:38Z | 89.5° | LOS 09:16:17Z, `azimuthName(aosAzimuth)` = N, `azimuthName(losAzimuth)` = S |
| M2 4 | 2026-11-16T13:10:31Z | 50.4° | |
| M2 3 | 2026-11-16T20:28:29Z | 49.1° | |
| M2 4 | 2026-11-17T03:05:17Z | 66.7° | |
| M2 3 | 07:28:21Z | 12.0° | `poor === true` |

  - In-progress pass: `from = 2026-11-16T09:10:00Z` gives first pass M2 3 with `inProgress: true` and AOS ≈ 09:05:38Z.
  - Missing site: `predictPasses(tles, null, …)` throws `'Set the station location first.'`.
  - `parseTle` reads the fixture into 2 TLEs with NORAD ids 57166 and 59051.
  - `TleCache` round-trips through a fake storage. `stale()` is true at fetchedAt + 49 h. With `storage = null`, `get()` returns null and nothing throws.
  - `fetchTles` with a fetch stub that rejects → the promise rejects. The caller falls back to the cache, which is tested in Task 7.
- [ ] **Step 2:** `npx vitest run test/satellites --project client` → FAIL.
- [ ] **Step 3:** Implement. Use satellite.js `propagate` + `ecfToLookAngles`. Coarse 30 s steps, then bisect AOS/LOS to 1 s and golden-section search the TCA.
- [ ] **Step 4:** Same command → PASS; typecheck and lint pass.
- [ ] **Step 5: Commit** `Predict Meteor-M passes with satellite.js and cache Celestrak TLEs`.

### Task 4: meteor_decode as Wasm

**Files:**
- Create: `wasm/meteor/build.sh`, `wasm/meteor/wrapper.c`, `wasm/meteor/README.md`, `wasm/meteor/pkg/{meteor.js,meteor.wasm,LICENSE,NOTICE}`
- Modify: `package.json` (`"build:meteor": "bash wasm/meteor/build.sh"`), `.gitignore` (`wasm/meteor/meteor_decode/` source cache)
- Create: `src/client/worker/decoders/meteor/types.ts` (module types), `src/client/worker/decoders/meteor-init.ts`
- Test: `test/decoders/meteor/wasm.spec.js`

**Interfaces:**
- **`build.sh`:**
  - Mirrors `wasm/mbelib/build.sh`: pinned archive `https://codeload.github.com/dbdexter-dev/meteor_decode/tar.gz/e7ca456ea969dc4834b5544c3789de1dd5d2f663`, with its SHA-256 recorded on the first download and then enforced.
  - Compiles the CMake `LIBRARY_SOURCES` list (correlator, deinterleave, diffcode, ecc, jpeg, math/int.c, parser, protocol, channel.c, raw_channel.c, decode.c, utils.c) plus `wrapper.c`.
  - Flags: `-O3 -sMODULARIZE=1 -sEXPORT_NAME=MeteorModule -sENVIRONMENT=web,worker,node -sALLOW_MEMORY_GROWTH=1 -sEXPORTED_RUNTIME_METHODS=cwrap,HEAPU8,HEAP8`.
  - If `emcc` is missing, it reruns itself inside `docker run --rm -v "$PWD":/src -w /src emscripten/emsdk:4.0.7`.
- **`wrapper.c` exports:**
  - `void meteor_init(void)`: `decode_init(0,0)` and three channels initialised with apid -1, as in upstream `main.c`.
  - `uint8_t *meteor_input(int n)`: returns a buffer the caller fills with `n` int8 soft symbols.
  - `int meteor_push(int n)`: appends them to the internal queue. While at least 49152 bytes (three soft CADUs) are queued, it calls `decode_soft_cadu` with a `read_samples` that serves from the queue (returning a short read only at the queue end). Each `MPDU_READY` goes through a copy of upstream `main.c`'s `process_mpdu` and `preferred_channel`, with the MIT notice kept. Returns the number of new image rows (`max offset / (MCU_PER_LINE*8)` delta).
  - Getters: `int meteor_rows(void)`, `int meteor_width(void)` (= `MCU_PER_LINE*8` = 1568), `uint8_t *meteor_channel(int i)` and `int meteor_apid(int i)` for i = 0..2, `int meteor_rs(void)`, `int meteor_vit(void)`, `uint32_t meteor_vcdu_seq(void)`, `int meteor_mpdus(void)`.
  - `void meteor_reset(void)`: frees the channels and re-inits.
- **`meteor-init.ts`:**
  - `ensureMeteorInitialized(factory?: MeteorFactory): Promise<MeteorDecoder>`. It uses `locateFile: (p) => '/wasm/meteor/' + p`. Under Node it loads `wasm/meteor/pkg/meteor.js` by file URL, the same way the CLI handles `/wasm/dsp`.
  - `interface MeteorDecoder { push(symbols: Int8Array): number; rows(): number; width(): number; channel(i: 0|1|2): Uint8Array /* view, rows*width */; apid(i: 0|1|2): number; stats(): { rs: number; vit: number; vcduSeq: number; mpdus: number }; reset(): void }`

- [ ] **Step 1: Write failing tests** in `test/decoders/meteor/wasm.spec.js`, loading `pkg/` directly:
  - `width()` is 1568 after init.
  - Pushing 1 s of Gaussian int8 noise (72000×2 symbols) returns 0 rows, `stats().mpdus === 0`, and does not throw.
  - Pushing in 7-byte pieces vs one block gives identical stats (queue correctness).
  - `reset()` returns `rows()` to 0.
  - A real-signal fixture test is added in Task 10, once our first pass is captured.
- [ ] **Step 2:** `npx vitest run test/decoders/meteor/wasm.spec.js --project client` → FAIL (no pkg).
- [ ] **Step 3:** Write `wrapper.c`, `build.sh`, the README (pinned inputs, licence, rebuild steps like mbelib's) and the loader. Run `npm run build:meteor` and commit the `pkg/` output.
- [ ] **Step 4:** The same test → PASS. `npm run build` → `dist/wasm/meteor/meteor.wasm` exists.
- [ ] **Step 5: Commit** `Compile meteor_decode to WebAssembly`.

### Task 5: LRPT QPSK demodulator

**Files:**
- Create: `src/client/worker/decoders/meteor/demodulator.ts` (plus types in `meteor/types.ts`)
- Create: `test/decoders/meteor/fixtures.js` (synthetic signal), `test/decoders/meteor/demodulator.spec.js`

**Interfaces:**
- Produces:
  - `export const METEOR_SYMBOL_RATE = 72000; export const METEOR_CHANNEL_RATE = 144000;`
  - `class MeteorDemodulator { constructor(onSymbols: (soft: Int8Array) => void); process(iq: Float32Array /* interleaved I,Q at METEOR_CHANNEL_RATE */): void; reset(): void; readonly locked: boolean; readonly freqOffsetHz: number; readonly quality: number /* 0..1 */ }`
  - The output is two int8 soft bits per symbol (I then Q), in the order and sign convention `meteor_decode` reads from `meteor_demod` `.s` files.
- **Fixture:** `qpskSignal(symbols: number, { rate=144000, offsetHz=0, dopplerHzPerS=0, timingOffset=0, snrDb=20, seed=1 }): { iq: Float32Array; bits: Uint8Array }`. It produces RRC-shaped QPSK.

- [ ] **Step 1: Write failing tests**
  - At 20 dB SNR and offset +2500 Hz, after 0.5 s `locked` is true, and |`freqOffsetHz` − 2500| < 100.
  - The hard decisions of the soft output match `bits` with BER < 1e-3 after the first 0.5 s, allowing the four QPSK phase ambiguities (test all 4 rotations and take the best).
  - With a Doppler ramp of 60 Hz/s from −3500 Hz over 10 s, lock is held for the whole run (`locked` sampled every 0.1 s is true after 0.5 s).
  - On noise only, `locked` stays false and `quality` < 0.3.
  - After `reset()`, `locked` is false and the next 0.5 s of signal relocks (gap handling).
- [ ] **Step 2:** `npx vitest run test/decoders/meteor/demodulator.spec.js --project client` → FAIL.
- [ ] **Step 3: Implement**, following `meteor_demod`'s chain:
  - AGC;
  - RRC matched filter, α = 0.6, 33 taps at 2 samples per symbol;
  - QPSK Costas loop. The phase detector is `sign(I)·Q − sign(Q)·I`, with a 2nd-order loop. Its bandwidth is wide enough to pull in ±4 kHz during acquisition and narrows once locked; the lock detector is the variance of the phase error.
  - Gardner timing recovery with linear interpolation;
  - soft output `clamp(round(x·k), −127, 127)`, with `k` from the AGC.
  - The loop constants are the builder's choice; the tests are the bar.
- [ ] **Step 4:** Same test → PASS; lint passes.
- [ ] **Step 5: Commit** `Add a QPSK demodulator for Meteor LRPT`.

### Task 6: `meteor` VFO decoder through the DSP worker

**Files:**
- Create: `src/client/worker/decoders/meteor.ts` (`MeteorStream`), `src/client/worker/decoders/meteor/validation.ts` (message validator, like `tetra/validation.ts`)
- Modify: the files the `tetra` flag touched in commit `04af9ee`, with `meteor` mirroring `tetra`. They are listed by `git show --stat 04af9ee`. The main ones:
  - `worker/runtime/types.ts` (`VfoParams.meteor?: boolean`), `worker/streams/channel-plan.ts` (width 150000 when `meteor`), `channel-dispatch.ts`, `vfo-workers.ts` (route `type: 'meteor'`), `rx-stream.ts`, `remote-clients.ts`;
  - `worker/runtime/callbacks.types.ts`, `dsp-messages.types.ts`, `backend.ts`, `worker/dsp-worker.ts`;
  - `remote/types.ts`, `remote/validation.ts`.
- Test: `test/decoders/meteor/worker.spec.js`

**Interfaces:**
- Consumes: `MeteorDemodulator` (Task 5), `ensureMeteorInitialized`/`MeteorDecoder` (Task 4).
- Produces the message:

```ts
type MeteorMessage = {
  type: 'meteor'; freq: number;
  status: { state: 'off'|'receiving'|'error'; message: string; locked: boolean; quality: number;
            freqOffsetHz: number; rs: number; vit: number; mpdus: number; rows: number; apids: [number, number, number] };
  rows?: { from: number; to: number; width: number; channels: [Uint8Array, Uint8Array, Uint8Array] };
}
```

  `rows` carries only the rows `from..to-1` that are new since the last message. `export const isMeteorFrequency = (f: number) => f >= 137 && f <= 138;`
- **`MeteorStream`:** constructor `(Processor, memory, post)` and methods `configure(params, inputRate, centerFreq)`, `process(ptr, values, floatInput, chunkId?)`, `reset()`. These follow `TetraStream` (worker/decoders/tetra.ts) line for line:
  - The DDC is set to `METEOR_CHANNEL_RATE` with bandwidth 150000.
  - The error texts are "Tune this VFO to a Meteor LRPT downlink (137.0-138.0 MHz)." and "Meteor LRPT needs a 150 kHz channel inside the received band. Move the center frequency closer to 137.9 MHz."
  - A chunk gap resets the demodulator only; the Wasm decoder keeps its image.

- [ ] **Step 1: Write failing tests** (pattern: `test/decoders/tetra/worker.spec.js`):
  - With `init` at 1.024 MS/s, center 137.75, and VFO `{freq: 137.9, meteor: true}`, plus 2 s of `qpskSignal` mixed to +150 kHz, a `meteor` message arrives with `state: 'receiving'` and `locked: true`.
  - VFO at 136.5 → `state: 'error'` with the frequency text.
  - Center 137.0 at 0.25 MS/s → error with the bandwidth text.
  - `validMeteorMessage` accepts the produced messages and rejects one with a `rows.to < rows.from`.
- [ ] **Step 2:** `npx vitest run test/decoders/meteor --project client` → FAIL.
- [ ] **Step 3:** Implement and wire. Run `npm run typecheck`.
- [ ] **Step 4:** Tests pass. Also run `npx vitest run test/decoders/tetra test/streams --project client` to make sure nothing regressed.
- [ ] **Step 5: Commit** `Run the Meteor LRPT decoder per VFO in the DSP worker`.

### Task 7: Tools → Meteor panel

**Files:**
- Create: `src/client/app/decoders/meteor/{controller.ts, panel.ts, panel.html, image.ts, passes-view.ts}`, `src/client/styles/decoders/meteor.css`
- Modify: the app files the `tetra` panel touched in commit `04af9ee`. The main ones:
  - `app/core/{constants,decoder-state,receiver.types,state,types}.ts`, `app/main.ts`, `app/radio/vfo.ts`;
  - `app/workspace/receiver-tools.ts` (`meteorTool`: label "Meteor", description "Weather satellite images · LRPT", icon `satellite` if the icon set has it, else `radio`);
  - `app/workspace/bookmarks.ts`, `style.css`.
- Test: `test/ui/meteor-image.spec.js`, `test/ui/meteor-passes.spec.js`

**Interfaces:**
- Consumes: `MeteorMessage` (Task 6), `predictPasses`, `TleCache`, `fetchTles`, `METEOR_SATELLITES`, `azimuthName` (Task 3), `fetchRelayRole`, `backend.relayToken()` (Task 2).
- Produces:
  - `class MeteorImage { append(rows: MeteorMessage['rows']): void; rows: number; toImageData(view: 'rgb'|0|1|2): ImageData; reset(): void }` in `image.ts`. It grows by row ranges. A gap in `from` (from > rows) is filled with grey (128) rows.
  - `passRows(passes: Pass[], now: Date): Array<{ label: string; when: string; detail: string; poor: boolean; inProgress: boolean }>` in `passes-view.ts`. Times are local, e.g. `"lun 16 14:10"`; detail is e.g. `"max 50° · 10 min · SE→N"`.
  - Methods on the app instance: `toggleMeteorPanel`, `_onMeteorMessage`, `meteorTune(pass?)`, `meteorArm(pass)`, `meteorDisarm()`, `meteorSavePng()`, `meteorSetLocation(lat, lon)`, `meteorUseMyPosition()`.
  - The location is stored in localStorage `browsdr.station` as `{lat, lon, altM}`.
- **Behaviour:**
  - **`meteorTune`:**
    - It first checks `fetchRelayRole`. On `'listener'` it shows "Another client controls the dongle; Meteor cannot retune it." and changes nothing. On `'controller'`, on `'unknown'` with a non-relay source, or with a local USB device, it tunes.
    - Tuning sets center 137.75 MHz and VFO 0 to 137.900 with `meteor: true`. The rate is 288000 when `location.hostname` equals the relay host and that host is not `192.168.250.2`; otherwise it is 1024000. If the device rejects 288000, the next valid rate ≥ 250000 is used.
  - **Arm:**
    - It keeps one timer. At AOS − 60 s it calls `meteorTune` and holds `navigator.wakeLock.request('screen')` (if available) from arming until LOS + 30 s.
    - Banner text: "Keep this tab open and the screen on until the pass ends."
    - When `meteorTune` refuses, the arm is cancelled with that message.
  - **TLEs:** on panel open, use the cache. If it is stale and online, fetch. On fetch failure, keep the cache and show "TLEs from <date> (offline)". With no cache: "No orbit data yet: connect to the internet once."
  - **Save PNG:** `canvas.toBlob` → download `meteor-<norad|unknown>-<UTC yyyymmdd-hhmm>.png`.

- [ ] **Step 1: Write failing tests**
  - `MeteorImage`: append rows 0–7, then 16–23 → 24 rows, with rows 8–15 equal to 128. `toImageData('rgb')` maps channels 0, 1, 2 to R, G, B (meteor_decode's composite order).
  - `passRows`: with the Task 3 fixture passes and now = `2026-11-16T09:10:00Z`, the first row has `inProgress` and the 07:28 pass is filtered out. With 13:10:31Z in Europe/Rome, the M2 4 row `when` reads `"lun 16 14:10"` (set `TZ=Europe/Rome` in the test, or format with an explicit `timeZone` parameter passed in).
  - Also `passRows` with `site` missing is handled by the caller: a test on the controller helper `meteorPassState(null)` returns `{ message: 'Set the station location first.' }`.
- [ ] **Step 2:** `npx vitest run test/ui/meteor-image.spec.js test/ui/meteor-passes.spec.js --project client` → FAIL.
- [ ] **Step 3:** Implement the panel following `app/decoders/tetra/` and the panel template style. Status text uses the same tone as `tetraStatusText`.
- [ ] **Step 4:** Tests pass. Then `npm run typecheck`, `npm run lint`, and `npm run dev`: open Tools → Meteor, set a location, and see the pass list. Without a signal the status reads "Searching…" and nothing throws in the console.
- [ ] **Step 5: Commit** `Add the Meteor weather satellite panel`.

### Task 8: Station bookmarks

**Files:**
- Modify: `stations/radiopi.json`. Add a group "Weather satellites" with:
  - `radiopi-meteor-lrpt`: 137.900 MHz, `meteor: true`;
  - `radiopi-meteor-lrpt-backup`: 137.100 MHz, `meteor: true`.

  Both have center 137.75 or 137.0 respectively and rate 1024000, in the file's existing format.
- Modify: `src/cli/bookmarks.ts` (`DECODER_FLAGS` gains `'meteor'`)
- Test: `test/cli/bookmarks.spec.js`

- [ ] **Step 1: Failing test:** `bookmarkDecode(STATION_BOOKMARKS, 'meteor-lrpt')` → `{ decoder: 'meteor', options: { freq: 137.9, … } }`.
- [ ] **Step 2:** Run it → FAIL.
- [ ] **Step 3:** Edit the JSON and `DECODER_FLAGS` (needs `DecoderName` to include `'meteor'`, see Task 9; do Task 9's type change first if running out of order).
- [ ] **Step 4:** PASS.
- [ ] **Step 5: Commit** `Add Meteor LRPT station bookmarks`.

### Task 9: CLI — passes, decode meteor, next-pass

**Files:**
- Modify: `src/cli/types.ts` (`DecoderName` gains `'meteor'`; `DecodeRun` gains `nextPass?: boolean; repeat?: boolean; lat?: number; lon?: number; out?: string`)
- Modify: `src/cli/plan.ts` (meteor profile: `freqMHz 137.9`, `sampleRate 1024000`, `centerOffsetMHz -0.15`, `halfBandHz 75e3`, `minSampleRate 250e3`, params `decoderVfo(freq, { meteor: true, bandwidth: 150000 })`)
- Modify: `src/cli/main.ts` (`passes` command; `--next-pass`, `--repeat`, `--lat`, `--lon`, `--out <dir>`, defaulting to `BROWSDR_LAT`/`BROWSDR_LON` and the current directory; update the usage text)
- Modify: `src/cli/events.ts` (meteor status → records: one `{kind:'meteor', …status}` line every 10 s)
- Create: `src/cli/png.ts` (`encodePng(width: number, height: number, rgb: Uint8Array): Buffer`, using node:zlib and CRC32), `src/cli/next-pass.ts`
- Test: `test/cli/png.spec.js`, `test/cli/next-pass.spec.js`, `test/cli/plan.spec.js`

**Interfaces:**
- Consumes: Tasks 2, 3, 4 and 6.
- Produces:
  - `passes [--json] [--hours 48]`: prints `passRows`-like lines in local time, or NDJSON `Pass` objects.
  - `decode meteor --seconds N`: the PNG is written to `--out` as `meteor-<UTC yyyymmdd-hhmm>.png` when at least 1 row was decoded. The summary gets `rows`, `mpdus` and `png`.
  - `planPassCapture(pass: Pass, status: RelayStatus, take: boolean): DecodePlan | { skip: string }`, in `next-pass.ts`: the existing `planDecode` rules applied at AOS.
  - `runNextPass(run, io, clock = { now: () => new Date(), sleep })`: sleeps until AOS − 60 s, captures until LOS + 30 s, and loops when `repeat` is set. It refetches TLEs when they are stale.

- [ ] **Step 1: Write failing tests**
  - `encodePng(2, 1, Uint8Array.of(255,0,0, 0,255,0))` starts with the PNG signature, and zlib-inflating its IDAT gives filter bytes plus the same pixels.
  - `planPassCapture`:
    - With a status where another client controls at 403.5 MHz/1.024 MS/s and `take = false` → `{ skip }` containing "outside that band". This is Review Focus 1.
    - With no clients → controller plan at 137.75.
    - With the controller already on 137.75 → listener plan.
  - `runNextPass` with a fake clock and fake capture:
    - Two passes (one poor) → only the good one is captured.
    - With `repeat`, after the first capture it moves on to the next good pass.
    - With a `{ skip }` plan it logs the reason and waits for the following pass without touching the relay.
  - `plan.spec.js`: the meteor profile refuses a 0.25 MS/s band centred 300 kHz away.
- [ ] **Step 2:** `npx vitest run test/cli --project client` → FAIL.
- [ ] **Step 3:** Implement. `runDecode` keeps its shape; meteor adds the PNG write at the end, from the decoder's three channels (composite RGB).
- [ ] **Step 4:** Tests pass. With the relay reachable: `BROWSDR_RELAY=192.168.250.2:8765 BROWSDR_LAT=44.42 BROWSDR_LON=7.43 npm run -s cli -- passes` lists today's passes, with the same times as Task 3's fixture ±1 min.
- [ ] **Step 5: Commit** `Add passes and Meteor LRPT capture to browsdr-cli`.

### Task 10: Deploy, live validation, real fixture, docs

**Files:**
- Modify: `README.md` (Meteor feature and CLI usage), `wasm/README.md` (meteor entry), `d:/SDR/CLAUDE.md` (Meteor notes)
- Create: `test/decoders/meteor/real-pass.s` (≤1 MB excerpt of int8 soft symbols) and a test in `wasm.spec.js` that it decodes
- Pi: the relay binary from Task 1 and the BrowSDR `dist/`

- [ ] **Step 1: Deploy the relay.** This needs the owner's sudo password, so ask for it.
  - `scp '\\wsl.localhost\Ubuntu\home\davide\build\rtl-relay' radiopi:`, then `sudo install` to `/usr/local/bin` and `sudo systemctl restart rtl-relay`.
  - Verify: `curl -s http://192.168.250.2:8765/status` shows `client` for a token-carrying connection (open the app).
- [ ] **Step 2: Deploy the app.** `npm run build`, then copy `dist/` to `/usr/local/share/browsdr` as in CLAUDE.md. Verify `https://192.168.250.2:8443/wasm/meteor/meteor.wasm` returns 200.
- [ ] **Step 3: Live pass.**
  - Set up the antenna (V-dipole, 53 cm arms, at the window) and pick a pass ≥ 40° (`passes`).
  - Run `npm run -s cli -- decode meteor --next-pass --out d:/SDR/logs/meteor`, plus a debug option that dumps the soft symbols. Add `--dump-symbols <file>` to Task 9's CLI if it is still missing.
  - Expected: `mpdus > 0` and a PNG showing recognisable land and cloud.
  - The owner looks at the panel image in parallel, and the result is reported to them.
- [ ] **Step 4: Real-signal fixture.** Cut ≤1 MB of soft symbols from a locked part of the dump into `real-pass.s`. Add the test: pushing it gives `mpdus ≥ 1` and `rs !== -1`. Run it → PASS.
- [ ] **Step 5:** Update the docs and CLAUDE.md with the station facts learned, such as antenna, rate and range.
- [ ] **Step 6: Commit** `Validate Meteor LRPT on a live pass and document it`. Push only when the owner asks.
