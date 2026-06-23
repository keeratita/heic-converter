interface HeicDecoderResult {
  width: number;
  height: number;
  data: Uint8Array;
}

interface HeicDecoderInstance {
  decode(data: Uint8Array, onProgress: ((percent: number) => void) | null): HeicDecoderResult | string | null;
  delete(): void;
}

interface HeicDecoderModule {
  HeicDecoder: new () => HeicDecoderInstance;
}

declare function createHeicDecoderModule(options?: {
  locateFile?: (path: string, prefix: string) => string;
  wasmBinary?: ArrayBuffer;
}): Promise<HeicDecoderModule>;

export default createHeicDecoderModule;
