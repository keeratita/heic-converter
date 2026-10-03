export interface DecodedImage {
  width: number;
  height: number;
  /**
   * RGBA pixel data, interleaved, row-major, 4 bytes per pixel.
   *
   * The buffer is always a freshly allocated, plain `ArrayBuffer` owned by
   * the returned array (never a view into the WASM heap), so it stays valid
   * after `LibheifDecoder.free()` and can be passed directly to
   * `new ImageData(...)` / `putImageData` — including the `ImageData`
   * overload that requires `Uint8ClampedArray<ArrayBuffer>` under TS >= 5.7.
   */
  data: Uint8ClampedArray;
}

/**
 * Decoder contract used by {@link ConvertOptions.decoder} /
 * {@link ConvertManyOptions.decoder} and implemented by `LibheifDecoder`.
 *
 * Lifecycle rules followed by the library (implementations may rely on them):
 * - `initialize()` is called before every `decode()`; implementations must
 *   make repeated/concurrent calls cheap (e.g. memoize the load promise).
 * - `decode()` is awaited before the library calls `free()`; the returned
 *   `DecodedImage` must therefore not reference decoder-owned memory that
 *   `free()` releases (copy pixels out, as `LibheifDecoder` does).
 * - `free()` is called at most once per conversion. Decoders **injected** via
 *   options are never freed by the library — the caller owns their lifetime.
 *
 * Concurrency: with `convertMany`, a single injected decoder is shared by
 * all concurrent conversions, so `decode()` must be safe to call concurrently
 * on one instance (no shared mutable state across in-flight decodes).
 */
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
   * Cleans up allocated resources. Idempotent: safe to call multiple times.
   */
  free(): void;
}

export type ImageFormat = 'jpeg' | 'jpg' | 'png' | 'svg' | 'webp';

/**
 * Formats accepted by {@link ConvertOptions.to} (case-insensitive).
 * `'jpg'` is an alias of `'jpeg'`.
 */
export const SUPPORTED_FORMATS: readonly ImageFormat[] = ['jpeg', 'jpg', 'png', 'svg', 'webp'];

/** Default JPEG/WebP encoding quality used when `quality` is not provided. */
export const DEFAULT_QUALITY = 0.92;

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
   * Target format for the conversion. Must be one of the values in
   * {@link SUPPORTED_FORMATS}; an unknown value is rejected up front,
   * before the input is decoded.
   * @default 'jpeg'
   */
  to?: ImageFormat;

  /**
   * Quality of the converted image, strictly between 0.0 and 1.0.
   * Applicable for 'jpeg', 'jpg', and 'webp' formats — but validated for
   * every format: passing an out-of-range value (e.g. `90` from a 0-100
   * scale) throws regardless of `to`.
   * @default 0.92
   */
  quality?: number;

  /**
   * Optional custom decoder implementation to inject.
   * If not provided, a default LibheifDecoder is used.
   * The library never calls `free()` on an injected decoder.
   */
  decoder?: IHeicDecoder;

  /**
   * Optional progress callback that receives the progress percentage during
   * decoding. Values are normalized and clamped to the range 0 to 100.
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
   * Optional progress callback that receives the item index (0-based) and
   * its progress percentage (normalized to 0 to 100) during decoding.
   */
  onProgress?: (index: number, percent: number) => void;

  /**
   * Optional custom decoder implementation to inject. When provided, the
   * same instance is shared by all concurrent conversions, so it must be
   * safe for concurrent `decode()` calls (see {@link IHeicDecoder}). If not
   * provided, a fresh default LibheifDecoder is created per item.
   */
  decoder?: IHeicDecoder;
}
