# faad2 WebAssembly build (DAB+ audio)

DAB+ (ETSI TS 102 563) carries AAC with 960-sample frames, usually with SBR (HE-AAC) and
parametric stereo (HE-AAC v2). Browser decoders (WebCodecs) and FFmpeg's AAC decoder do not
apply SBR to 960-sample frames; [faad2](https://github.com/knik0/faad2) (GPL-2.0-or-later) does.
This folder builds faad2 to WebAssembly for BrowSDR's DAB+ receiver.

`wrapper.c` configures faad2 the way OnAir's DAB receiver does (float output, no down-matrix,
implicit SBR upsampled) and returns interleaved stereo; faad2 is unmodified. The worker loads it
from `/wasm/faad2/faad.js` (`src/client/worker/decoders/dabplus/faad.ts`).

The compiled `pkg/faad.js` and `pkg/faad.wasm` are committed with `COPYING-faad2` and `NOTICE`;
`npm run build` copies them to `dist/wasm/faad2/` and does not need Emscripten.

## Pinned inputs

- faad2 2.11.2, commit `673a22a3c7c33e96e2ff7aae7c4d2bc190dfbf92` (the same release as the HD Radio
  build, `wasm/nrsc5/upstream.json`), fetched with git; the commit hash verifies the content.
- Compiler: Emscripten `4.0.7`. Flags: see `build.sh`.

## Rebuild

```sh
source ~/emsdk/emsdk_env.sh   # Emscripten 4.0.7
npm run build:faad2
```
