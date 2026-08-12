#!/bin/bash
set -e

# Configuration
LIBDE265_VERSION="1.1.1"
LIBHEIF_VERSION="1.23.1"
BUILD_DIR="$(pwd)/build-wasm"
OUT_DIR="$(pwd)/src/wasm/public"
WASM_JS_OUT="$(pwd)/src/wasm/wrapper/heic-decoder.js"

mkdir -p "$BUILD_DIR"
mkdir -p "$OUT_DIR"
mkdir -p "$(dirname "$WASM_JS_OUT")"

echo "Starting Docker-based Emscripten build..."

# Use emscripten docker image
docker run --rm \
  -e LIBDE265_VERSION="${LIBDE265_VERSION}" \
  -e LIBHEIF_VERSION="${LIBHEIF_VERSION}" \
  -v "$(pwd):/src" -w /src emscripten/emsdk:3.1.56 bash -c "
set -e

apt-get update && apt-get install -y autoconf automake libtool pkg-config

mkdir -p build-wasm/src
cd build-wasm/src

# 1. Download and build libde265 (CMake-only since v1.1.0; no autotools)
# A .version marker tracks which version the cached source dir contains so
# bumping LIBDE265_VERSION forces a fresh download instead of silently
# rebuilding the wrapper against the old library.
if [ ! -f libde265/.version ] || [ \"\$(cat libde265/.version 2>/dev/null)\" != \"\${LIBDE265_VERSION}\" ]; then
  echo 'Downloading libde265...'
  rm -rf libde265
  curl -L https://github.com/strukturag/libde265/releases/download/v\${LIBDE265_VERSION}/libde265-\${LIBDE265_VERSION}.tar.gz | tar xz
  mv libde265-\${LIBDE265_VERSION} libde265
  echo \"\${LIBDE265_VERSION}\" > libde265/.version
fi

cd libde265
if [ ! -f build/libde265/libde265.a ]; then
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
fi
# libde265 >= 1.1.0: de265.h includes <libde265/de265-version.h>, which CMake
# generates into the build dir. Expose it via the source tree so libheif can
# find it through LIBDE265_INCLUDE_DIR.
if [ -f build/libde265/de265-version.h ]; then
  cp build/libde265/de265-version.h libde265/de265-version.h
fi
cd ..

# 2. Download and build libheif
# Same .version-marker caching as libde265 above.
if [ ! -f libheif/.version ] || [ \"\$(cat libheif/.version 2>/dev/null)\" != \"\${LIBHEIF_VERSION}\" ]; then
  echo 'Downloading libheif...'
  rm -rf libheif
  curl -L https://github.com/strukturag/libheif/releases/download/v\${LIBHEIF_VERSION}/libheif-\${LIBHEIF_VERSION}.tar.gz | tar xz
  mv libheif-\${LIBHEIF_VERSION} libheif
  echo \"\${LIBHEIF_VERSION}\" > libheif/.version
fi

python3 /src/build-scripts/patch-libheif.py

cd libheif
if [ ! -f build/libheif/libheif.a ]; then
  echo 'Building libheif...'
  rm -rf build
  mkdir -p build
  cd build
  # Note: Need to point PKG_CONFIG to libde265
  export PKG_CONFIG_PATH="/src/build-wasm/src/libde265/build/libde265:\$PKG_CONFIG_PATH"

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
fi
cd ..

# 3. Create the WASM wrapper
echo 'Compiling WebAssembly wrapper...'
mkdir -p /src/build-wasm/wrapper
cat << 'EOF' > /src/build-wasm/wrapper/main.cpp
#include <emscripten/bind.h>
#include <libheif/heif.h>
#include <vector>
#include <string>

using namespace emscripten;

struct DecodeProgressData {
    val callback;
    int max_progress = 0;
};

class HeicDecoderWasm {
public:
    HeicDecoderWasm() {}

    ~HeicDecoderWasm() {}

    val decode(std::string data, val progress_callback) {
        heif_context* ctx = heif_context_alloc();
        if (!ctx) {
            return val(\"Failed to allocate heif context\");
        }

        heif_error err = heif_context_read_from_memory_without_copy(
            ctx, data.data(), data.size(), nullptr);

        if (err.code != heif_error_Ok) {
            heif_context_free(ctx);
            std::string msg = \"Error code \" + std::to_string(err.code) +
                              \" (subcode \" + std::to_string(err.subcode) + \"): \";
            if (err.message) {
                msg += err.message;
            } else {
                msg += \"No message\";
            }
            return val(msg);
        }

        heif_image_handle* handle;
        err = heif_context_get_primary_image_handle(ctx, &handle);
        if (err.code != heif_error_Ok) {
            heif_context_free(ctx);
            std::string msg = \"Error code \" + std::to_string(err.code) +
                              \" (subcode \" + std::to_string(err.subcode) + \"): \";
            if (err.message) {
                msg += err.message;
            } else {
                msg += \"No message\";
            }
            return val(msg);
        }

        DecodeProgressData progress_data{progress_callback, 0};
        heif_decoding_options* options = heif_decoding_options_alloc();

        if (!progress_callback.isUndefined() && !progress_callback.isNull()) {
            options->start_progress = [](enum heif_progress_step step, int max_progress, void* progress_user_data) {
                if (progress_user_data) {
                    auto* d = static_cast<DecodeProgressData*>(progress_user_data);
                    d->max_progress = max_progress;
                }
            };
            options->on_progress = [](enum heif_progress_step step, int progress, void* progress_user_data) {
                if (progress_user_data) {
                    auto* d = static_cast<DecodeProgressData*>(progress_user_data);
                    if (d->max_progress > 0) {
                        double percent = (double)progress / d->max_progress * 100.0;
                        d->callback(percent);
                    }
                }
            };
            options->progress_user_data = &progress_data;
        }

        if (!progress_callback.isUndefined() && !progress_callback.isNull()) {
            progress_callback(0.0);
        }

        heif_image* img;
        err = heif_decode_image(handle, &img, heif_colorspace_RGB, heif_chroma_interleaved_RGBA, options);
        heif_image_handle_release(handle);
        heif_decoding_options_free(options);

        if (err.code == heif_error_Ok && !progress_callback.isUndefined() && !progress_callback.isNull()) {
            progress_callback(100.0);
        }

        if (err.code != heif_error_Ok) {
            heif_context_free(ctx);
            std::string msg = \"Error code \" + std::to_string(err.code) +
                              \" (subcode \" + std::to_string(err.subcode) + \"): \";
            if (err.message) {
                msg += err.message;
            } else {
                msg += \"No message\";
            }
            return val(msg);
        }

        int width = heif_image_get_width(img, heif_channel_interleaved);
        int height = heif_image_get_height(img, heif_channel_interleaved);

        int stride;
        const uint8_t* p = heif_image_get_plane_readonly(img, heif_channel_interleaved, &stride);

        // Copy data to a JS Uint8Array
        val resultData = val::global(\"Uint8Array\").new_(width * height * 4);
        for (int y = 0; y < height; ++y) {
            val memoryView = val(typed_memory_view(width * 4, p + y * stride));
            resultData.call<void>(\"set\", memoryView, val(y * width * 4));
        }

        heif_image_release(img);
        heif_context_free(ctx);

        val result = val::object();
        result.set(\"width\", width);
        result.set(\"height\", height);
        result.set(\"data\", resultData);
        return result;
    }
};

EMSCRIPTEN_BINDINGS(my_module) {
    class_<HeicDecoderWasm>(\"HeicDecoder\")
        .constructor<>()
        .function(\"decode\", &HeicDecoderWasm::decode);
}
EOF

# Compile to WASM with strict CSP (-s DYNAMIC_EXECUTION=0)
emcc /src/build-wasm/wrapper/main.cpp \\
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
    -O3 --bind

# Copy artifacts
cp /src/build-wasm/wrapper/heic-decoder.wasm /src/src/wasm/public/
cp /src/build-wasm/wrapper/heic-decoder.js /src/src/wasm/wrapper/
echo 'Build complete!'
"
