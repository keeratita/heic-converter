// First-party WASM wrapper around libheif (NOT generated — this file is the
// single source of truth; build-scripts/build-wasm.sh compiles it directly).
// Keep the decode limits below in sync with MAX_CANVAS_DIMENSION in
// src/render/canvas.ts and the wrapper contract in src/wasm/wrapper.ts.
//
// Raw C ABI — no embind (the build links without --bind): the exported
// surface is heic_decode / heic_result_free below plus _malloc/_free from the
// allocator. embind's typeinfo/marshalling tables in the module and its
// runtime in the glue measured 13.7 KB gz combined at the pinned flags, so
// the JS side reads the fixed-layout DecodeResult header through a DataView
// and copies the plane itself. Progress reaches JS through the EM_JS
// trampoline — EM_JS compiles to a plain glue function, so
// DYNAMIC_EXECUTION=0 is unaffected — with the host callback installed as
// Module.__progressCb by src/wasm/wrapper.ts immediately around the
// synchronous heic_decode() call.
#include <emscripten.h>
#include <libheif/heif.h>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <string>
#include <vector>

namespace {

// Hard caps on decoded output, enforced *before* pixel allocation so a
// crafted HEIC file cannot make us allocate an unbounded RGBA buffer.
// kMaxDecodeDimension matches MAX_CANVAS_DIMENSION in src/render/canvas.ts;
// kMaxDecodePixels keeps the RGBA buffer we hand to JS <= 256 MB. libheif's
// own default is 32768^2 pixels (~4 GB RGBA), far too large for a browser.
// src/wasm/native.ts pins its own caps to these two constants by parsing
// this file — keep the declarations in sync or that test fails.
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

// Whole-container fourcc scan. The first-byte search is the hot part: memchr
// measured 2.8x over the naive per-byte loop on the adversarial worst case
// (full double pass with no early meta-box hit), while typical files cost
// ~0.1% of decode time either way. Semantics are the naive scan's exactly:
// true when the 4 bytes occur anywhere in [bytes, bytes+len).
bool contains_fourcc(const uint8_t* bytes, size_t len, const char* cc) {
    const uint8_t* p = bytes;
    const uint8_t* end = bytes + len;
    while (end - p >= 4) {
        p = (const uint8_t*)memchr(p, (uint8_t)cc[0], (size_t)(end - p));
        if (p == nullptr) {
            return false;
        }
        if (end - p >= 4 && memcmp(p, cc, 4) == 0) {
            return true;
        }
        ++p;
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

// Returns true when [p, p+size) starts with a TIFF header (II*/MM* + magic 42).
bool is_tiff_header(const uint8_t* p, size_t size) {
    if (size < 8) {
        return false;
    }
    const bool le = (p[0] == 'I' && p[1] == 'I');
    const bool be = (p[0] == 'M' && p[1] == 'M');
    if (!le && !be) {
        return false;
    }
    const uint16_t magic = le ? (uint16_t)(p[2] | (p[3] << 8)) : (uint32_t)(p[3] | (p[2] << 8));
    return magic == 42;
}

const char kExifMarker[6] = {'E', 'x', 'i', 'f', 0, 0};

// Normalizes a HEIF Exif item payload to the standard "Exif\0\0" + TIFF block
// (the JPEG APP1 payload form) so consumers can embed it verbatim. Payload
// layout: [4-byte BE offset][Exif\0\0][TIFF], offset counted from just past
// the 4-byte field; writers also store raw TIFF without the marker. Returns
// an empty vector when no TIFF header is found at any candidate position.
std::vector<uint8_t> normalize_exif_item(const uint8_t* data, size_t size) {
    std::vector<uint8_t> out;
    if (size < 12) {
        return out;
    }
    const uint8_t* body = data + 4;
    const size_t body_size = size - 4;
    const uint32_t tiff_off = ((uint32_t)data[0] << 24) | ((uint32_t)data[1] << 16) |
                              ((uint32_t)data[2] << 8) | (uint32_t)data[3];

    // Candidate TIFF start positions inside the body: the declared offset,
    // the body start (raw TIFF writers), and just past the Exif marker.
    size_t candidates[3];
    int count = 0;
    if ((uint64_t)tiff_off + 8 <= body_size) {
        candidates[count++] = tiff_off;
    }
    candidates[count++] = 0;
    if (body_size >= 6 && memcmp(body, kExifMarker, 6) == 0) {
        candidates[count++] = 6;
    }
    for (int i = 0; i < count; ++i) {
        const size_t at = candidates[i];
        if (at >= body_size || !is_tiff_header(body + at, body_size - at)) {
            continue;
        }
        const size_t tiff_size = body_size - at;
        out.reserve(6 + tiff_size);
        out.insert(out.end(), kExifMarker, kExifMarker + 6);
        out.insert(out.end(), body + at, body + at + tiff_size);
        return out;
    }
    return out;
}

// Progress trampoline: EM_JS compiles this into the glue as a plain function
// (no eval / new Function — DYNAMIC_EXECUTION=0 is unaffected). The host
// callback is Module.__progressCb, installed by src/wasm/wrapper.ts
// immediately before the synchronous heic_decode() call and cleared after.
// A throwing host callback must never unwind through libheif (raw
// ctx/handle/img would leak) or abort the module; the JS wrapper records host
// throws at its own boundary and this catch swallows anything that still
// escapes.
EM_JS(void, call_js_progress, (double percent), {
  try {
    if (Module.__progressCb) {
      Module.__progressCb(percent);
    }
  } catch (e) {}
});

// Single-threaded, synchronous decode: this file-scope state is race-free.
int g_max_progress = 0;

} // namespace

// The JS-visible header is nine 4-byte fields at fixed offsets (static
// asserted below), read through a DataView in src/wasm/wrapper.ts. Everything
// after error_len is C++-private bookkeeping that JS must never read; the
// struct and what it owns are released only by heic_result_free.
struct DecodeResult {
    int32_t width;       // 0 => error; read error/error_len for the detail
    int32_t height;
    int32_t orientation; // 1..8 as parsed; JS applies its own range guard
    uint32_t plane;      // RGBA bytes: `height` rows of `stride` bytes
    uint32_t stride;
    uint32_t exif;       // "Exif\0\0"+TIFF block, or 0
    uint32_t exif_len;
    uint32_t error;      // utf8 detail bytes, or 0
    uint32_t error_len;
    // Private state — released by heic_result_free, never read by JS:
    heif_image* img;
    heif_context* ctx;
    std::vector<uint8_t>* exif_store;
    std::vector<char>* error_store;
};

static_assert(offsetof(DecodeResult, width) == 0, "layout");
static_assert(offsetof(DecodeResult, error_len) == 32, "layout");
static_assert(sizeof(DecodeResult) == 52, "layout");

namespace {

DecodeResult* make_error(const std::string& message) {
    DecodeResult* r = new DecodeResult();
    r->width = 0;
    r->height = 0;
    r->orientation = 0;
    r->plane = 0;
    r->stride = 0;
    r->exif = 0;
    r->exif_len = 0;
    r->error_store = new std::vector<char>(message.begin(), message.end());
    r->error = r->error_store->empty() ? 0 : (uint32_t)(uintptr_t)r->error_store->data();
    r->error_len = (uint32_t)r->error_store->size();
    r->img = nullptr;
    r->ctx = nullptr;
    r->exif_store = nullptr;
    return r;
}

DecodeResult* decode_raw(const uint8_t* bytes, size_t len) {
    if (bytes == nullptr || len == 0) {
        return make_error("Empty decode input");
    }

    heif_context* ctx = heif_context_alloc();
    if (!ctx) {
        return make_error("Failed to allocate heif context");
    }

    // Cap memory libheif itself allocates for one (possibly adversarial)
    // file, well below the 1.23.x default of 32768^2 pixels.
    heif_security_limits* limits = heif_context_get_security_limits(ctx);
    if (limits) {
        limits->max_image_size_pixels = kMaxDecodePixels;
    }

    heif_error err = heif_context_read_from_memory_without_copy(ctx, bytes, len, nullptr);
    if (err.code != heif_error_Ok) {
        heif_context_free(ctx);
        return make_error(heif_error_to_string(err));
    }

    heif_image_handle* handle = nullptr;
    err = heif_context_get_primary_image_handle(ctx, &handle);
    if (err.code != heif_error_Ok) {
        heif_context_free(ctx);
        return make_error(heif_error_to_string(err));
    }

    g_max_progress = 0;
    heif_decoding_options* options = heif_decoding_options_alloc();
    options->start_progress = [](enum heif_progress_step, int max_progress, void*) {
        g_max_progress = max_progress;
    };
    options->on_progress = [](enum heif_progress_step, int progress, void*) {
        if (g_max_progress > 0) {
            call_js_progress((double)progress / (double)g_max_progress * 100.0);
        }
    };
    options->progress_user_data = nullptr;
    call_js_progress(0.0);

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
    //
    // The raw Exif *bytes* are read regardless of the fourcc guard (for
    // metadata preservation in converted output): files that both carry
    // irot and hold EXIF should still be able to preserve the block —
    // only the orientation value is guarded.
    int orientation = 1;
    std::vector<uint8_t> exif_block;
    if (err.code == heif_error_Ok) {
        const bool pending_transform =
            contains_fourcc(bytes, len, "irot") || contains_fourcc(bytes, len, "imir");
        int n_blocks = heif_image_handle_get_number_of_metadata_blocks(handle, "Exif");
        if (n_blocks > kMaxMetadataBlocks) {
            n_blocks = kMaxMetadataBlocks;
        }
        if (n_blocks > 0) {
            std::vector<heif_item_id> ids((size_t)n_blocks);
            int got = heif_image_handle_get_list_of_metadata_block_IDs(
                handle, "Exif", ids.data(), n_blocks);
            for (int i = 0; i < got; ++i) {
                if (!exif_block.empty() && (pending_transform || orientation != 1)) {
                    break; // have everything we came for
                }
                size_t msize = heif_image_handle_get_metadata_size(handle, ids[i]);
                if (msize < 8 || msize > kMaxExifParseBytes) {
                    continue;
                }
                std::vector<uint8_t> buf(msize);
                heif_error merr = heif_image_handle_get_metadata(handle, ids[i], buf.data());
                if (merr.code != heif_error_Ok) {
                    continue;
                }
                if (exif_block.empty()) {
                    exif_block = normalize_exif_item(buf.data(), msize);
                }
                if (!pending_transform && orientation == 1) {
                    orientation = parse_exif_orientation(buf.data(), msize);
                }
            }
        }
    }

    heif_image_handle_release(handle);
    heif_decoding_options_free(options);

    if (err.code != heif_error_Ok) {
        heif_context_free(ctx);
        return make_error(heif_error_to_string(err));
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
        return make_error("Decoded image dimensions " + std::to_string(width) + "x" +
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
        return make_error("Failed to access decoded pixel plane");
    }

    call_js_progress(100.0);

    // The image and context stay alive until JS has copied the plane (one
    // copy, same as the old embind path did on the C++ side);
    // heic_result_free ends them. Until then this is the only owner, so the
    // plane/exif pointers JS reads are stable for the duration.
    DecodeResult* r = new DecodeResult();
    r->width = width;
    r->height = height;
    r->orientation = orientation;
    r->plane = (uint32_t)(uintptr_t)p;
    r->stride = (uint32_t)stride;
    r->error = 0;
    r->error_len = 0;
    r->error_store = nullptr;
    r->img = img;
    r->ctx = ctx;
    if (!exif_block.empty()) {
        r->exif_store = new std::vector<uint8_t>(std::move(exif_block));
        r->exif = (uint32_t)(uintptr_t)r->exif_store->data();
        r->exif_len = (uint32_t)r->exif_store->size();
    } else {
        r->exif_store = nullptr;
        r->exif = 0;
        r->exif_len = 0;
    }
    return r;
}

} // namespace

extern "C" {

// heap_ptr must reference `len` bytes of a file already placed in the WASM
// heap by the caller (malloc + HEAPU8.set). Returns a heap-allocated result;
// the caller MUST call heic_result_free exactly once after copying the data.
DecodeResult* heic_decode(uintptr_t heap_ptr, uint32_t len) {
    const uint8_t* ptr = reinterpret_cast<const uint8_t*>(heap_ptr);
    if (heap_ptr == 0 || ptr == nullptr || len == 0) {
        return make_error("Empty decode input");
    }
    return decode_raw(ptr, static_cast<size_t>(len));
}

void heic_result_free(DecodeResult* r) {
    if (r == nullptr) {
        return;
    }
    if (r->img) {
        heif_image_release(r->img);
    }
    if (r->ctx) {
        heif_context_free(r->ctx);
    }
    delete r->exif_store;
    delete r->error_store;
    delete r;
}

} // extern "C"
