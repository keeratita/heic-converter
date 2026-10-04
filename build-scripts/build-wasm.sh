#!/bin/bash
set -e

# Configuration
LIBDE265_VERSION="1.1.3"
LIBHEIF_VERSION="1.23.5"
EMSDK_VERSION="3.1.56"
BUILD_DIR="$(pwd)/build-wasm"
OUT_DIR="$(pwd)/src/wasm/public"
WASM_JS_OUT="$(pwd)/src/wasm/wrapper/heic-decoder.js"
WRAPPER_SRC="/src/build-wasm/wrapper/main.cpp"

mkdir -p "$BUILD_DIR"
mkdir -p "$OUT_DIR"
mkdir -p "$(dirname "$WASM_JS_OUT")"

# Compile the tracked C++ wrapper directly; never regenerate it here.
if [ ! -f "$BUILD_DIR/wrapper/main.cpp" ]; then
  echo "Error: $BUILD_DIR/wrapper/main.cpp is missing." >&2
  echo "It is a tracked first-party file; restore it with: git checkout -- build-wasm/wrapper/main.cpp" >&2
  exit 1
fi

echo "Starting Docker-based Emscripten build..."

# Ensure submodules are checked out at the pinned versions
git submodule update --init --recursive

# The submodule commit is the version marker; verify it matches the pinned tags
LIBHEIF_CHECKOUT="$(git -C "$BUILD_DIR/src/libheif" describe --tags --exact-match 2>/dev/null || echo 'unknown')"
LIBDE265_CHECKOUT="$(git -C "$BUILD_DIR/src/libde265" describe --tags --exact-match 2>/dev/null || echo 'unknown')"
if [ "$LIBHEIF_CHECKOUT" != "v${LIBHEIF_VERSION}" ]; then
  echo "Error: libheif submodule is at '$LIBHEIF_CHECKOUT', expected 'v${LIBHEIF_VERSION}'" >&2
  echo "Fix: cd build-wasm/src/libheif && git checkout v${LIBHEIF_VERSION}" >&2
  exit 1
fi
if [ "$LIBDE265_CHECKOUT" != "v${LIBDE265_VERSION}" ]; then
  echo "Error: libde265 submodule is at '$LIBDE265_CHECKOUT', expected 'v${LIBDE265_VERSION}'" >&2
  echo "Fix: cd build-wasm/src/libde265 && git checkout v${LIBDE265_VERSION}" >&2
  exit 1
fi

# Use the Docker image
BUILD_LOG="$(mktemp)"
docker run --rm \
  -e LIBDE265_VERSION="${LIBDE265_VERSION}" \
  -e LIBHEIF_VERSION="${LIBHEIF_VERSION}" \
  -v "$(pwd):/src" -w /src "emscripten/emsdk:${EMSDK_VERSION}" bash -c "
set -e

apt-get update && apt-get install -y autoconf automake libtool pkg-config

mkdir -p build-wasm/src
cd build-wasm/src

# 1. Build libde265 (CMake-only since v1.1.0; no autotools)
# Cached builds are gated on version + a hash of this script, so a version
# bump, a stale tree from an older build, or any edit to the flags below all
# force a clean rebuild. Keying on the version alone would let a flags change
# be silently ignored while the committed artifacts looked unchanged. (Hashing
# the whole script can over-invalidate on a comment-only edit, which costs
# build time but can never under-invalidate.)
SCRIPT_HASH=\$(md5sum /src/build-scripts/build-wasm.sh | cut -c1-12)

cd libde265
if [ -f build/libde265/libde265.a ] && [ -f build/.built-v\${LIBDE265_VERSION}-\${SCRIPT_HASH} ]; then
  echo \"Reusing cached libde265 build (v\${LIBDE265_VERSION})\"
else
  echo 'Building libde265...'
  rm -rf build
  mkdir -p build
  cd build
  emcmake cmake .. \
    -DBUILD_SHARED_LIBS=OFF \
    -DENABLE_SDL=OFF \
    -DENABLE_SIMD=OFF \
    -DENABLE_AVX2=OFF \
    -DENABLE_AVX512=OFF \
    -DENABLE_DECODER=ON \
    -DENABLE_ENCODER=OFF \
    -DENABLE_SHERLOCK265=OFF \
    -DENABLE_INTERNAL_DEVELOPMENT_TOOLS=OFF \
    -DWITH_FUZZERS=OFF \
    -DCMAKE_C_FLAGS=\"-O3\" \
    -DCMAKE_CXX_FLAGS=\"-O3\"
  emmake make -j\$(nproc) de265
  cd ..
  touch build/.built-v\${LIBDE265_VERSION}-\${SCRIPT_HASH}
fi
# libde265 >= 1.1.0: de265.h includes <libde265/de265-version.h>, which CMake
# generates into the build dir. Expose it via the source tree so libheif can
# find it through LIBDE265_INCLUDE_DIR.
if [ -f build/libde265/de265-version.h ]; then
  cp build/libde265/de265-version.h libde265/de265-version.h
fi
cd ..

# 2. Build libheif
python3 /src/build-scripts/patch-libheif.py

cd libheif
if [ -f build/libheif/libheif.a ] && [ -f build/.built-v\${LIBHEIF_VERSION}-\${SCRIPT_HASH} ]; then
  echo \"Reusing cached libheif build (v\${LIBHEIF_VERSION})\"
else
  echo 'Building libheif...'
  rm -rf build
  mkdir -p build
  cd build
  # Note: Need to point PKG_CONFIG to libde265
  export PKG_CONFIG_PATH=\"/src/build-wasm/src/libde265/build/libde265:\$PKG_CONFIG_PATH\"

  emcmake cmake .. \
    -DBUILD_SHARED_LIBS=OFF \
    -DBUILD_TESTING=OFF \
    -DENABLE_PLUGIN_LOADING=OFF \
    -DENABLE_MULTITHREADING_SUPPORT=OFF \
    -DENABLE_PARALLEL_TILE_DECODING=OFF \
    -DWITH_LIBDE265=ON \
    -DLIBDE265_INCLUDE_DIR=/src/build-wasm/src/libde265 \\
    -DLIBDE265_LIBRARY=/src/build-wasm/src/libde265/build/libde265/libde265.a \\
    -DWITH_X265=OFF \\
    -DWITH_AOM=OFF \\
    -DWITH_DAV1D=OFF \\
    -DWITH_SvtEnc=OFF \\
    -DWITH_RAV1E=OFF \\
    -DWITH_JPEG=OFF \\
    -DWITH_OPENJPEG=OFF \\
    -DWITH_EXAMPLES=OFF \\
    -DCMAKE_CXX_FLAGS=\"-O3\"
  emmake make -j\$(nproc)
  cd ..
  touch build/.built-v\${LIBHEIF_VERSION}-\${SCRIPT_HASH}
fi
cd ..

# 3. Compile the WASM wrapper (source: build-wasm/wrapper/main.cpp)
echo 'Compiling WebAssembly wrapper...'

# Compile to WASM with strict CSP (-s DYNAMIC_EXECUTION=0).
# Flags that must be preserved (see AGENTS.md): DYNAMIC_EXECUTION=0,
# ALLOW_MEMORY_GROWTH=1, EXPORT_ES6=1, MODULARIZE=1, ENVIRONMENT, --bind, -O3.
#
# Keep the link step at -O3. It is the only optimization level that produces a
# module which instantiates on the pinned emsdk 3.1.56: measured on 0.5.1, -O2
# fails the real-decode tests outright, and -Os, -Oz and -flto each build a
# *smaller* .wasm that then dies with 'function import requires a callable',
# because their extra link-time passes desynchronize the minified import names
# from the JS glue under --bind + MODULARIZE + EXPORT_ES6. -s FILESYSTEM=0 is
# unusable for the same reason: the module is byte-identical without it but
# genuinely imports the MEMFS syscalls, so its 40% smaller glue lacks them.
#
# -s MALLOC=emmalloc IS enabled (0.5.1): it swaps Emscripten's default dlmalloc
# for the smaller emmalloc and is runtime-clean under the real-decode integration
# tests; -s ALLOW_MEMORY_GROWTH=1 in the link covers the decode allocations.
# Combined with the post-link wasm-opt pass further below it saves 13.3 KB raw / 7.5 KB gz / 5.8 KB
# brotli (1.8% of the download). libheif's own size knobs are already at their
# optimal defaults, so this is close to the remaining margin -- re-measure
# everything against a newer emsdk before chasing more.
# -fexceptions/-fcxx-exceptions: let main.cpp try/catch a throwing JS progress
#   callback so it can never unwind through libheif or abort the module.
# EXPORTED_FUNCTIONS/EXPORTED_RUNTIME_METHODS: enable the decodeFromPointer
#   fast path in src/wasm/wrapper.ts (bulk input load via _malloc + HEAPU8).
emcc ${WRAPPER_SRC} \\
    -o /src/build-wasm/wrapper/heic-decoder.js \\
    -I/src/build-wasm/src/libheif/libheif/api \\
    -I/src/build-wasm/src/libheif/build \\
    /src/build-wasm/src/libheif/build/libheif/libheif.a \\
    /src/build-wasm/src/libde265/build/libde265/libde265.a \\
    -s WASM=1 \\
    -s ALLOW_MEMORY_GROWTH=1 \\
    -s DYNAMIC_EXECUTION=0 \\
    -s EXPORT_ES6=1 \\
    -s MODULARIZE=1 \\
    -s ENVIRONMENT=\"web,worker,node\" \\
    -s EXPORT_NAME=\"createHeicDecoderModule\" \\
    -s EXPORTED_FUNCTIONS=_malloc,_free \\
    -s EXPORTED_RUNTIME_METHODS=HEAPU8 \\
    -s MALLOC=emmalloc \\
    -fexceptions -fcxx-exceptions \\
    -O3 --bind

# Post-link size pass (added in 0.5.1). Runs binaryen over the EMITTED module
# instead of asking emcc to size-optimize the link. emcc's own -Oz/-Os/-O2/-flto
# each build a smaller module whose imports no longer match the generated glue,
# so it dies at instantiate with 'function import requires a callable'; a
# post-link pass cannot desynchronize the two, because the glue is already final
# and import renaming is opt-in (--minify-imports*) and stays off.
# --zero-filled-memory drops the all-zero data segments (~110 KB data section);
# together with -s MALLOC=emmalloc it is worth 7.5 KB gz / 5.8 KB brotli.
# Do NOT add --minify-imports* here (the glue references the current import
# names), and do NOT add -Oz or --strip-target-features: both measurably
# *increase* this module's compressed size even though -Oz shrinks the raw file.
/emsdk/upstream/bin/wasm-opt /src/build-wasm/wrapper/heic-decoder.wasm -o /src/build-wasm/wrapper/heic-decoder.wasm.opt -O3 --zero-filled-memory && mv /src/build-wasm/wrapper/heic-decoder.wasm.opt /src/build-wasm/wrapper/heic-decoder.wasm

# Copy artifacts
cp /src/build-wasm/wrapper/heic-decoder.wasm /src/src/wasm/public/
cp /src/build-wasm/wrapper/heic-decoder.js /src/src/wasm/wrapper/
echo 'Build complete!'
" 2>&1 | tee "$BUILD_LOG"

# The whole container script is a single bash -c string, so one stray double
# quote in a comment silently truncates it and docker still exits 0 with nothing
# built (bash -n cannot see it either). Require the sentinel, not the exit code.
if ! grep -q 'Build complete!' "$BUILD_LOG"; then
  rm -f "$BUILD_LOG"
  echo "Error: the container script never reached its last line (see output above)." >&2
  echo "Check for unescaped double quotes inside the bash -c string." >&2
  exit 1
fi
rm -f "$BUILD_LOG"
