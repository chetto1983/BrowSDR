#!/usr/bin/env bash
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$HERE/pkg"
ON_AIR_COMMIT=3d3f1ca9935650d2336631bcf45a3329e7adb229
EMSCRIPTEN_VERSION=4.0.7
if ! command -v emcc >/dev/null 2>&1 || [[ "$(emcc --version | head -1)" != *" $EMSCRIPTEN_VERSION "* ]]; then
    echo "Activate Emscripten $EMSCRIPTEN_VERSION" >&2
    exit 1
fi
if [[ -n "${ONAIR_SOURCE:-}" ]]; then
    SOURCE="$ONAIR_SOURCE/third_party/codec2"
    [[ "$(git -C "$ONAIR_SOURCE" rev-parse HEAD)" == "$ON_AIR_COMMIT" ]] || { echo "OnAir source commit mismatch" >&2; exit 1; }
else
    TMP_CLONE="$(mktemp -d)"
    trap 'rm -rf "$TMP_CLONE"' EXIT
    git clone --quiet --filter=blob:none --no-checkout https://github.com/adswill/OnAir.git "$TMP_CLONE"
    git -C "$TMP_CLONE" sparse-checkout set third_party/codec2
    git -C "$TMP_CLONE" checkout --quiet "$ON_AIR_COMMIT"
    SOURCE="$TMP_CLONE/third_party/codec2"
fi
[[ -f "$SOURCE/COPYING" && -f "$SOURCE/src/codec2.c" ]] || { echo "Codec2 sources missing" >&2; exit 1; }
mkdir -p "$OUT"
emcc -O3 -w -DGIT_HASH='"1.2.0"' \
    -DCODEC2_MODE_EN_DEFAULT=0 -DCODEC2_MODE_3200_EN=1 -DCODEC2_MODE_1600_EN=1 \
    -I"$SOURCE/src" -I"$SOURCE/include" \
    -s WASM=1 -s MODULARIZE=1 -s EXPORT_ES6=1 -s EXPORT_NAME=Codec2Module \
    -s EXPORTED_FUNCTIONS='["_browsdr_codec2_init","_browsdr_codec2_decode","_browsdr_codec2_reset","_malloc","_free"]' \
    -s EXPORTED_RUNTIME_METHODS='["cwrap","HEAPU8","HEAPF32"]' \
    -s ALLOW_MEMORY_GROWTH=1 -s INITIAL_MEMORY=2097152 -s ENVIRONMENT='web,worker' -s FILESYSTEM=0 -s ASSERTIONS=0 \
    "$HERE/wrapper.c" "$SOURCE"/src/*.c -lm -o "$OUT/codec2.js"
cp "$SOURCE/COPYING" "$OUT/COPYING"
echo "Codec2 WASM built in $OUT"
