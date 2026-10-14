// Hand-maintained typings for the GENERATED Emscripten glue
// (src/wasm/wrapper/heic-decoder.js). Keep in sync with the bindings in
// build-wasm/wrapper/main.cpp when the wrapper API changes — this file is the
// single description of the glue surface: `src/wasm/wrapper.ts` imports these
// types instead of re-declaring them (a private copy here went stale once).
export interface HeicDecoderResult {
  width: number;
  height: number;
  data: Uint8Array;
  /** EXIF orientation 1-8 (1 when absent or already applied by libheif). */
  orientation?: number;
  /**
   * Raw EXIF block normalized to the JPEG APP1 payload form
   * ("Exif\0\0" + TIFF), present when the file carries an Exif item
   * (regardless of irot/imir). JS-owned, same as `data`.
   */
  exif?: Uint8Array;
}

export interface HeicDecoderInstance {
  /**
   * Compatibility binding (main.cpp): marshals the input through a C++
   * std::string byte-by-byte. The JS wrapper always takes the
   * `decodeFromPointer` fast path; kept because the binding ships in the
   * pinned binary, not because the wrapper calls it.
   */
  decode(data: Uint8Array, onProgress: ((percent: number) => void) | null): HeicDecoderResult | string | null;
  /** Fast path: reads input already placed in the WASM heap by the caller. */
  decodeFromPointer(
    ptr: number,
    len: number,
    onProgress: ((percent: number) => void) | null
  ): HeicDecoderResult | string | null;
  delete(): void;
}

export interface HeicDecoderModule {
  HeicDecoder: new () => HeicDecoderInstance;
  /**
   * Pointer API required by the wrapper's fast path. The pinned build
   * (build-wasm.sh exports _malloc/_free/HEAPU8) always provides them;
   * `LibheifDecoder.initialize()` verifies once per load and fails with
   * `decoder_init_failed` otherwise (tampered/mismatched glue).
   */
  _malloc: (size: number) => number;
  _free: (ptr: number) => void;
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
