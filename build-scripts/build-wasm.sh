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
    -DCMAKE_C_FLAGS=\"-Oz\" \
    -DCMAKE_CXX_FLAGS=\"-Oz\"
  # Both libraries compile at -Oz while the emcc LINK stays at -O3. The split is
  # deliberate and measured: emcc's own link-level -Oz/-Os/-O2/-flto build a smaller
  # module whose imports no longer match the generated glue (it dies at instantiate
  # with 'function import requires a callable'), but the optimizer level of the
  # *archives* never touches the import/export contract, so the glue is emitted
  # byte-identical and the module simply carries less code. libde265 1.1.3 +
  # libheif 1.23.5 at -Oz: 1,294,646 -> 829,227 B raw, 413,850 -> 300,609 B gz,
  # with decoded RGBA, dimensions, orientation tags and malformed-input outcomes
  # byte-identical to -O3 (guarded by test/unit/wasm-golden.test.ts).
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
    -DWITH_DAV1D=OFF \\
    -DWITH_SvtEnc=OFF \\
    -DWITH_RAV1E=OFF \\
    -DWITH_AOM_DECODER=OFF \\
    -DWITH_AOM_ENCODER=OFF \\
    -DWITH_X264=OFF \\
    -DWITH_OpenH264_DECODER=OFF \\
    -DWITH_OpenH264_ENCODER=OFF \\
    -DWITH_JPEG_DECODER=OFF \\
    -DWITH_JPEG_ENCODER=OFF \\
    -DWITH_OpenJPEG_DECODER=OFF \\
    -DWITH_OpenJPEG_ENCODER=OFF \\
    -DWITH_EXAMPLES=OFF \\
    -DCMAKE_C_FLAGS=\"-Oz\" \\
    -DCMAKE_CXX_FLAGS=\"-Oz -DLIBHEIF_BOX_EMSCRIPTEN_H\"
  # The codec knobs above use the option() names libheif 1.23.5 actually declares.
  # The previous -DWITH_AOM, -DWITH_JPEG and -DWITH_OPENJPEG spelled options that do
  # not exist: CMake accepted them as UNINITIALIZED cache entries and ignored them,
  # so the real knobs (WITH_AOM_DECODER, WITH_AOM_ENCODER, WITH_X264,
  # WITH_OpenH264_DECODER, WITH_OpenH264_ENCODER) kept their ON defaults and only
  # the failing find_package inside the emsdk image kept those codecs out of the
  # binary. Spelling them correctly makes the exclusion structural rather than
  # incidental, so an emsdk image that ships these libraries can no longer silently
  # bloat the archive. WITH_LIBSHARPYUV is deliberately left at its ON default: it
  # is inert because its find_package does not resolve, and turning it off has never
  # been validated against the pixel goldens.
  # -Oz compiling the library, while the emcc link below stays at -O3: the archive
  # optimization level never touches the import/export contract, so the glue is
  # emitted byte-identical and the module simply carries less code.
  # -DLIBHEIF_BOX_EMSCRIPTEN_H compiles out libheif's own EMSCRIPTEN_BINDINGS block
  # (libheif/api/libheif/heif_emscripten.h, included by heif.cc). The C++ wrapper
  # exposes its own embind class, so that second binding table is dead weight whose
  # registration also helped make --bind look mandatory: worth 5,451 B gz on top of
  # -Oz.
  emmake make -j\$(nproc)
  # Guard: no third-party codec may be linked into the module. libheif probes for
  # aom, jpeg, openjpeg, x264, x265, dav1d, svt-av1, rav1e and libsharpyuv with
  # find_package and compiles their plugin wrappers in when it finds them; the
  # options above request OFF, but a dependency that resolves anyway would still
  # reach the binary, so fail here instead of shipping a quietly fatter WASM.
  # libde265 is the one intended codec and is passed explicitly, so it is excluded.
  if grep -iqE '(AOM|JPEG|OpenJPEG|X264|X265|DAV1D|SvtEnc|RAV1E|H264|SHARPYUV|WEBP)[A-Z_]*_FOUND:BOOL=(TRUE|1|ON|YES)' CMakeCache.txt \
     || grep -iqE '(AOM|JPEG|OpenJPEG|X264|X265|DAV1D|SvtEnc|RAV1E|H264|SHARPYUV)[A-Z_]*(_LIBRARY|_DIR):(FILEPATH|PATH)=/[^/]' CMakeCache.txt; then
    echo 'Error: libheif resolved a third-party codec (inspect build/CMakeCache.txt).' >&2
    echo 'The decoder must be built against libde265 only; check whether the emsdk' >&2
    echo 'image started shipping codec dev packages.' >&2
    exit 1
  fi
  cd ..
  touch build/.built-v\${LIBHEIF_VERSION}-\${SCRIPT_HASH}
fi
cd ..

# 3. Compile the WASM wrapper (source: build-wasm/wrapper/main.cpp)
echo 'Compiling WebAssembly wrapper...'

# Compile to WASM with strict CSP (-s DYNAMIC_EXECUTION=0).
# Flags that must be preserved (see AGENTS.md): DYNAMIC_EXECUTION=0,
# ALLOW_MEMORY_GROWTH=1, EXPORT_ES6=1, MODULARIZE=1, ENVIRONMENT, --bind,
# link-level -O3, MALLOC=emmalloc, FILESYSTEM=0, and the post-link wasm-opt pass.
#
# Keep the LINK step at -O3. It is the only link-time optimization level that
# produces a module which instantiates on the pinned emsdk 3.1.56: measured on
# 0.5.1, -O2 fails the real-decode tests outright, and -Os, -Oz and -flto each
# build a *smaller* .wasm that then dies with 'function import requires a
# callable', because their extra link-time passes desynchronize the minified
# import names from the JS glue under --bind + MODULARIZE + EXPORT_ES6. The
# libraries themselves do compile at -Oz (cmake blocks above): the optimization
# level of an archive cannot touch the import/export contract, so it is safe,
# and it is where the large win lives.
#
# -s FILESYSTEM=0 is enabled (0.5.1). The module still imports the syscall
# functions, but Emscripten links stubs in place of the MEMFS implementation, so
# the glue drops from 68,600 to 33,902 B minified (22,413 to 11,874 B gz) while
# the module stays byte-identical. It is safe because decoding is memory-only:
# main.cpp feeds bytes via heif_context_read_from_memory_without_copy and returns
# RGBA through embind, and no reachable libheif path opens a file (the lone fopen
# in plugins/decoder_libde265.cc sits inside #if 0). An earlier note here called
# this flag unusable, but that was inferred from builds that also used link-level
# -Oz/-flto, which were the actual breakage. If a future libheif ever genuinely
# needs the filesystem it will fail loudly as an abort on the first decode.
#
# -s MALLOC=emmalloc (0.5.1) swaps Emscripten's default dlmalloc for the smaller
# emmalloc and is runtime-clean under the real-decode tests;
# -s ALLOW_MEMORY_GROWTH=1 in the link covers the decode allocations. With the
# post-link wasm-opt pass below it is worth 13.3 KB raw / 7.5 KB gz.
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
    -s FILESYSTEM=0 \\
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
