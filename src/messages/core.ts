/**
 * Centralized error message templates used across the library.
 *
 * Static messages are plain strings; dynamic messages are template
 * functions that produce the final string at the call site. Keep all
 * user-facing error strings here (grouped by the file that throws them)
 * instead of inlining new ones.
 *
 * This module holds the strings the eagerly loaded graph throws — anything
 * `src/index.ts`, `src/validate.ts` or the render path touches. `Messages` is
 * one object literal, so an unused entry cannot be tree-shaken out of it:
 * worker-only strings live in `./worker` (`WorkerMessages`) and stay inside the
 * chunk a caller pays for only when they use those APIs. The rule is which
 * *chunk* throws the text, not which API it mentions — `WorkerChunkLoadFailed`
 * is here because `src/index.ts` throws it before the worker chunk exists.
 */
export const Messages = {
  // index.ts
  QualityInvalid: (value: unknown): string =>
    `Quality must be a number between 0.0 and 1.0, got: ${value}`,
  BooleanOptionInvalid: (name: string, value: unknown): string =>
    `${name} must be a boolean, got: ${value}`,
  UnsupportedInputType: (type: string): string =>
    `Unsupported input type. Expected Blob (incl. File), ArrayBuffer, or ArrayBufferView. Got: ${type}`,
  DecoderInitFailed: (message: string): string =>
    `Failed to initialize HEIC decoder: ${message} — verify heic-decoder.wasm is served (dist/heic-decoder.wasm; see the README "Serving and Locating WASM" section / locateFile option) and that your CSP allows 'wasm-unsafe-eval'`,
  WorkerChunkLoadFailed: (message: string): string =>
    `Failed to load the Web Worker implementation chunk (dist/worker-*.mjs): ${message} — deploy every file in dist/ together, or use convertHeic to convert in the current thread`,
  NativeChunkLoadWarning: (message: string): string =>
    '@keeratita/heic-converter: the native-decode chunk could not be loaded (' +
    `${message}) — converting with the bundled decoder; serve every file in dist/ together, ` +
    'with dist/native-*.mjs as JavaScript',
  RenderEncodeFailed: (format: string, message: string): string =>
    `Failed to render and encode image as ${format}: ${message}`,
  ConcurrencyInvalid: (value: unknown, max: number): string =>
    `Concurrency must be an integer between 1 and ${max}, got: ${value}`,
  InputsMustBeArray: 'Inputs must be an array of HEIC images',
  OutputShapeInvalid: (value: unknown): string =>
    `output must be one of 'blob', 'dataUrl', 'arrayBuffer', got: ${value}`,
  SignalInvalid: (value: unknown): string =>
    `signal must be an AbortSignal, got: ${value}`,
  Aborted: 'Conversion aborted (AbortSignal was aborted)',
  ConvertManyItemFailed: (index: number, total: number, message: string): string =>
    `Conversion of item ${index} of ${total} failed: ${message}`,
  /** The settled-completion tail: an entry the race recorded as ok yet carries no result. */
  BatchItemProducedNoResult: (index: number, total: number): string =>
    `Conversion of item ${index} of ${total} failed: item produced no result`,
  /** The unreachable tail: the race settled with nothing to show for it. Names no
   *  item, because there is no failing item to name. */
  BatchEndedWithoutSettling: (total: number): string =>
    `Batch ended without settling any of its ${total} items`,
  ConvertManyExtraFailures: (failedCount: number, total: number): string =>
    ` (${failedCount} of ${total} items failed in total)`,
  ConvertManyOtherErrors: (messages: string[]): string =>
    `; other errors: ${messages.join(' | ')}`,

  // render/canvas.ts
  ExifChunkLoadWarning:
    '@keeratita/heic-converter: the EXIF injector chunk could not be loaded — converted without ' +
    'metadata; serve every file in dist/ together, with dist/exif-*.mjs as JavaScript.',
  ScaleInvalid: (value: unknown): string =>
    `Scale must be a positive finite number, got: ${value}`,
  MaxWidthInvalid: (value: unknown): string =>
    `maxWidth must be a positive finite number, got: ${value}`,
  MaxHeightInvalid: (value: unknown): string =>
    `maxHeight must be a positive finite number, got: ${value}`,
  TargetSizeTooLarge: (width: number, height: number, max: number): string =>
    `Target image size ${width}x${height} exceeds the maximum supported dimension of ${max}px`,
  BlobToBase64FailedWithCause: (message: string): string =>
    `Failed to convert Blob to base64 string: ${message}`,
  CanvasToBlobFailed: (type: string): string =>
    `Failed to convert canvas to blob (type: ${type})`,
  CanvasUnsupported:
    'Canvas is not supported in the current environment. In a browser this requires ' +
    'OffscreenCanvas or HTMLCanvasElement. In Node.js there is no canvas: decode raw RGBA ' +
    'with LibheifDecoder and encode externally (see the Node.js section of the README).',
  InvalidDimensions: (width: number, height: number): string =>
    `Invalid image dimensions: ${width}x${height}. Width and height must be positive integers.`,
  DataLengthMismatch: (expected: number, width: number, height: number, actual: number): string =>
    `Image data length mismatch. Expected ${expected} bytes for ${width}x${height}, got ${actual}`,
  ContextUnavailable: 'Failed to acquire 2D rendering context from canvas',
  UnsupportedFormat: (format: string): string => `Unsupported output format: ${format}`,
  FormatUnsupported: (format: string): string =>
    `The current environment cannot encode '${format}' — canvas encoding produced no ` +
    `'${format}' image (e.g. AVIF encoding is not supported in this browser). Try 'jpeg', ` +
    `'png', or 'webp' instead.`,
  CropInvalid: (field: string, value: unknown): string =>
    `crop.${field} must be ${field === 'width' || field === 'height' ? 'a positive integer' : 'a non-negative integer'}, got: ${value}`,
  CropOutOfBounds: (
    x: number,
    y: number,
    width: number,
    height: number,
    displayWidth: number,
    displayHeight: number
  ): string =>
    `crop ${width}x${height} at (${x}, ${y}) exceeds the ${displayWidth}x${displayHeight} image ` +
    '(crop coordinates are in post-orientation display pixels)',

  // wasm/wrapper.ts
  GlueApiMissing: (missing: string): string =>
    `The bundled decoder glue is missing required APIs (${missing}) — deploy every file in dist/ ` +
    'from the same release; heic-decoder.wasm and its glue chunk must come from one build.',
  DecoderFreedDuringDecode:
    'Decoder was freed before decoding completed; call initialize() again.',
  DecodeInputAllocFailed: (bytes: number): string =>
    `Failed to allocate ${bytes} bytes in the WASM heap for decode input`,
  DecodeFailed: (bytes: number): string =>
    `HEIC decoding failed (no result returned; input: ${bytes} bytes — is the file truncated or empty?)`,
  DecodeFailedWithDetail: (detail: string, bytes: number): string =>
    `HEIC decoding failed: ${detail} (input: ${bytes} bytes)`,
  DecodeFaulted: (bytes: number): string =>
    `Decoder faulted on a ${bytes}-byte image (out of memory, or a corrupted WebAssembly instance); retry — a faulted pooled decoder is discarded, not reused`,
  ProgressCallbackThrew: (message: string): string =>
    `onProgress callback threw during decode: ${message}`,
} as const;
