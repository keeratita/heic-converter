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
 * Converts HEIC image data to a standard web format (JPEG, PNG, or SVG).
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

  // 2. Select decoder (user-injected or shared default)
  let decoder = options?.decoder;
  if (!decoder) {
    if (!sharedDecoder) {
      sharedDecoder = new LibheifDecoder();
    }
    decoder = sharedDecoder;
  }

  // 3. Initialize and decode
  await decoder.initialize();
  const decoded = await decoder.decode(buffer, options?.onProgress);

  // 4. Render to canvas and encode to target format
  const format = options?.to || 'jpeg';
  const quality = options?.quality !== undefined ? options.quality : 0.92;

  return renderAndEncode(decoded, format, quality);
}
