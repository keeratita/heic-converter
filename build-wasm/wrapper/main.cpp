// First-party WASM wrapper around libheif (NOT generated — this file is the
// single source of truth; build-scripts/build-wasm.sh compiles it directly).
// Keep the decode limits below in sync with MAX_CANVAS_DIMENSION in
// src/render/canvas.ts and the wrapper contract in src/wasm/wrapper.ts.
#include <emscripten/bind.h>
#include <libheif/heif.h>
#include <cstdint>
#include <string>

using namespace emscripten;

namespace {

// Hard caps on decoded output, enforced *before* pixel allocation so a
// crafted HEIC file cannot make us allocate an unbounded RGBA buffer.
// kMaxDecodeDimension matches MAX_CANVAS_DIMENSION in src/render/canvas.ts;
// kMaxDecodePixels keeps the RGBA buffer we hand to JS <= 256 MB. libheif's
// own default is 32768^2 pixels (~4 GB RGBA), far too high for a browser.
const int kMaxDecodeDimension = 16384;
const uint64_t kMaxDecodePixels = 64ULL * 1024 * 1024;

std::string heif_error_to_string(const heif_error& err) {
    std::string msg = "Error code " + std::to_string(err.code) +
                      " (subcode " + std::to_string(err.subcode) + "): ";
    if (err.message) {
        msg += err.message;
    } else {
        msg += "No message";
    }
    return msg;
}

struct DecodeProgressData {
    val callback;
    int max_progress = 0;
};

} // namespace

class HeicDecoderWasm {
public:
    // Convenience entry point: embind marshals the JS Uint8Array into a
    // std::string byte-by-byte. Kept for compatibility with glue builds that
    // do not export _malloc/_free; prefer decodeFromPointer (below) when
    // available (see src/wasm/wrapper.ts).
    val decode(std::string data, val progress_callback) {
        return decode_bytes(reinterpret_cast<const uint8_t*>(data.data()),
                            data.size(),
                            progress_callback);
    }

    // Fast path: the caller placed the file bytes in the WASM heap itself
    // (module._malloc + HEAPU8.set), avoiding embind's per-byte input
    // marshalling. heap_ptr/len are only valid for the duration of this call.
    // heap_ptr is a plain number, not a raw pointer: embind forbids binding
    // raw pointer parameters (static_assert in wire.h), and the JS side
    // already holds a numeric address from _malloc anyway.
    val decodeFromPointer(uintptr_t heap_ptr, uint32_t len, val progress_callback) {
        const uint8_t* ptr = reinterpret_cast<const uint8_t*>(heap_ptr);
        if (heap_ptr == 0 || ptr == nullptr || len == 0) {
            return val("Empty decode input");
        }
        return decode_bytes(ptr, static_cast<size_t>(len), progress_callback);
    }

private:
    val decode_bytes(const uint8_t* bytes, size_t len, val progress_callback) {
        if (bytes == nullptr || len == 0) {
            return val("Empty decode input");
        }

        heif_context* ctx = heif_context_alloc();
        if (!ctx) {
            return val("Failed to allocate heif context");
        }

        // Cap memory libheif itself allocates for one (possibly adversarial)
        // file, well below the 1.23.x default of 32768^2 pixels.
        heif_security_limits* limits = heif_context_get_security_limits(ctx);
        if (limits) {
            limits->max_image_size_pixels = kMaxDecodePixels;
        }

        heif_error err = heif_context_read_from_memory_without_copy(
            ctx, bytes, len, nullptr);

        if (err.code != heif_error_Ok) {
            heif_context_free(ctx);
            return val(heif_error_to_string(err));
        }

        heif_image_handle* handle = nullptr;
        err = heif_context_get_primary_image_handle(ctx, &handle);
        if (err.code != heif_error_Ok) {
            heif_context_free(ctx);
            return val(heif_error_to_string(err));
        }

        const bool has_progress =
            !progress_callback.isUndefined() && !progress_callback.isNull();

        DecodeProgressData progress_data{progress_callback, 0};
        heif_decoding_options* options = heif_decoding_options_alloc();

        if (has_progress) {
            options->start_progress = [](enum heif_progress_step, int max_progress, void* progress_user_data) {
                if (progress_user_data) {
                    auto* d = static_cast<DecodeProgressData*>(progress_user_data);
                    d->max_progress = max_progress;
                }
            };
            options->on_progress = [](enum heif_progress_step, int progress, void* progress_user_data) {
                if (progress_user_data) {
                    auto* d = static_cast<DecodeProgressData*>(progress_user_data);
                    if (d->max_progress > 0 && !d->callback.isUndefined()) {
                        double percent = (double)progress / d->max_progress * 100.0;
                        try {
                            d->callback(percent);
                        } catch (...) {
                            // A throwing host callback must never unwind
                            // through libheif (raw ctx/handle/img would leak)
                            // or abort the module; disable further callbacks.
                            d->callback = val::undefined();
                        }
                    }
                }
            };
            options->progress_user_data = &progress_data;
            try {
                progress_callback(0.0);
            } catch (...) {
                progress_data.callback = val::undefined();
            }
        }

        heif_image* img = nullptr;
        err = heif_decode_image(handle, &img, heif_colorspace_RGB, heif_chroma_interleaved_RGBA, options);
        heif_image_handle_release(handle);
        heif_decoding_options_free(options);

        if (err.code != heif_error_Ok) {
            heif_context_free(ctx);
            return val(heif_error_to_string(err));
        }

        int width = heif_image_get_width(img, heif_channel_interleaved);
        int height = heif_image_get_height(img, heif_channel_interleaved);

        // Trust nothing returned by the decoder: validate dimensions in
        // 64-bit arithmetic *before* allocating (width*height*4 overflows
        // int above ~2^29 pixels), then reject anything beyond our caps.
        if (width <= 0 || height <= 0 ||
            width > kMaxDecodeDimension || height > kMaxDecodeDimension ||
            (uint64_t)width * (uint64_t)height > kMaxDecodePixels) {
            heif_image_release(img);
            heif_context_free(ctx);
            return val("Decoded image dimensions " + std::to_string(width) + "x" +
                       std::to_string(height) +
                       " exceed the supported limits (" +
                       std::to_string(kMaxDecodeDimension) + "px per side, " +
                       std::to_string(kMaxDecodePixels / (1024 * 1024)) + "MP total)");
        }

        int stride = 0;
        const uint8_t* p = heif_image_get_plane_readonly(img, heif_channel_interleaved, &stride);
        const uint64_t row_bytes = (uint64_t)width * 4;
        if (p == nullptr || stride < (int)row_bytes) {
            heif_image_release(img);
            heif_context_free(ctx);
            return val("Failed to access decoded pixel plane");
        }

        if (has_progress) {
            try {
                progress_callback(100.0);
            } catch (...) {
                // Progress reporting is best-effort; never fail a good decode.
            }
        }

        // Copy pixels into a JS-owned Uint8Array so the result stays valid
        // after free() and across concurrent decodes (never a heap view).
        const uint64_t total_bytes = row_bytes * (uint64_t)height;
        val resultData = val::global("Uint8Array").new_((uint32_t)total_bytes);
        if ((uint64_t)stride == row_bytes) {
            // Tightly packed rows: one bulk copy instead of height JS calls.
            resultData.call<void>("set", val(typed_memory_view((size_t)total_bytes, p)));
        } else {
            for (int y = 0; y < height; ++y) {
                val memoryView = val(typed_memory_view((size_t)row_bytes, p + (size_t)y * stride));
                resultData.call<void>("set", memoryView, val((uint32_t)((uint64_t)y * row_bytes)));
            }
        }

        heif_image_release(img);
        heif_context_free(ctx);

        val result = val::object();
        result.set("width", width);
        result.set("height", height);
        result.set("data", resultData);
        return result;
    }
};

EMSCRIPTEN_BINDINGS(heic_decoder_module) {
    class_<HeicDecoderWasm>("HeicDecoder")
        .constructor<>()
        .function("decode", &HeicDecoderWasm::decode)
        .function("decodeFromPointer", &HeicDecoderWasm::decodeFromPointer);
}
