#!/bin/bash
# Build faad2 (DAB+ HE-AAC decoding) as a WASM module for BrowSDR.
#
# Prerequisites: Emscripten SDK 4.0.7 (emcc) in PATH, git, cmake.
#
# Usage: npm run build:faad2 (or bash wasm/faad2/build.sh)
#
# Output: wasm/faad2/pkg/faad.js + faad.wasm (+ COPYING-faad2, NOTICE)

set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
FAAD2_REPO="https://github.com/knik0/faad2.git"
# faad2 2.11.2, the release BrowSDR's HD Radio build also uses (wasm/nrsc5/upstream.json).
FAAD2_COMMIT="673a22a3c7c33e96e2ff7aae7c4d2bc190dfbf92"
EMSCRIPTEN_VERSION="4.0.7"

if [[ "$(emcc --version | head -1)" != *" $EMSCRIPTEN_VERSION "* ]]; then
    echo "Activate Emscripten $EMSCRIPTEN_VERSION before rebuilding faad2. See wasm/faad2/README.md." >&2
    exit 1
fi

SOURCE="$ROOT/vendor/faad2"
if [ ! -d "$SOURCE/.git" ]; then
    # The commit hash pins and verifies the content (git checks every object against it).
    git init -q "$SOURCE"
    git -C "$SOURCE" remote add origin "$FAAD2_REPO"
    git -C "$SOURCE" fetch -q --depth 1 origin "$FAAD2_COMMIT"
    git -C "$SOURCE" checkout -q FETCH_HEAD
fi
if [ "$(git -C "$SOURCE" rev-parse HEAD)" != "$FAAD2_COMMIT" ]; then
    echo "wasm/faad2/vendor/faad2 is not at $FAAD2_COMMIT." >&2
    exit 1
fi

emcmake cmake -S "$SOURCE" -B "$ROOT/build" -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DFAAD_BUILD_CLI=OFF
cmake --build "$ROOT/build" --target faad -j 4

mkdir -p "$ROOT/pkg"
emcc -O3 "$ROOT/wrapper.c" "$ROOT/build/libfaad.a" -I "$ROOT/build/include" -lm \
    -s MODULARIZE=1 -s EXPORT_ES6=1 -s EXPORT_NAME=FaadModule \
    -s ENVIRONMENT=web,worker,node -s FILESYSTEM=0 -s ALLOW_MEMORY_GROWTH=1 \
    -s INITIAL_MEMORY=16777216 -s STACK_SIZE=1048576 \
    -s EXPORTED_FUNCTIONS='["_dab_aac_open","_dab_aac_decode","_dab_aac_rate","_dab_aac_channels","_dab_aac_error","_dab_aac_sbr","_dab_aac_ps","_dab_aac_close","_malloc","_free"]' \
    -s EXPORTED_RUNTIME_METHODS='["HEAPU8","HEAPF32"]' -o "$ROOT/pkg/faad.js"
cp "$SOURCE/COPYING" "$ROOT/pkg/COPYING-faad2"
cp "$ROOT/NOTICE" "$ROOT/pkg/NOTICE"
echo "Built wasm/faad2/pkg/faad.js and faad.wasm."
