import { LibheifDecoder } from './wasm';
import {
  renderAndEncode,
  validateResize,
  validateFormat,
  assertEncodeEnvironment,
} from './render/canvas';
import { Messages } from './messages';
import { HeicConverterError } from './errors';
import type { ConvertManyOptions, ConvertOptions, HeicInput } from './types';
import { DEFAULT_QUALITY } from './types';

export * from './types';
export { LibheifDecoder } from './wasm';
export type { LibheifDecoderOptions } from './wasm';
export { convertHeicInWorker } from './worker';
export type { WorkerConvertOptions, WorkerResultMessage, WorkerProgressMessage } from './worker';
export { HeicConverterError } from './errors';
export type { HeicConverterErrorCode } from './errors';

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
 * @throws HeicConverterError (code `invalid_quality`) if quality is not between 0.0 and 1.0.
 */
function validateQuality(quality: number): void {
  if (typeof quality !== 'number' || !Number.isFinite(quality) || quality < 0 || quality > 1) {
    throw new HeicConverterError('invalid_quality', Messages.QualityInvalid(quality));
  }
}

/**
 * Resolves any supported input form to a Uint8Array. Besides the typed
 * union (Uint8Array/ArrayBuffer/Blob), accepts cross-realm Blob-likes
 * (iframes, Electron, polyfills — detected via `arrayBuffer()`) and other
 * ArrayBufferViews (DataView, SharedArrayBuffer-backed views).
 */
async function resolveInputBytes(input: HeicInput): Promise<Uint8Array> {
  if (input instanceof Uint8Array) {
    return input;
  }
  if (input instanceof ArrayBuffer) {
    return new Uint8Array(input);
  }
  if (typeof Blob !== 'undefined' && input instanceof Blob) {
    return new Uint8Array(await input.arrayBuffer());
  }
  // Duck-typed Blob/File from another realm: instanceof fails but the
  // arrayBuffer() method is present and behaves identically.
  if (
    input !== null &&
    typeof input === 'object' &&
    typeof (input as { arrayBuffer?: unknown }).arrayBuffer === 'function'
  ) {
    const arrayBuffer = await (input as Blob).arrayBuffer();
    if (arrayBuffer instanceof ArrayBuffer) {
      return new Uint8Array(arrayBuffer);
    }
  }
  // Other ArrayBufferViews (DataView, Uint16Array, SharedArrayBuffer-backed).
  if (ArrayBuffer.isView(input)) {
    const view = input as ArrayBufferView;
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  }
  throw new HeicConverterError(
    'invalid_input',
    Messages.UnsupportedInputType(Object.prototype.toString.call(input))
  );
}

/**
 * Wraps a host onProgress callback so the documented contract holds on every
 * execution path: values are normalized to finite numbers clamped to 0-100,
 * and a throwing callback can never break the conversion plumbing.
 */
function normalizeProgressCallback(
  onProgress?: (percent: number) => void
): ((percent: number) => void) | undefined {
  // Tolerate non-function values (e.g. null) by treating them as absent,
  // matching the pre-normalization behavior where the decoder probed
  // typeof before invoking.
  if (typeof onProgress !== 'function') {
    return undefined;
  }
  return (percent: number): void => {
    const numeric = Number(percent);
    onProgress(Number.isFinite(numeric) ? Math.min(100, Math.max(0, numeric)) : 0);
  };
}

/**
 * Converts HEIC image data to a standard web format (JPEG, PNG, WebP, or SVG).
 *
 * @param input HEIC image as a Blob, File, ArrayBuffer, or Uint8Array.
 * @param options Conversion configuration options.
 * @returns A Promise resolving to the converted image as a Blob.
 * @throws HeicConverterError with a machine-readable `code`:
 *   `invalid_input` (unsupported input type), `invalid_quality`,
 *   `invalid_resize`, `invalid_format` (unknown `to` value),
 *   `decoder_init_failed` (WASM module could not load), `decode_failed`
 *   (invalid/corrupt HEIC), `unsupported_environment` (no canvas APIs —
 *   e.g. Node.js, where raw RGBA decoding via `LibheifDecoder` is the
 *   supported path), or `render_encode_failed`.
 */
export async function convertHeic(
  input: HeicInput,
  options?: ConvertOptions
): Promise<Blob> {
  // 1. Validate options before touching the input so invalid values fail
  // fast without reading (or decoding) the potentially large file.
  if (options?.quality !== undefined) {
    validateQuality(options.quality);
  }
  const format = options?.to ?? 'jpeg';
  validateFormat(format);
  const resizeOptions =
    options?.maxWidth !== undefined || options?.maxHeight !== undefined || options?.scale !== undefined
      ? options
      : undefined;
  validateResize(resizeOptions);
  // Fail before the (expensive) WASM download + decode when the environment
  // cannot encode — the top-level error names the real cause (no canvas)
  // instead of a wrapped decode-stage failure.
  assertEncodeEnvironment();

  // 2. Resolve input to a Uint8Array
  const buffer = await resolveInputBytes(input);

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
      throw new HeicConverterError(
        'decoder_init_failed',
        Messages.DecoderInitFailed(error instanceof Error ? error.message : String(error)),
        { cause: error }
      );
    }

    const decoded = await decoder.decode(buffer, normalizeProgressCallback(options?.onProgress));

    // Decoded pixel data is independent of the WASM heap (see LibheifDecoder),
    // so the decoder can be released before the render/encode stage.
    freeDecoder();

    // 5. Render to canvas and encode to target format
    const quality = options?.quality !== undefined ? options.quality : DEFAULT_QUALITY;

    try {
      if (resizeOptions) {
        // Pass the original options through: computeTargetSize re-validates
        // resize fields for direct callers; validating here (step 1) makes
        // invalid values fail before the input is read.
        return await renderAndEncode(decoded, format, quality, resizeOptions);
      }
      return await renderAndEncode(decoded, format, quality);
    } catch (error) {
      throw new HeicConverterError(
        'render_encode_failed',
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
 * conversions are allowed to finish in the background). The rejection is a
 * HeicConverterError (code `batch_item_failed`) whose message names the
 * first failing item (1-based in the message; the structured fields are
 * 0-based) and which carries `itemIndex`, `itemTotal`, and `failedCount`.
 * Completed items are not returned — a batch is all-or-nothing.
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
    throw new HeicConverterError('invalid_input', Messages.InputsMustBeArray);
  }

  const concurrency = options?.concurrency ?? 4;
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new HeicConverterError('invalid_concurrency', Messages.ConcurrencyInvalid(concurrency));
  }

  const results: Blob[] = new Array(inputs.length);
  // Destructure once so batch-only knobs (concurrency) never leak into the
  // per-item ConvertOptions spread.
  const { concurrency: _concurrency, onProgress, ...itemOptions } = options ?? {};
  let nextIndex = 0;
  let failed = false;
  let firstError: unknown = null;
  let firstErrorIndex = -1;
  let failedCount = 0;
  const otherErrorMessages: string[] = [];
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
          ...itemOptions,
          onProgress:
            onProgress !== undefined ? (percent: number) => onProgress(index, percent) : undefined,
        });
      } catch (error) {
        failedCount += 1;
        if (!failed) {
          failed = true;
          firstError = error;
          firstErrorIndex = index;
          notifyError?.();
        } else if (otherErrorMessages.length < 2) {
          // Keep a couple of extra messages so "one bad file" is
          // distinguishable from "a systemic problem" without dumping all.
          otherErrorMessages.push(error instanceof Error ? error.message : String(error));
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
    let text = Messages.ConvertManyItemFailed(firstErrorIndex + 1, inputs.length, message);
    if (failedCount > 1) {
      text += Messages.ConvertManyExtraFailures(failedCount, inputs.length);
      if (otherErrorMessages.length > 0) {
        text += `; other errors: ${otherErrorMessages.join(' | ')}`;
      }
    }
    throw new HeicConverterError('batch_item_failed', text, {
      cause: firstError,
      itemIndex: firstErrorIndex,
      itemTotal: inputs.length,
      failedCount,
    });
  }
  return results;
}
