// First-party WASM wrapper around libheif (NOT generated — this file is the
// single source of truth; build-scripts/build-wasm.sh compiles it directly).
// Keep the decode limits below in sync with MAX_CANVAS_DIMENSION in
// src/render/canvas.ts and the wrapper contract in src/wasm/wrapper.ts.
#include <emscripten/bind.h>
#include <libheif/heif.h>
#include <cstdint>
#include <cstring>
#include <string>
#include <vector>

using namespace emscripten;

namespace {

// Hard caps on decoded output, enforced *before* pixel allocation so a
// crafted HEIC file cannot make us allocate an unbounded RGBA buffer.
// kMaxDecodeDimension matches MAX_CANVAS_DIMENSION in src/render/canvas.ts;
// kMaxDecodePixels keeps the RGBA buffer we hand to JS <= 256 MB. libheif's
// own default is 32768^2 pixels (~4 GB RGBA), far too large for a browser.
const int kMaxDecodeDimension = 16384;
const uint64_t kMaxDecodePixels = 64ULL * 1024 * 1024;

// Orientation reading is metadata-only work; refuse to parse absurdly large
// Exif blocks (normal ones are a few KB).
const size_t kMaxExifParseBytes = 4 * 1024 * 1024;
// Defensive cap: enough blocks for any real file, bounds a crafted count.
const int kMaxMetadataBlocks = 64;

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

bool contains_fourcc(const uint8_t* bytes, size_t len, const char* cc) {
    for (size_t i = 0; i + 4 <= len; ++i) {
        if (bytes[i] == (uint8_t)cc[0] && bytes[i + 1] == (uint8_t)cc[1] &&
            bytes[i + 2] == (uint8_t)cc[2] && bytes[i + 3] == (uint8_t)cc[3]) {
            return true;
        }
    }
    return false;
}

// Bounds-checked 16/32-bit reads over a fixed buffer with fixed endianness.
// Every read that fails its bounds check aborts orientation parsing.
class ByteReader {
public:
    ByteReader(const uint8_t* data, size_t size, bool little_endian)
        : data_(data), size_(size), le_(little_endian) {}

    bool u16(size_t at, uint16_t* out) const {
        if (at + 2 > size_) {
            return false;
        }
        *out = le_ ? (uint16_t)(data_[at] | ((uint16_t)data_[at + 1] << 8))
                   : (uint16_t)(data_[at + 1] | ((uint16_t)data_[at] << 8));
        return true;
    }

    bool u32(size_t at, uint32_t* out) const {
        if (at + 4 > size_) {
            return false;
        }
        *out = le_ ? ((uint32_t)data_[at] | ((uint32_t)data_[at + 1] << 8) |
                      ((uint32_t)data_[at + 2] << 16) | ((uint32_t)data_[at + 3] << 24))
                   : ((uint32_t)data_[at + 3] | ((uint32_t)data_[at + 2] << 8) |
                      ((uint32_t)data_[at + 1] << 16) | ((uint32_t)data_[at] << 24));
        return true;
    }

private:
    const uint8_t* data_;
    size_t size_;
    bool le_;
};

// Extracts the EXIF orientation tag (0x0112, values 1-8) from IFD0 of a TIFF
// block. Returns 0 when the block is not a TIFF at all, 1 (identity) for a
// TIFF without a usable orientation tag — orientation is advisory and must
// never fail a decode.
int parse_tiff_orientation(const uint8_t* tiff, size_t tiff_size) {
    if (tiff_size < 8) {
        return 0;
    }
    bool little_endian;
    if (tiff[0] == 'I' && tiff[1] == 'I') {
        little_endian = true;
    } else if (tiff[0] == 'M' && tiff[1] == 'M') {
        little_endian = false;
    } else {
        return 0;
    }
    ByteReader rd(tiff, tiff_size, little_endian);
    uint16_t magic = 0;
    if (!rd.u16(2, &magic) || magic != 42) {
        return 0;
    }
    uint32_t ifd0 = 0;
    uint16_t entry_count = 0;
    if (!rd.u32(4, &ifd0) || !rd.u16(ifd0, &entry_count)) {
        return 1;
    }
    for (uint16_t i = 0; i < entry_count; ++i) {
        const size_t entry = (size_t)ifd0 + 2 + (size_t)i * 12;
        uint16_t tag = 0;
        if (!rd.u16(entry, &tag)) {
            return 1;
        }
        if (tag != 0x0112) {
            continue;
        }
        uint16_t type = 0;
        uint32_t count = 0;
        uint16_t value16 = 0;
        uint32_t value32 = 0;
        if (!rd.u16(entry + 2, &type) || !rd.u32(entry + 4, &count)) {
            return 1;
        }
        // SHORT count 1 (canonical) or LONG count 1 (seen from some writers).
        if (type == 3 && count == 1 && rd.u16(entry + 8, &value16)) {
            return (value16 >= 1 && value16 <= 8) ? (int)value16 : 1;
        }
        if (type == 4 && count == 1 && rd.u32(entry + 8, &value32)) {
            return (value32 >= 1 && value32 <= 8) ? (int)value32 : 1;
        }
        return 1; // malformed orientation entry
    }
    return 1;
}

// Extracts the orientation from a HEIF Exif item payload:
// [4-byte BE offset][Exif\0\0][TIFF], where the offset is counted from just
// past the 4-byte field (so it typically resolves past the 'Exif\0\0'
// marker). Tolerates writers that store raw TIFF without the prefix.
// Returns 1 (identity) for anything absent or malformed.
int parse_exif_orientation(const uint8_t* data, size_t size) {
    if (size < 12) {
        return 1;
    }
    const uint8_t* body = data + 4;
    const size_t body_size = size - 4;
    const uint32_t tiff_off = ((uint32_t)data[0] << 24) | ((uint32_t)data[1] << 16) |
                              ((uint32_t)data[2] << 8) | (uint32_t)data[3];
    if ((uint64_t)tiff_off + 8 <= body_size) {
        int parsed = parse_tiff_orientation(body + tiff_off, body_size - tiff_off);
        if (parsed > 0) {
            return parsed;
        }
    }
    int direct = parse_tiff_orientation(body, body_size);
    return direct > 0 ? direct : 1;
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

        // Orientation policy:
        // - `irot`/`imir` display transforms are applied by libheif during
        //   decode (dimensions come back swapped), so files carrying those
        //   boxes must never be rotated further — Apple-style files have both
        //   irot and EXIF tag 274, and reading EXIF unconditionally would
        //   double-rotate them.
        // - Otherwise honor the EXIF orientation tag (274) from the Exif
        //   item: the file class written by editors that only rewrite EXIF
        //   metadata; browsers honor it, so we must too.
        // The irot/imir check is a whole-container fourcc scan: conservative
        // by design, the worst case is "not rotated" (pre-fix behavior),
        // never "double-rotated".
        int orientation = 1;
        if (err.code == heif_error_Ok &&
            !contains_fourcc(bytes, len, "irot") &&
            !contains_fourcc(bytes, len, "imir")) {
            int n_blocks = heif_image_handle_get_number_of_metadata_blocks(handle, "Exif");
            if (n_blocks > kMaxMetadataBlocks) {
                n_blocks = kMaxMetadataBlocks;
            }
            if (n_blocks > 0) {
                std::vector<heif_item_id> ids((size_t)n_blocks);
                int got = heif_image_handle_get_list_of_metadata_block_IDs(
                    handle, "Exif", ids.data(), n_blocks);
                for (int i = 0; i < got && orientation == 1; ++i) {
                    size_t msize = heif_image_handle_get_metadata_size(handle, ids[i]);
                    if (msize < 8 || msize > kMaxExifParseBytes) {
                        continue;
                    }
                    std::vector<uint8_t> buf(msize);
                    heif_error merr = heif_image_handle_get_metadata(handle, ids[i], buf.data());
                    if (merr.code == heif_error_Ok) {
                        orientation = parse_exif_orientation(buf.data(), msize);
                    }
                }
            }
        }

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
        result.set("orientation", orientation);
        return result;
    }
};

EMSCRIPTEN_BINDINGS(heic_decoder_module) {
    class_<HeicDecoderWasm>("HeicDecoder")
        .constructor<>()
        .function("decode", &HeicDecoderWasm::decode)
        .function("decodeFromPointer", &HeicDecoderWasm::decodeFromPointer);
}
