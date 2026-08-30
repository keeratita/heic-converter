import { LibheifDecoder } from './wasm';
import { renderAndEncode, validateResize } from './render/canvas';
import { Messages } from './messages';
import type { ConvertManyOptions, ConvertOptions, HeicInput } from './types';

export * from './types';
export { LibheifDecoder, LibheifDecoderOptions } from './wasm';
export { convertHeicInWorker } from './worker';
export type { WorkerConvertOptions } from './worker';

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
    throw new Error(Messages.QualityInvalid(quality));
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
  input: HeicInput,
  options?: ConvertOptions
): Promise<Blob> {
  // 1. Validate options before touching the input so invalid values fail
  // fast without reading the (potentially large) file into memory.
  if (options?.quality !== undefined) {
    validateQuality(options.quality);
  }
  const resize =
    options?.maxWidth !== undefined || options?.maxHeight !== undefined || options?.scale !== undefined
      ? options
      : undefined;
  validateResize(resize);

  // 2. Resolve input to a Uint8Array
  let buffer: Uint8Array;
  if (input instanceof Uint8Array) {
    buffer = input;
  } else if (input instanceof ArrayBuffer) {
    buffer = new Uint8Array(input);
  } else if (typeof Blob !== 'undefined' && input instanceof Blob) {
    const arrayBuffer = await input.arrayBuffer();
    buffer = new Uint8Array(arrayBuffer);
  } else {
    throw new Error(Messages.UnsupportedInputType(Object.prototype.toString.call(input)));
  }

  // 3. Select decoder (user-injected or a fresh default instance).
  // A fresh instance is created per call so concurrent conversions never share
  // mutable WASM state, and it is always released when this call completes.
  const decoder = options?.decoder ?? new LibheifDecoder();
  const ownsDecoder = !options?.decoder;

  // Free the decoder at most once, and only if we created it (never free a
  // user-injected decoder). It is released right after decode() to free WASM
  // memory before the memory-hungry render/encode stage, and again in finally
  // as a safety net for early failures (free() is idempotent).
  let decoderFreed = false;
  const freeDecoder = (): void => {
    if (!ownsDecoder || decoderFreed) {
      return;
    }
    decoderFreed = true;
    try {
      decoder.free();
    } catch {
      // Best-effort cleanup; there is nothing actionable if free() fails.
    }
  };

  try {
    // 4. Initialize and decode
    try {
      await decoder.initialize();
    } catch (error) {
      throw new Error(
        Messages.DecoderInitFailed(error instanceof Error ? error.message : String(error)),
        { cause: error }
      );
    }

    const decoded = await decoder.decode(buffer, options?.onProgress);

    // Decoded pixel data is an independent copy (not a view into WASM memory),
    // so the decoder can be released before the render/encode stage.
    freeDecoder();

    // 5. Render to canvas and encode to target format
    const format = options?.to || 'jpeg';
    const quality = options?.quality !== undefined ? options.quality : 0.92;

    try {
      if (resize) {
        return await renderAndEncode(decoded, format, quality, resize);
      }
      return await renderAndEncode(decoded, format, quality);
    } catch (error) {
      throw new Error(
        Messages.RenderEncodeFailed(
          format,
          error instanceof Error ? error.message : String(error)
        ),
        { cause: error }
      );
    }
  } finally {
    freeDecoder();
  }
}

/**
 * Converts multiple HEIC images to a standard web format.
 *
 * Conversions run with a bounded concurrency (default 4) and results are
 * returned in the same order as the inputs. If any conversion fails, the
 * returned promise rejects as soon as the failure is known (in-flight
 * conversions are allowed to finish in the background) with an error that
 * identifies the failing item index.
 *
 * @param inputs HEIC images as Blobs, Files, ArrayBuffers, or Uint8Arrays.
 * @param options Batch conversion options.
 * @returns A Promise resolving to the converted images as Blobs, in input order.
 */
export async function convertMany(
  inputs: HeicInput[],
  options?: ConvertManyOptions
): Promise<Blob[]> {
  if (!Array.isArray(inputs)) {
    throw new Error(Messages.InputsMustBeArray);
  }

  const concurrency = options?.concurrency ?? 4;
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error(Messages.ConcurrencyInvalid(concurrency));
  }

  const results: Blob[] = new Array(inputs.length);
  const onProgress = options?.onProgress;
  let nextIndex = 0;
  let failed = false;
  let firstError: unknown = null;
  let firstErrorIndex = -1;
  let notifyError: (() => void) | undefined;
  const errorNotifier = new Promise<void>((resolve) => {
    notifyError = resolve;
  });

  const runItem = async (): Promise<void> => {
    while (!failed) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= inputs.length) {
        return;
      }
      try {
        results[index] = await convertHeic(inputs[index], {
          ...options,
          onProgress:
            onProgress !== undefined ? (percent: number) => onProgress(index, percent) : undefined,
        });
      } catch (error) {
        if (!failed) {
          failed = true;
          firstError = error;
          firstErrorIndex = index;
          notifyError?.();
        }
      }
    }
  };

  const runnerCount = Math.min(concurrency, inputs.length);
  const runners = Array.from({ length: runnerCount }, () => runItem());

  // Reject as soon as the first failure is known instead of waiting for
  // in-flight conversions to complete; they settle in the background and
  // each releases its own decoder.
  await Promise.race([Promise.all(runners), errorNotifier]);

  if (failed) {
    const message = firstError instanceof Error ? firstError.message : String(firstError);
    throw new Error(
      Messages.ConvertManyItemFailed(firstErrorIndex + 1, inputs.length, message),
      { cause: firstError }
    );
  }
  return results;
}
