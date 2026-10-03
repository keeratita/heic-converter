/**
 * Centralized error message templates used across the library.
 *
 * Static messages are plain strings; dynamic messages are template
 * functions that produce the final string at the call site. Keep all
 * user-facing error strings here (grouped by the file that throws them)
 * instead of inlining new ones.
 */
export const Messages = {
  // index.ts
  QualityInvalid: (value: unknown): string =>
    `Quality must be a number between 0.0 and 1.0, got: ${value}`,
  ApplyOrientationInvalid: (value: unknown): string =>
    `applyOrientation must be a boolean, got: ${value}`,
  UnsupportedInputType: (type: string): string =>
    `Unsupported input type. Expected Blob, File, ArrayBuffer, or Uint8Array. Got: ${type}`,
  DecoderInitFailed: (message: string): string =>
    `Failed to initialize HEIC decoder: ${message} — verify heic-decoder.wasm is served (dist/heic-decoder.wasm; see the README "Serving and Locating WASM" section / locateFile option) and that your CSP allows 'wasm-unsafe-eval'`,
  RenderEncodeFailed: (format: string, message: string): string =>
    `Failed to render and encode image as ${format}: ${message}`,
  ConcurrencyInvalid: (value: unknown): string =>
    `Concurrency must be a positive integer, got: ${value}`,
  MaxConcurrentWorkersInvalid: (value: unknown): string =>
    `maxConcurrentWorkers must be a positive integer, got: ${value}`,
  TimeoutInvalid: (value: unknown): string =>
    `timeoutMs must be a finite number >= 0 (0 disables the timeout), got: ${value}`,
  InputsMustBeArray: 'Inputs must be an array of HEIC images',
  OutputShapeInvalid: (value: unknown): string =>
    `output must be one of 'blob', 'dataUrl', 'arrayBuffer', got: ${value}`,
  ReuseDecodersInvalid: (value: unknown): string =>
    `reuseDecoders must be a boolean, got: ${value}`,
  ContinueOnErrorInvalid: (value: unknown): string =>
    `continueOnError must be a boolean, got: ${value}`,
  PreserveExifInvalid: (value: unknown): string =>
    `preserveExif must be a boolean, got: ${value}`,
  SignalInvalid: (value: unknown): string =>
    `signal must be an AbortSignal, got: ${value}`,
  Aborted: 'Conversion aborted (AbortSignal was aborted)',
  ConvertManyItemFailed: (index: number, total: number, message: string): string =>
    `Conversion of item ${index} of ${total} failed: ${message}`,
  ConvertManyExtraFailures: (failedCount: number, total: number): string =>
    ` (${failedCount} of ${total} items failed in total)`,
  ConvertManyOtherErrors: (messages: string[]): string =>
    `; other errors: ${messages.join(' | ')}`,
  BatchItemProducedNoResult: (index: number | undefined): string =>
    `Item ${String(index)} produced no result`,
  BatchEndedWithoutResult: 'Batch ended without a result',

  // render/canvas.ts
  ScaleInvalid: (value: unknown): string =>
    `Scale must be a positive finite number, got: ${value}`,
  MaxWidthInvalid: (value: unknown): string =>
    `maxWidth must be a positive finite number, got: ${value}`,
  MaxHeightInvalid: (value: unknown): string =>
    `maxHeight must be a positive finite number, got: ${value}`,
  TargetSizeTooLarge: (width: number, height: number, max: number): string =>
    `Target image size ${width}x${height} exceeds the maximum supported dimension of ${max}px`,
  BlobToBase64Failed: 'Failed to convert Blob to base64 string',
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
  DecoderFreedDuringDecode:
    'Decoder was freed before decoding completed; call initialize() again.',
  DecodeInputAllocFailed: (bytes: number): string =>
    `Failed to allocate ${bytes} bytes in the WASM heap for decode input`,
  DecodeFailed: (bytes: number): string =>
    `HEIC decoding failed (no result returned; input: ${bytes} bytes — is the file truncated or empty?)`,
  DecodeFailedWithDetail: (detail: string, bytes: number): string =>
    `HEIC decoding failed: ${detail} (input: ${bytes} bytes)`,
  ProgressCallbackThrew: (message: string): string =>
    `onProgress callback threw during decode: ${message}`,

  // worker.ts
  WorkerUnsupported: 'Web Worker is not supported in the current environment',
  WorkerCreateFailed: (message: string): string => `Failed to create Web Worker: ${message}`,
  WorkerPostFailed: (message: string): string => `Failed to post message to Web Worker: ${message}`,
  WorkerConversionFailed: 'Worker conversion failed',
  WorkerDecoderUnsupported:
    'The decoder option is not supported by convertHeicInWorker: the worker creates its own ' +
    'decoder (functions and class instances cannot cross the worker boundary). Use convertHeic ' +
    'with an injected decoder instead.',
  WorkerFailed: (workerUrl?: string | URL): string =>
    'Worker failed' +
    (workerUrl !== undefined
      ? ` (could not load worker script at ${String(workerUrl)}; check the path resolves and the ` +
        'script is served as JavaScript, e.g. Content-Type: text/javascript)'
      : ''),
  WorkerTimeout: (
    timeoutMs: number,
    stats: {
      progressMessages: number;
      lastPercent?: number;
      unknownType?: string;
      workerUrl?: string | URL;
    }
  ): string => {
    const details: string[] = [`${stats.progressMessages} progress message(s) received`];
    if (stats.lastPercent !== undefined) {
      details.push(`last percent ${stats.lastPercent}`);
    }
    if (stats.unknownType !== undefined) {
      details.push(`last unknown message type '${stats.unknownType}' (worker may not implement the progress/result protocol)`);
    }
    if (stats.workerUrl !== undefined) {
      details.push(`worker ${String(stats.workerUrl)}`);
    }
    return (
      `Web Worker conversion timed out after ${timeoutMs}ms (${details.join('; ')}). ` +
      'Increase timeoutMs for large images, set timeoutMs to 0 to disable the timeout, and ' +
      'verify the worker script implements the { type: "progress" | "result" } protocol.'
    );
  },
} as const;
