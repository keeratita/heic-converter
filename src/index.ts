import { LibheifDecoder } from './wasm';
import { renderAndEncode } from './render/canvas';
import type { ConvertOptions } from './types';

export * from './types';
export { LibheifDecoder, LibheifDecoderOptions } from './wasm';

/**
 * Releases any cached decoder resources.
 *
 * Decoders are now created and released per conversion, so there is no shared
 * instance to free. This function is kept for API compatibility.
 */
export function freeSharedDecoder(): void {
  // No-op: each conversion owns and frees its own decoder instance.
}

/**
 * Validates quality parameter is within acceptable range.
 * @param quality The quality value to validate.
 * @throws Error if quality is not between 0.0 and 1.0.
 */
function validateQuality(quality: number): void {
  if (typeof quality !== 'number' || Number.isNaN(quality) || quality < 0 || quality > 1) {
    throw new Error(`Quality must be a number between 0.0 and 1.0, got: ${quality}`);
  }
}

/**
 * Converts HEIC image data to a standard web format (JPEG, PNG, WebP, or SVG).
 *
 * @param input HEIC image as a Blob, File, ArrayBuffer, or Uint8Array.
 * @param options Conversion configuration options.
 * @returns A Promise resolving to the converted image as a Blob.
 */
export async function convertHeic(
  input: Blob | File | ArrayBuffer | Uint8Array,
  options?: ConvertOptions
): Promise<Blob> {
  // 1. Resolve input to a Uint8Array
  let buffer: Uint8Array;
  if (input instanceof Uint8Array) {
    buffer = input;
  } else if (input instanceof ArrayBuffer) {
    buffer = new Uint8Array(input);
  } else if (typeof Blob !== 'undefined' && input instanceof Blob) {
    const arrayBuffer = await input.arrayBuffer();
    buffer = new Uint8Array(arrayBuffer);
  } else {
    throw new Error(
      'Unsupported input type. Expected Blob, File, ArrayBuffer, or Uint8Array.'
    );
  }

  // 2. Validate quality parameter if provided
  if (options?.quality !== undefined) {
    validateQuality(options.quality);
  }

  // 3. Select decoder (user-injected or a fresh default instance).
  // A fresh instance is created per call so concurrent conversions never share
  // mutable WASM state, and it is always released in the finally block below.
  const decoder = options?.decoder ?? new LibheifDecoder();
  const ownsDecoder = !options?.decoder;

  try {
    // 4. Initialize and decode
    await decoder.initialize();
    const decoded = await decoder.decode(buffer, options?.onProgress);

    // 5. Render to canvas and encode to target format
    const format = options?.to || 'jpeg';
    const quality = options?.quality !== undefined ? options.quality : 0.92;

    return await renderAndEncode(decoded, format, quality);
  } finally {
    // Free the decoder only if we created it (never free a user-injected one).
    if (ownsDecoder) {
      try {
        decoder.free();
      } catch {
        // Ignore errors from free() - decoder is still marked as freed
      }
    }
  }
}
