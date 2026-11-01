// Hand-maintained typings for the GENERATED Emscripten glue
// (src/wasm/wrapper/heic-decoder.js). Keep in sync with the extern "C" exports
// in build-wasm/wrapper/main.cpp when the wrapper API changes — this file is
// the single description of the glue surface: `src/wasm/wrapper.ts` imports
// these types instead of re-declaring them (a private copy here went stale
// once).
//
// The surface is the raw C ABI — the build links WITHOUT --bind, so no
// embind class is exported at all. The JS protocol: upload the file with
// _malloc + HEAPU8.set, call _heic_decode, read the returned DecodeResult
// header (36 bytes: nine 4-byte little-endian fields whose layout is
// static_asserted in main.cpp — widths/height/orientation as Int32, the rest
// as Uint32), copy the plane/exif out, then release the struct exactly once
// with _heic_result_free.
export interface HeicDecoderModule {
  /** emmalloc entry point; returns 0 when the allocation fails. */
  _malloc: (size: number) => number;
  _free: (ptr: number) => void;
  /**
   * Decodes `len` bytes of a HEIC file sitting at heap address `heapPtr`
   * (the caller placed them via _malloc + HEAPU8.set; they must stay valid
   * for the duration of this synchronous call).
   *
   * Returns a heap pointer to the C++ DecodeResult, or 0 when even that
   * allocation failed (treat as a module fault). On success the plane and
   * exif bytes stay valid until _heic_result_free — copy them out first.
   * A decode error is NOT an exception: it comes back as width === 0 with
   * the utf8 detail in error/error_len. Re-read module.HEAPU8 after this
   * call: ALLOW_MEMORY_GROWTH may have replaced the heap during decode.
   */
  _heic_decode: (heapPtr: number, len: number) => number;
  /**
   * Releases a DecodeResult from _heic_decode (image, context, exif/error
   * stores). Null-safe; call exactly once per non-zero pointer, after the
   * plane/exif copies are taken.
   */
  _heic_result_free: (resultPtr: number) => void;
  /**
   * Progress slot called by the EM_JS trampoline in main.cpp with
   * percentages 0–100 during _heic_decode. Assign it and call _heic_decode
   * within ONE synchronous task (never across an await): the single thread
   * serializes decodes that share the module this way. The C++ boundary
   * swallows anything this callback throws, but the JS side should contain
   * host throws itself to record them and stop the remaining events.
   */
  __progressCb?: ((percent: number) => void) | null;
  /** Live heap view — re-read the property after anything that may grow memory. */
  HEAPU8: Uint8Array;
}

export interface HeicDecoderModuleOptions {
  locateFile?: (path: string, prefix: string) => string;
  wasmBinary?: ArrayBuffer | ArrayBufferView;
  [key: string]: unknown;
}

declare function createHeicDecoderModule(
  options?: HeicDecoderModuleOptions
): Promise<HeicDecoderModule>;

export default createHeicDecoderModule;
