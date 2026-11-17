#!/bin/bash
# Build meteor_decode (Meteor-M LRPT image decoder) as a WASM module for BrowSDR.
#
# Prerequisites: Emscripten SDK 4.0.7 (emcc) in PATH, or Docker (the emscripten/emsdk:4.0.7 image is
# used automatically when emcc is missing).
#
# Usage: npm run build:meteor (or bash wasm/meteor/build.sh)
#
# Output: wasm/meteor/pkg/meteor.js + meteor.wasm (+ LICENSE)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OUT_DIR="$SCRIPT_DIR/pkg"
SOURCE_DIR="$SCRIPT_DIR/meteor_decode"
METEOR_COMMIT="e7ca456ea969dc4834b5544c3789de1dd5d2f663"
METEOR_SHA256="221de39adc07a87d93e824c16cf85d855dba5c2a8f565b25eab8bc164a76c946"
EMSCRIPTEN_VERSION="4.0.7"

if ! command -v emcc >/dev/null 2>&1; then
    if command -v docker >/dev/null 2>&1; then
        REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
        exec docker run --rm -v "$REPO_ROOT":/src -w /src "emscripten/emsdk:$EMSCRIPTEN_VERSION" bash wasm/meteor/build.sh
    fi
    echo "Emscripten $EMSCRIPTEN_VERSION (or Docker) is required. See wasm/meteor/README.md." >&2
    exit 1
fi
COMPILER_VERSION="$(emcc --version)"
if [[ "${COMPILER_VERSION%%$'\n'*}" != *" $EMSCRIPTEN_VERSION "* ]]; then
    echo "Activate Emscripten $EMSCRIPTEN_VERSION before rebuilding. See wasm/meteor/README.md." >&2
    exit 1
fi
if [ ! -f "$OUT_DIR/NOTICE" ]; then
    echo "Restore wasm/meteor/pkg/NOTICE before rebuilding." >&2
    exit 1
fi

BUILD_DIR="$(mktemp -d)"
cleanup() {
    rm -rf "$BUILD_DIR"
}
trap cleanup EXIT

# Download the pinned upstream source only for an explicit rebuild.
if [ ! -d "$SOURCE_DIR" ]; then
    echo "Downloading meteor_decode source..."
    curl -fL --retry 3 "https://codeload.github.com/dbdexter-dev/meteor_decode/tar.gz/$METEOR_COMMIT" -o "$BUILD_DIR/source.tar.gz"
    if command -v sha256sum >/dev/null 2>&1; then
        ARCHIVE_HASH="$(sha256sum "$BUILD_DIR/source.tar.gz")"
    else
        ARCHIVE_HASH="$(shasum -a 256 "$BUILD_DIR/source.tar.gz")"
    fi
    if [ "${ARCHIVE_HASH%% *}" != "$METEOR_SHA256" ]; then
        echo "meteor_decode archive checksum mismatch; source was not extracted." >&2
        exit 1
    fi
    tar xzf "$BUILD_DIR/source.tar.gz" -C "$SCRIPT_DIR"
    mv "$SCRIPT_DIR/meteor_decode-$METEOR_COMMIT" "$SOURCE_DIR"
    echo "meteor_decode source downloaded."
fi

# The library sources of upstream CMakeLists.txt, minus raw_channel.c (APID 70 file dump, unused here).
SOURCES=(
    correlator/correlator.c correlator/autocorrelator.c deinterleave/deinterleave.c diffcode/diffcode.c
    ecc/descramble.c ecc/rs.c ecc/viterbi.c jpeg/huffman.c jpeg/jpeg.c math/int.c
    parser/mcu_parser.c parser/mpdu_parser.c protocol/mcu.c protocol/mpdu.c protocol/vcdu.c
    channel.c decode.c utils.c
)

echo "Building meteor_decode WASM..."
emcc -O3 -std=gnu99 -DNDEBUG -DVERSION='"browsdr"' \
    -s WASM=1 \
    -s MODULARIZE=1 \
    -s EXPORT_ES6=1 \
    -s EXPORT_NAME='MeteorModule' \
    -s EXPORTED_FUNCTIONS='["_meteor_init","_meteor_reset","_meteor_input","_meteor_input_size","_meteor_push","_meteor_rows","_meteor_width","_meteor_channel_rows","_meteor_channel","_meteor_apid","_meteor_rs","_meteor_vit","_meteor_vcdu_seq","_meteor_mpdus","_meteor_block_time"]' \
    -s EXPORTED_RUNTIME_METHODS='["cwrap","HEAPU8","HEAP8"]' \
    -s ALLOW_MEMORY_GROWTH=1 \
    -s ENVIRONMENT='web,worker,node' \
    -s FILESYSTEM=0 \
    -s ASSERTIONS=0 \
    -I"$SOURCE_DIR" \
    -o "$BUILD_DIR/meteor.js" \
    "$SCRIPT_DIR/wrapper.c" \
    "${SOURCES[@]/#/$SOURCE_DIR/}"

# Keep the working deployment files if download or compilation fails.
cp "$BUILD_DIR/meteor.js" "$BUILD_DIR/meteor.wasm" "$OUT_DIR/"
cp "$SOURCE_DIR/LICENSE" "$OUT_DIR/LICENSE"

echo "Build complete: $OUT_DIR/meteor.js + meteor.wasm"
ls -lh "$OUT_DIR"/meteor.*
