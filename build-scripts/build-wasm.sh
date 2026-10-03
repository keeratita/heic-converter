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

# The tracked C++ wrapper is the single source of truth — this script must
# never regenerate it from an embedded copy (that created two sources of truth).
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
docker run --rm \
  -e LIBDE265_VERSION="${LIBDE265_VERSION}" \
  -e LIBHEIF_VERSION="${LIBHEIF_VERSION}" \
  -v "$(pwd):/src" -w /src "emscripten/emsdk:${EMSDK_VERSION}" bash -c "
set -e

apt-get update && apt-get install -y autoconf automake libtool pkg-config

mkdir -p build-wasm/src
cd build-wasm/src

# 1. Build libde265 (CMake-only since v1.1.0; no autotools)
# Cached builds are gated on a version stamp so a version bump (or a stale
# tree from an older build) always triggers a clean rebuild.
cd libde265
if [ -f build/libde265/libde265.a ] && [ -f \"build/.built-v\${LIBDE265_VERSION}\" ]; then
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
  touch \"build/.built-v\${LIBDE265_VERSION}\"
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
if [ -f build/libheif/libheif.a ] && [ -f \"build/.built-v\${LIBHEIF_VERSION}\" ]; then
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
  touch \"build/.built-v\${LIBHEIF_VERSION}\"
fi
cd ..

# 3. Compile the WASM wrapper (tracked source of truth: build-wasm/wrapper/main.cpp;
# existence already verified by the outer script before starting Docker)
echo 'Compiling WebAssembly wrapper...'

# Compile to WASM with strict CSP (-s DYNAMIC_EXECUTION=0).
# Flags that must be preserved (see AGENTS.md): DYNAMIC_EXECUTION=0,
# ALLOW_MEMORY_GROWTH=1, EXPORT_ES6=1, MODULARIZE=1, ENVIRONMENT, --bind, -O3.
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
    -fexceptions -fcxx-exceptions \\
    -O3 --bind

# Copy artifacts
cp /src/build-wasm/wrapper/heic-decoder.wasm /src/src/wasm/public/
cp /src/build-wasm/wrapper/heic-decoder.js /src/src/wasm/wrapper/
echo 'Build complete!'
"
