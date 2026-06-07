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

export class LibheifDecoder implements IHeicDecoder {
  private options?: LibheifDecoderOptions;
  private module: any = null;
  private decoderInstance: any = null;

  constructor(options?: LibheifDecoderOptions) {
    this.options = options;
  }

  /**
   * Initializes the WebAssembly module and instantiates the HEIC decoder.
   */
  async initialize(): Promise<void> {
    if (this.module) {
      return;
    }

    const moduleArgs: any = {};
    if (this.options?.locateFile) {
      moduleArgs.locateFile = this.options.locateFile;
    }
    if (this.options?.wasmBinary) {
      moduleArgs.wasmBinary = this.options.wasmBinary;
    }

    this.module = await createHeicDecoderModule(moduleArgs);
    this.decoderInstance = new this.module.HeicDecoder();
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

    const result = this.decoderInstance.decode(data, onProgress || null);
    if (!result) {
      throw new Error('HEIC decoding failed');
    }
    if (typeof result === 'string') {
      throw new Error(`HEIC decoding failed: ${result}`);
    }

    const width = result.width;
    const height = result.height;
    
    // Result.data is a Uint8Array. We wrap it in a Uint8ClampedArray to match DecodedImage type.
    const clampedData = new Uint8ClampedArray(
      result.data.buffer,
      result.data.byteOffset,
      result.data.byteLength
    );

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
