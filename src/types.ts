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

export interface ConvertOptions {
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
