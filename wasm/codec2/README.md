# Codec2 for M17

`build.sh` builds the pinned Codec2 1.2.0 source bundled in [OnAir](https://github.com/adswill/OnAir) as a separate WebAssembly module. It exposes only the 3200 and 1600 bit/s speech modes used by M17. Codec2 is LGPL-2.1; see `pkg/COPYING`. Activate Emscripten 4.0.7, then run `bash wasm/codec2/build.sh`. `ONAIR_SOURCE` may point to a checkout of the pinned OnAir commit to avoid downloading it again.
