import { LibheifDecoder } from './wasm';
import { renderAndEncode } from './render/canvas';
import { ConvertOptions } from './types';

export * from './types';
export { LibheifDecoder, LibheifDecoderOptions } from './wasm';

let sharedDecoder: LibheifDecoder | null = null;

/**
 * Releases the resources allocated for the shared default decoder instance.
 * Call this when no further HEIC conversions are needed to free memory.
 */
export function freeSharedDecoder(): void {
  if (sharedDecoder) {
    sharedDecoder.free();
    sharedDecoder = null;
  }
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

  // 3. Select decoder (user-injected or shared default)
  let decoder = options?.decoder;
  let isSharedDecoder = false;
  if (!decoder) {
    if (!sharedDecoder) {
      sharedDecoder = new LibheifDecoder();
    }
    decoder = sharedDecoder;
    isSharedDecoder = true;
  }

  // 4. Initialize and decode
  await decoder.initialize();
  const decoded = await decoder.decode(buffer, options?.onProgress);

  // 5. Render to canvas and encode to target format
  const format = options?.to || 'jpeg';
  const quality = options?.quality !== undefined ? options.quality : 0.92;

  try {
    return await renderAndEncode(decoded, format, quality);
  } finally {
    // Free decoder if it was a shared instance and no custom decoder was provided
    if (isSharedDecoder && !options?.decoder) {
      try {
        decoder.free();
      } catch {
        // Ignore errors from free() - decoder is still marked as freed
      }
      sharedDecoder = null;
    }
  }
}
