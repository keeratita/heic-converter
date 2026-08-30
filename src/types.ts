export interface DecodedImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

export interface IHeicDecoder {
  /**
   * Initializes the decoder (e.g., loading WebAssembly module).
   */
  initialize(): Promise<void>;

  /**
   * Decodes HEIC binary data into raw RGBA pixel data.
   * @param data The HEIC file as a Uint8Array.
   * @param onProgress Optional progress callback that receives the progress percentage.
   */
  decode(
    data: Uint8Array,
    onProgress?: (percent: number) => void
  ): Promise<DecodedImage>;

  /**
   * Cleans up allocated resources.
   */
  free(): void;
}

export type ImageFormat = 'jpeg' | 'jpg' | 'png' | 'svg' | 'webp';

export type HeicInput = Blob | File | ArrayBuffer | Uint8Array;

export interface ResizeOptions {
  /**
   * Maximum width in pixels. The image is downscaled to fit within this
   * bound while preserving the aspect ratio. Images smaller than the bound
   * are never upscaled.
   */
  maxWidth?: number;

  /**
   * Maximum height in pixels. The image is downscaled to fit within this
   * bound while preserving the aspect ratio. Images smaller than the bound
   * are never upscaled.
   */
  maxHeight?: number;

  /**
   * Uniform scale factor applied to both dimensions (e.g. 0.5 halves the
   * image). Takes precedence over `maxWidth` and `maxHeight` when set.
   */
  scale?: number;
}

export interface ConvertOptions extends ResizeOptions {
  /**
   * Target format for the conversion.
   * @default 'jpeg'
   */
  to?: ImageFormat;

  /**
   * Quality of the converted image (between 0.0 and 1.0).
   * Applicable for 'jpeg', 'jpg', and 'webp' formats.
   * @default 0.92
   */
  quality?: number;

  /**
   * Optional custom decoder implementation to inject.
   * If not provided, a default LibheifDecoder is used.
   */
  decoder?: IHeicDecoder;

  /**
   * Optional progress callback that receives the progress percentage (0 to 100) during decoding.
   */
  onProgress?: (percent: number) => void;
}

export interface ConvertManyOptions extends Omit<ConvertOptions, 'onProgress'> {
  /**
   * Maximum number of conversions running concurrently.
   * @default 4
   */
  concurrency?: number;

  /**
   * Optional progress callback that receives the item index and its
   * progress percentage (0 to 100) during decoding.
   */
  onProgress?: (index: number, percent: number) => void;

  /**
   * Optional custom decoder implementation to inject. When provided, the
   * same instance is shared by all concurrent conversions, so it must be
   * safe for concurrent `decode()` calls. If not provided, a fresh
   * default LibheifDecoder is created per item.
   */
  decoder?: IHeicDecoder;
}
