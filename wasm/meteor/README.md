# meteor_decode WebAssembly integration

`wrapper.c` and `build.sh` are BrowSDR's integration with the upstream Meteor-M LRPT decoder
[dbdexter-dev/meteor_decode](https://github.com/dbdexter-dev/meteor_decode) (MIT). It turns
int8 soft (O)QPSK symbols into the three AVHRR image channels. `meteor_init(diff)` turns on upstream's
differential decoding (`--diff`), which the OQPSK downlinks of Meteor-M2 3 and 4 need. The upstream source directory
`meteor_decode/` is a downloaded cache and is excluded from Git.

`wrapper.c` replaces upstream `main.c`:
- It queues the symbols BrowSDR pushes.
- It runs `decode_soft_cadu` only while a whole CADU plus its resynchronisation slack is queued.
- It assembles the image with upstream's `process_mpdu` logic, without file output or the APID 70 dump.

The decoder's C state is global to a module instance, so each Meteor VFO creates its own instance
(`src/client/worker/decoders/meteor-init.ts`).

The compiled files `pkg/meteor.js` and `pkg/meteor.wasm` are committed, alongside `LICENSE` and
`NOTICE`. Vite copies `pkg/` to `dist/wasm/meteor/`. `npm install`, `npm run build` and
`npm run deploy` do not compile meteor_decode and do not need Emscripten. Keep the licence and
notice with the compiled files.

## Pinned inputs

- Upstream commit: `e7ca456ea969dc4834b5544c3789de1dd5d2f663`.
- Archive: https://codeload.github.com/dbdexter-dev/meteor_decode/tar.gz/e7ca456ea969dc4834b5544c3789de1dd5d2f663
- Archive SHA-256: `221de39adc07a87d93e824c16cf85d855dba5c2a8f565b25eab8bc164a76c946`.
- Rebuild compiler: Emscripten `4.0.7`.
- Compiler flags and the compiled source list: see `build.sh`.

## Rebuild

With the Emscripten SDK 4.0.7 active, in Bash (Linux, macOS or WSL on Windows), from the
repository root:

```bash
source ~/emsdk/emsdk_env.sh   # wherever your emsdk checkout is
bash wasm/meteor/build.sh     # or: npm run build:meteor
```

Without `emcc` in `PATH`, `build.sh` reruns itself in the `emscripten/emsdk:4.0.7` Docker image.
The first rebuild downloads the source and checks it against the pinned SHA-256.
