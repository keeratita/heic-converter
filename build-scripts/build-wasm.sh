#!/bin/bash
set -e

# Configuration
LIBDE265_VERSION="1.1.3"
LIBHEIF_VERSION="1.23.7"
EMSDK_VERSION="6.0.13"
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

# --force: the in-container patch scripts edit the submodule trees, so a rerun
# must be able to reset them even when a previous build left them modified;
# the tag check below still pins provenance.
git submodule update --init --recursive --force

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

BUILD_LOG="$(mktemp)"
docker run --rm \
  -e LIBDE265_VERSION="${LIBDE265_VERSION}" \
  -e LIBHEIF_VERSION="${LIBHEIF_VERSION}" \
  -v "$(pwd):/src" -w /src "emscripten/emsdk:${EMSDK_VERSION}" bash -c "
set -e

apt-get update && apt-get install -y autoconf automake libtool pkg-config

mkdir -p build-wasm/src
cd build-wasm/src

# 1. Build libde265 (CMake-only since v1.1.0)
# Cache reuse is gated on version + a hash of this script and the two libheif
# patch inputs (they change libheif.a without touching this file);
# over-invalidating on comment-only edits is the safe direction.
SCRIPT_HASH=\$(md5sum /src/build-scripts/build-wasm.sh /src/build-scripts/neutralize-libheif-diagnostics.py /src/build-scripts/libheif-no-streams.h | md5sum | cut -c1-12)

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
  # Archives compile at -Oz; the link stays at -O3 (step 3). Archive flags
  # cannot touch the import/export contract: identical glue, smaller module
  # (1,294,646 -> 829,227 B raw / 413,850 -> 300,609 B gz), output pinned
  # byte-identical by test/unit/wasm-golden.test.ts.
  emmake make -j\$(nproc) de265
  cd ..
  touch build/.built-v\${LIBDE265_VERSION}-\${SCRIPT_HASH}
fi
# libde265 >= 1.1.0: de265.h includes <libde265/de265-version.h>, which CMake
# generates into the build dir; copy it into the source tree so libheif finds
# it via LIBDE265_INCLUDE_DIR.
if [ -f build/libde265/de265-version.h ]; then
  cp build/libde265/de265-version.h libde265/de265-version.h
fi
cd ..

# 2. Build libheif
python3 /src/build-scripts/patch-libheif.py
# Stub the debug-only diagnostic printers; with the -include shim below this
# drops libc++ iostream+locale (~18% gz, canonical figures in AGENTS.md).
# Fails loudly if a libheif bump reshapes the diagnostics; output verified
# byte-identical by test/unit/wasm-golden.test.ts.
python3 /src/build-scripts/neutralize-libheif-diagnostics.py

cd libheif
if [ -f build/libheif/libheif.a ] && [ -f build/.built-v\${LIBHEIF_VERSION}-\${SCRIPT_HASH} ]; then
  echo \"Reusing cached libheif build (v\${LIBHEIF_VERSION})\"
else
  echo 'Building libheif...'
  rm -rf build
  mkdir -p build
  cd build
  # libheif locates libde265 via pkg-config
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
    -DCMAKE_CXX_FLAGS=\"-Oz -DLIBHEIF_BOX_EMSCRIPTEN_H -include /src/build-scripts/libheif-no-streams.h\"
    # -include libheif-no-streams.h replaces std::stringstream with a
    # non-logging fake: error codes and control flow survive, streamed text
    # does not. The link-map guard below fails the build if libc++ iostream
    # gets linked anyway.
  # The WITH_* knobs are libheif's generated per-codec options (an option()
  # loop over its codec table): a name the pinned version does not declare is
  # silently ignored, not an error — this set is diffed against v1.23.7. The
  # old WITH_AOM/WITH_JPEG/WITH_OPENJPEG spelled options that never existed,
  # leaving the real knobs at their ON defaults and relying on the emsdk image
  # lacking those dev packages; correct spelling makes exclusion structural.
  # WITH_LIBSHARPYUV stays ON: inert (its find_package never resolves).
  # -DLIBHEIF_BOX_EMSCRIPTEN_H compiles out libheif's dead EMSCRIPTEN_BINDINGS
  # block (the link is without --bind): ~5,451 B gz on top of -Oz.
  emmake make -j\$(nproc)
  # Guard: no third-party codec may be linked in. Plugin wrappers compile in
  # on find_package resolution, not the options above, so check the cache.
  # libde265 is the sole intended codec (passed explicitly).
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

# Strict-CSP WASM link (-s DYNAMIC_EXECUTION=0: no eval/new Function ever).
# Flags that must be preserved (AGENTS.md): DYNAMIC_EXECUTION=0,
# ALLOW_MEMORY_GROWTH=1, EXPORT_ES6=1, MODULARIZE=1, ENVIRONMENT,
# MALLOC=emmalloc, FILESYSTEM=0, link -O3, the raw C ABI exports (a --bind-
# less link; re-adding --bind re-ships ~13.7 KB gz of embind tables for
# nothing), and the post-link wasm-opt below. Size also depends on the two
# libheif patches above and the link-map guard below, which fails the build
# when they stop biting.
#
# Link -O3 is the only level verified to instantiate: -O2 fails real decodes;
# -Os/-Oz/-flto build smaller modules that die at instantiate (function import
# requires a callable). Size comes from the -Oz archives above.
#
# FILESYSTEM=0 is safe because decoding is memory-only
# (read_from_memory_without_copy in, raw RGBA out; libde265's lone fopen sits
# inside #if 0). Syscall stubs replace MEMFS: glue halved, module
# byte-identical; a filesystem-using libheif would abort on first decode.
#
# -fexceptions: for the wrapper TU's own std:: allocations only; host progress
# throws are contained by the EM_JS trampoline in main.cpp, never by unwinding
# through libheif.
# EXPORTED_FUNCTIONS/EXPORTED_RUNTIME_METHODS: the pointer protocol in
# src/wasm/wrapper.ts (_malloc upload, _heic_decode, DecodeResult header read,
# _heic_result_free release).
# em++, not emcc: emscripten >=4 links no C++ runtime under the C driver
# (undefined operator new/delete, __resumeException).
em++ ${WRAPPER_SRC} \\
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
    -s EXPORTED_FUNCTIONS=_malloc,_free,_heic_decode,_heic_result_free \\
    -s EXPORTED_RUNTIME_METHODS=HEAPU8 \\
    -s MALLOC=emmalloc \\
    -s FILESYSTEM=0 \\
    -fexceptions -fcxx-exceptions \\
    -O3 \\
    -Wl,-Map=/src/build-wasm/wrapper/heic-decoder.map

# Post-link size pass: binaryen runs on the emitted module after the glue is
# final, so it cannot desynchronize imports the way emcc link-level size flags
# do. --zero-filled-memory drops the all-zero data segment (~110 KB section;
# worth 7.5 KB gz / 5.8 KB brotli with MALLOC=emmalloc). The --enable flags
# are mandatory: this binaryen gates on CLI features, not the module, and
# rejects wasm-ld's memory.copy/fill and trunc_sat output without them.
# Separate statements, NOT one && list: set -e does not fire before the final
# && of a list, and the SIMD experiment proved a failed wasm-opt here silently
# ships the unoptimized module (pinned by test/unit/build-wasm-script.test.ts).
# Do NOT add --minify-imports* (the glue references the current import names),
# -Oz, or --strip-target-features: the last two increase gz/brotli despite
# shrinking raw.
/emsdk/upstream/bin/wasm-opt /src/build-wasm/wrapper/heic-decoder.wasm -o /src/build-wasm/wrapper/heic-decoder.wasm.opt -O3 --zero-filled-memory --enable-bulk-memory-opt --enable-nontrapping-float-to-int
mv /src/build-wasm/wrapper/heic-decoder.wasm.opt /src/build-wasm/wrapper/heic-decoder.wasm

# Guard: the diagnostics shim must bite — a stream member in the link map means
# something constructs a std stream again, the regression a libheif diagnostic
# rename would cause (~55 KB gz). Fail closed. The member set is libc++'s
# out-of-line stream objects, verified absent from the good link; the benign
# extras the map does show (ios/locale/mutex/new_helpers...) are vtable-pinned
# Box::dump ostream references and operator new's __throw_bad_alloc — machinery,
# not streams. A missing map is fatal too (grep exit 2 reads as clean).
if [ ! -s /src/build-wasm/wrapper/heic-decoder.map ]; then
  echo 'Error: emcc produced no linker map; the iostream guard cannot run.' >&2
  exit 1
fi
if grep -qE 'libc\+\+[^ ]*\.a\((iostream|ostream|strstream)\.o\)' /src/build-wasm/wrapper/heic-decoder.map; then
  echo 'Error: libc++ iostream objects were linked into the module.' >&2
  echo 'The diagnostic printers are back in — check neutralize-libheif-diagnostics.py' >&2
  echo 'and build-scripts/libheif-no-streams.h against this libheif version.' >&2
  exit 1
fi
rm -f /src/build-wasm/wrapper/heic-decoder.map

# Copy artifacts
cp /src/build-wasm/wrapper/heic-decoder.wasm /src/src/wasm/public/
cp /src/build-wasm/wrapper/heic-decoder.js /src/src/wasm/wrapper/
echo 'Build complete!'
" 2>&1 | tee "$BUILD_LOG"
# set -e cannot see a failed docker run through the pipe (the pipeline status
# is tee's); read the container status so the error can name the exit code.
container_status=${PIPESTATUS[0]}

# The container script is one bash -c string: a stray double quote silently
# truncates it and docker still exits 0 with nothing built. Require the
# sentinel, not the exit code.
if ! grep -q 'Build complete!' "$BUILD_LOG"; then
  rm -f "$BUILD_LOG"
  echo "Error: the container script never reached its last line (see output above)." >&2
  echo "Check for unescaped double quotes inside the bash -c string." >&2
  exit 1
fi
if [ "$container_status" -ne 0 ]; then
  rm -f "$BUILD_LOG"
  echo "Error: the build container exited with status $container_status." >&2
  exit "$container_status"
fi
rm -f "$BUILD_LOG"
