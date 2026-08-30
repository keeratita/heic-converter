/**
 * Centralized error message templates used across the library.
 *
 * Static messages are plain strings; dynamic messages are template
 * functions that produce the final string at the call site.
 */
export const Messages = {
  // index.ts
  QualityInvalid: (value: unknown): string =>
    `Quality must be a number between 0.0 and 1.0, got: ${value}`,
  UnsupportedInputType: (type: string): string =>
    `Unsupported input type. Expected Blob, File, ArrayBuffer, or Uint8Array. Got: ${type}`,
  DecoderInitFailed: (message: string): string => `Failed to initialize HEIC decoder: ${message}`,
  RenderEncodeFailed: (format: string, message: string): string =>
    `Failed to render and encode image as ${format}: ${message}`,
  ConcurrencyInvalid: (value: unknown): string =>
    `Concurrency must be a positive integer, got: ${value}`,

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
    'Canvas is not supported in the current environment. ' +
    'Conversion requires a browser environment or canvas polyfills.',
  InvalidDimensions: (width: number, height: number): string =>
    `Invalid image dimensions: ${width}x${height}. Width and height must be positive integers.`,
  DataLengthMismatch: (expected: number, width: number, height: number, actual: number): string =>
    `Image data length mismatch. Expected ${expected} bytes for ${width}x${height}, got ${actual}`,
  ContextUnavailable: 'Failed to acquire 2D rendering context from canvas',
  UnsupportedFormat: (format: string): string => `Unsupported output format: ${format}`,

  // wasm/wrapper.ts
  DecodeFailed: 'HEIC decoding failed',
  DecodeFailedWithDetail: (detail: string): string => `HEIC decoding failed: ${detail}`,

  // worker.ts
  WorkerUnsupported: 'Web Worker is not supported in the current environment',
  WorkerCreateFailed: (message: string): string => `Failed to create Web Worker: ${message}`,
  WorkerPostFailed: (message: string): string => `Failed to post message to Web Worker: ${message}`,
  WorkerConversionFailed: 'Worker conversion failed',
  WorkerFailed: 'Worker failed',
  WorkerTimeout: 'Web Worker conversion timed out',

  // index.ts (convertMany)
  InputsMustBeArray: 'Inputs must be an array of HEIC images',
  ConvertManyItemFailed: (index: number, total: number, message: string): string =>
    `Conversion of item ${index} of ${total} failed: ${message}`,
} as const;
