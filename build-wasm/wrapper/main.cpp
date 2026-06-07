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
            return val("Failed to allocate heif context");
        }

        heif_error err = heif_context_read_from_memory_without_copy(
            ctx, data.data(), data.size(), nullptr);
        
        if (err.code != heif_error_Ok) {
            heif_context_free(ctx);
            std::string msg = "Error code " + std::to_string(err.code) + 
                              " (subcode " + std::to_string(err.subcode) + "): ";
            if (err.message) {
                msg += err.message;
            } else {
                msg += "No message";
            }
            return val(msg);
        }

        heif_image_handle* handle;
        err = heif_context_get_primary_image_handle(ctx, &handle);
        if (err.code != heif_error_Ok) {
            heif_context_free(ctx);
            std::string msg = "Error code " + std::to_string(err.code) + 
                              " (subcode " + std::to_string(err.subcode) + "): ";
            if (err.message) {
                msg += err.message;
            } else {
                msg += "No message";
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
            std::string msg = "Error code " + std::to_string(err.code) + 
                              " (subcode " + std::to_string(err.subcode) + "): ";
            if (err.message) {
                msg += err.message;
            } else {
                msg += "No message";
            }
            return val(msg);
        }

        int width = heif_image_get_width(img, heif_channel_interleaved);
        int height = heif_image_get_height(img, heif_channel_interleaved);
        
        int stride;
        const uint8_t* p = heif_image_get_plane_readonly(img, heif_channel_interleaved, &stride);
        
        // Copy data to a JS Uint8Array
        val resultData = val::global("Uint8Array").new_(width * height * 4);
        for (int y = 0; y < height; ++y) {
            val memoryView = val(typed_memory_view(width * 4, p + y * stride));
            resultData.call<void>("set", memoryView, val(y * width * 4));
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

EMSCRIPTEN_BINDINGS(my_module) {
    class_<HeicDecoderWasm>("HeicDecoder")
        .constructor<>()
        .function("decode", &HeicDecoderWasm::decode);
}
