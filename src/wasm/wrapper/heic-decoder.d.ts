// Hand-maintained typings for the GENERATED Emscripten glue
// (src/wasm/wrapper/heic-decoder.js). Keep in sync with the bindings in
// build-wasm/wrapper/main.cpp when the wrapper API changes.
interface HeicDecoderResult {
  width: number;
  height: number;
  data: Uint8Array;
}

interface HeicDecoderInstance {
  decode(data: Uint8Array, onProgress: ((percent: number) => void) | null): HeicDecoderResult | string | null;
  /** Fast path: input already placed in the WASM heap by the caller. */
  decodeFromPointer?(
    ptr: number,
    len: number,
    onProgress: ((percent: number) => void) | null
  ): HeicDecoderResult | string | null;
  delete(): void;
}

interface HeicDecoderModule {
  HeicDecoder: new () => HeicDecoderInstance;
  /** Present when built with EXPORTED_FUNCTIONS/EXPORTED_RUNTIME_METHODS. */
  _malloc?: (size: number) => number;
  _free?: (ptr: number) => void;
  HEAPU8?: Uint8Array;
}

declare function createHeicDecoderModule(options?: {
  locateFile?: (path: string, prefix: string) => string;
  wasmBinary?: ArrayBuffer | ArrayBufferView;
  [key: string]: unknown;
}): Promise<HeicDecoderModule>;

export default createHeicDecoderModule;
