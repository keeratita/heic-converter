import { IHeicDecoder, DecodedImage } from '../types';
import createHeicDecoderModule from './wrapper/heic-decoder.js';

export interface LibheifDecoderOptions {
  /**
   * Custom function to locate the WASM file.
   * Useful when serving the WASM file from a custom route or CDN.
   */
  locateFile?: (path: string, prefix: string) => string;

  /**
   * Raw WASM binary buffer. If provided, the library will use this buffer
   * directly instead of attempting to fetch the WASM file.
   */
  wasmBinary?: ArrayBuffer;
}

/**
 * Shape of the decoded result returned by the WASM HeicDecoder.
 */
interface HeicDecoderResult {
  width: number;
  height: number;
  data: Uint8Array;
}

/**
 * Shape of the WASM HeicDecoder instance exposed by libheif.
 */
interface HeicDecoderInstance {
  decode(data: Uint8Array, onProgress: ((percent: number) => void) | null): HeicDecoderResult | string | null;
  delete(): void;
}

/**
 * Shape of the WASM module factory output.
 */
interface HeicDecoderModule {
  HeicDecoder: new () => HeicDecoderInstance;
}

interface ModuleInitOptions {
  locateFile?: LibheifDecoderOptions['locateFile'];
  wasmBinary?: ArrayBuffer;
}

export class LibheifDecoder implements IHeicDecoder {
  private options?: LibheifDecoderOptions;
  private module: HeicDecoderModule | null = null;
  private decoderInstance: HeicDecoderInstance | null = null;
  /**
   * Memoized module-loading promise so concurrent initialize()/decode() calls
   * on the same instance never instantiate (or mutate) the module twice.
   */
  private initPromise: Promise<HeicDecoderModule> | null = null;

  constructor(options?: LibheifDecoderOptions) {
    this.options = options;
  }

  /**
   * Initializes the WebAssembly module and instantiates the HEIC decoder.
   * Safe to call concurrently: the module is loaded at most once per instance.
   */
  async initialize(): Promise<void> {
    if (!this.initPromise) {
      const moduleArgs: ModuleInitOptions = {};
      if (this.options?.locateFile) {
        moduleArgs.locateFile = this.options.locateFile;
      }
      if (this.options?.wasmBinary) {
        moduleArgs.wasmBinary = this.options.wasmBinary;
      }

      this.initPromise = createHeicDecoderModule(moduleArgs)
        .then((module) => {
          this.module = module;
          this.decoderInstance = new module.HeicDecoder();
          return module;
        })
        .catch((error) => {
          // Reset so a failed load (e.g. transient WASM fetch failure) can be retried.
          this.initPromise = null;
          throw error;
        });
    }

    await this.initPromise;
  }

  /**
   * Decodes HEIC binary data into raw RGBA pixel data.
   * @param data The HEIC file contents as a Uint8Array.
   * @param onProgress Optional progress callback.
   */
  async decode(
    data: Uint8Array,
    onProgress?: (percent: number) => void
  ): Promise<DecodedImage> {
    if (!this.module || !this.decoderInstance) {
      await this.initialize();
    }

    const result = this.decoderInstance!.decode(data, onProgress ?? null);
    if (!result) {
      throw new Error('HEIC decoding failed');
    }
    if (typeof result === 'string') {
      throw new Error(`HEIC decoding failed: ${result}`);
    }

    const width = result.width;
    const height = result.height;

    // Copy the pixels out of the WASM heap: the returned DecodedImage owns its
    // data, so it stays valid after free() and is never corrupted by a later
    // decode on the same (or any other) decoder instance.
    const clampedData = new Uint8ClampedArray(result.data);

    return {
      width,
      height,
      data: clampedData,
    };
  }

  /**
   * Cleans up the WebAssembly decoder instance and resources.
   */
  free(): void {
    if (this.decoderInstance) {
      this.decoderInstance.delete();
      this.decoderInstance = null;
    }
    this.module = null;
  }
}
