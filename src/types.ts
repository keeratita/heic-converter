export interface DecodedImage {
  width: number;
  height: number;
  /**
   * RGBA pixel data, interleaved, row-major, 4 bytes per pixel. Always a
   * plain `ArrayBuffer` owned by the returned array — never a WASM-heap
   * view — so it stays valid after `LibheifDecoder.free()` and passes
   * directly to `new ImageData(...)` / `putImageData`, including the
   * `ImageData` overload that requires `Uint8ClampedArray<ArrayBuffer>`
   * under TS >= 5.7.
   */
  data: Uint8ClampedArray;

  /**
   * Raw EXIF block copied from the source file, normalized to the JPEG APP1
   * payload form: `"Exif\0\0"` followed by the TIFF structure. Present
   * whenever the file carries an Exif item — including files where libheif
   * already applied `irot`/`imir` (reported independently of
   * {@link DecodedImage.orientation}). `convertHeic` re-injects it into
   * JPEG (APP1) and PNG (`eXIf`) output when `preserveExif: true`;
   * raw-decode consumers can attach it to their own encoder output (e.g.
   * `sharp`'s `.withMetadata({ exif })`). Owned by the returned object,
   * never a WASM-heap view.
   */
  exif?: Uint8Array;

  /**
   * EXIF orientation of the **stored** pixels (1–8, EXIF tag 274 semantics;
   * 1 = upright). Absent or 1 means no rotation is pending. libheif applies
   * `irot`/`imir` container transforms at decode — for those files this is
   * 1 and the pixels are upright. A value > 1 means the orientation comes
   * only from the Exif item: `convertHeic` applies it automatically unless
   * `applyOrientation: false`; raw `decode()` consumers get stored pixels
   * and must apply it themselves. Decoders that do not report orientation
   * may omit this field.
   */
  orientation?: number;
}

/**
 * Decoder contract used by {@link ConvertOptions.decoder} /
 * {@link ConvertManyOptions.decoder} and implemented by `LibheifDecoder`.
 *
 * Lifecycle rules followed by the library (implementations may rely on them):
 * - `initialize()` is called before every `decode()`; repeated/concurrent
 *   calls must be cheap (e.g. memoize the load promise).
 * - `decode()` is awaited before the library calls `free()`; the returned
 *   `DecodedImage` must therefore not reference decoder-owned memory that
 *   `free()` releases (copy pixels out, as `LibheifDecoder` does).
 * - `free()` is called at most once per conversion. Decoders **injected**
 *   via options are never freed by the library — the caller owns their
 *   lifetime.
 *
 * Concurrency: with `convertMany`, a single injected decoder is shared by
 * all concurrent conversions, so `decode()` must be safe to call concurrently
 * on one instance (no shared mutable state across in-flight decodes).
 */
export interface IHeicDecoder {
  /** Initializes the decoder (e.g. loading the WebAssembly module). */
  initialize(): Promise<void>;

  /**
   * Decodes HEIC binary data into raw RGBA pixel data; `onProgress`
   * receives the progress percentage.
   */
  decode(
    data: Uint8Array,
    onProgress?: (percent: number) => void
  ): Promise<DecodedImage>;

  /** Cleans up allocated resources. Idempotent: safe to call multiple times. */
  free(): void;
}

export type ImageFormat = 'jpeg' | 'jpg' | 'png' | 'svg' | 'webp' | 'avif';

/**
 * Formats accepted by {@link ConvertOptions.to} (case-insensitive).
 * `'jpg'` is an alias of `'jpeg'`. `'avif'` requires an environment whose
 * canvas can encode AVIF (Chromium/Firefox today); elsewhere it rejects with
 * `format_unsupported`.
 */
export const SUPPORTED_FORMATS: readonly ImageFormat[] = [
  'jpeg',
  'jpg',
  'png',
  'svg',
  'webp',
  'avif',
];

/** Default encoding quality used when `quality` is not provided. */
export const DEFAULT_QUALITY = 0.92;

/**
 * Accepted input for every convert entry point. `ArrayBufferView` is a
 * declared (tested) surface: `DataView` and non-Uint8 typed arrays are read
 * as raw bytes via byteOffset/byteLength, SharedArrayBuffer-backed views
 * included. Cross-realm Blob-likes (anything exposing `arrayBuffer()`, e.g.
 * a Blob from another frame) are accepted at runtime even though
 * `instanceof Blob` cannot see them.
 */
export type HeicInput = Blob | ArrayBuffer | ArrayBufferView;

/**
 * How {@link convertHeic} returns the converted image.
 * - `'blob'` — a `Blob` (the default; browser-native, works everywhere)
 * - `'dataUrl'` — a `data:image/...;base64,…` string (previews, `<img src>`)
 * - `'arrayBuffer'` — raw bytes (uploads, WebCodecs, Node-friendly transfer)
 */
export type OutputShape = 'blob' | 'dataUrl' | 'arrayBuffer';

/** Resolved return type of `convertHeic`/`convertMany` for an output shape. */
export type ConvertResult<S extends OutputShape> = S extends 'dataUrl'
  ? string
  : S extends 'arrayBuffer'
    ? ArrayBuffer
    : Blob;

/** Crop rectangle in **post-orientation display pixels** (top-left origin). */
export interface CropOptions {
  /** Left edge of the crop box. @default 0 */
  x?: number;
  /** Top edge of the crop box. @default 0 */
  y?: number;
  /** Crop width in pixels. Must be a positive integer and fit inside the image. */
  width: number;
  /** Crop height in pixels. Must be a positive integer and fit inside the image. */
  height: number;
}

/** Per-item outcome when `continueOnError: true`. */
export type ConvertItemResult<T = Blob> =
  | { index: number; ok: true; result: T }
  | { index: number; ok: false; error: Error };

export interface ResizeOptions {
  /**
   * Maximum width in pixels; downscaled to fit while preserving the aspect
   * ratio. Images smaller than the bound are never upscaled.
   */
  maxWidth?: number;

  /**
   * Maximum height in pixels; downscaled to fit while preserving the aspect
   * ratio. Images smaller than the bound are never upscaled.
   */
  maxHeight?: number;

  /**
   * Uniform scale factor for both dimensions (e.g. 0.5 halves the image).
   * Takes precedence over `maxWidth`/`maxHeight` when set.
   */
  scale?: number;
}

export interface ConvertOptions extends ResizeOptions {
  /**
   * Target format; must be one of {@link SUPPORTED_FORMATS}. An unknown
   * value is rejected up front, before the input is decoded.
   * @default 'jpeg'
   */
  to?: ImageFormat;

  /**
   * Quality between 0.0 and 1.0 (inclusive). Applies to `'jpeg'`, `'jpg'`,
   * `'webp'` and `'avif'` but is validated for every format: an out-of-range
   * value (e.g. `90` from a 0-100 scale) throws regardless of `to`.
   * @default 0.92
   */
  quality?: number;

  /**
   * Custom decoder to inject; a default `LibheifDecoder` is used otherwise.
   * The library never calls `free()` on an injected decoder.
   */
  decoder?: IHeicDecoder;

  /**
   * Progress callback receiving percentages normalized and clamped to
   * 0–100; the final 100% is emitted only when the conversion succeeds. A
   * callback that throws rejects the conversion with
   * `progress_callback_failed`.
   */
  onProgress?: (percent: number) => void;

  /**
   * Rotate/flip the output to match the source's EXIF orientation, applied
   * as a canvas transform during rendering; `irot`/`imir` container
   * transforms are already applied by the decoder and never stacked on top.
   * `false` keeps the exact stored-pixel geometry. A non-boolean value is
   * rejected up front with `invalid_input`.
   * @default true
   */
  applyOrientation?: boolean;

  /**
   * Representation of the converted image. See {@link OutputShape}.
   * @default 'blob'
   */
  output?: OutputShape;

  /**
   * Cancels the conversion at stage boundaries (input read, decoder init,
   * before/after decode, before encode). `convertHeicInWorker` aborts
   * immediately by terminating the worker; the synchronous WASM decode
   * itself cannot be preempted mid-call. An aborted signal rejects with
   * code `aborted`.
   */
  signal?: AbortSignal;

  /**
   * Crop rectangle in post-orientation display pixels (the geometry the
   * image will be displayed in). Applied before resize: `scale`/`maxWidth`/
   * `maxHeight` then downscale the cropped region. Out-of-bounds crops
   * reject with `invalid_crop`.
   */
  crop?: CropOptions;

  /**
   * Copy the source HEIC's EXIF block into JPEG (APP1) and PNG (`eXIf`
   * chunk) output so converted files keep camera metadata (orientation, GPS,
   * timestamps). This **preserves private data** like GPS — set
   * deliberately. Ignored for `webp`/`svg` output.
   * @default false
   */
  preserveExif?: boolean;

  /**
   * Decode with the platform's native HEIC stack (`createImageBitmap` on
   * Safari/iOS, Edge, Windows) instead of the bundled libheif WASM decoder,
   * skipping its ~300 KB payload. Hosts without native HEIC support fall
   * back to libheif on the same conversion; the refusal is cached per realm.
   * Ignored (libheif used) with an injected `decoder`, `preserveExif: true`
   * or `applyOrientation: false`. Native output is upright and progress
   * fires only at completion (tile progress is a libheif feature).
   * @default false
   */
  nativeDecode?: boolean;
}

export interface ConvertManyOptions extends Omit<ConvertOptions, 'onProgress'> {
  /**
   * Maximum number of conversions running concurrently.
   * @default 4
   */
  concurrency?: number;

  /**
   * Progress callback receiving the 0-based item index and its percentage
   * (normalized to 0–100) during decoding.
   */
  onProgress?: (index: number, percent: number) => void;

  /**
   * Custom decoder to inject; the same instance is shared by all concurrent
   * conversions, so it must be safe for concurrent `decode()` calls (see
   * {@link IHeicDecoder}). A fresh default `LibheifDecoder` is created per
   * item otherwise.
   */
  decoder?: IHeicDecoder;

  /**
   * Resolve with `ConvertItemResult[]` in input order instead of rejecting
   * the whole batch on the first failure; all items run to completion.
   * Up-front option validation failures still reject normally (a typo is a
   * caller bug, not an item failure).
   * @default false
   */
  continueOnError?: boolean;

  /**
   * Reuse one library-owned `LibheifDecoder` per concurrent runner across
   * items instead of creating (and WASM-initializing) a fresh instance per
   * item — amortizes the module load in large batches while preserving the
   * exclusive-use invariant (an instance is only ever held by one runner,
   * never decodes concurrently). Ignored when `decoder` is injected.
   * @default false
   */
  reuseDecoders?: boolean;
}
