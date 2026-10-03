import { LibheifDecoder } from './wasm';
import {
  renderAndEncode,
  validateResize,
  validateFormat,
  assertEncodeEnvironment,
} from './render/canvas';
import { Messages } from './messages';
import { clampPercent } from './progress';
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
 * Validates the applyOrientation flag up front (must be boolean when
 * present), so a typo surfaces as `invalid_input` before any decode work
 * instead of being silently ignored.
 */
function validateApplyOrientation(applyOrientation: unknown): void {
  if (applyOrientation !== undefined && typeof applyOrientation !== 'boolean') {
    throw new HeicConverterError('invalid_input', Messages.ApplyOrientationInvalid(applyOrientation));
  }
}

/**
 * Resolves any supported input form to a Uint8Array, including cross-realm
 * Blob-likes (detected via `arrayBuffer()`) and other ArrayBufferViews.
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
  // Cross-realm Blob/File: instanceof fails, so duck-type on arrayBuffer().
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
 * Host onProgress wrapper enforcing the callback contract on every path:
 * values are clamped to 0-100, a throwing host callback never breaks the
 * pipeline (it is recorded and surfaced as `progress_callback_failed`), and
 * 100% is withheld until `complete()` confirms success — a failed conversion
 * never reports completion.
 */
function createProgressReporter(
  onProgress?: (percent: number) => void
): { report: (percent: number) => void; complete: () => void } | undefined {
  // Non-function values (e.g. null) are treated as absent.
  if (typeof onProgress !== 'function') {
    return undefined;
  }
  let done = false;
  let hostError: unknown;
  const invokeHost = (percent: number): void => {
    try {
      onProgress(percent);
    } catch (error) {
      throw new HeicConverterError(
        'progress_callback_failed',
        Messages.ProgressCallbackThrew(error instanceof Error ? error.message : String(error)),
        { cause: error }
      );
    }
  };
  return {
    report: (percent: number): void => {
      if (done) {
        return;
      }
      const value = clampPercent(percent);
      if (value >= 100) {
        return; // withheld; emitted by complete()
      }
      try {
        onProgress(value);
      } catch (error) {
        hostError = hostError ?? error;
      }
    },
    complete: (): void => {
      if (done) {
        return;
      }
      done = true;
      if (hostError !== undefined) {
        throw new HeicConverterError(
          'progress_callback_failed',
          Messages.ProgressCallbackThrew(
            hostError instanceof Error ? hostError.message : String(hostError)
          ),
          { cause: hostError }
        );
      }
      invokeHost(100);
    },
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
  // 1. Validate options first so invalid values fail before any I/O or decode.
  if (options?.quality !== undefined) {
    validateQuality(options.quality);
  }
  validateApplyOrientation(options?.applyOrientation);
  const format = options?.to ?? 'jpeg';
  validateFormat(format);
  const resizeOptions =
    options?.maxWidth !== undefined || options?.maxHeight !== undefined || options?.scale !== undefined
      ? options
      : undefined;
  validateResize(resizeOptions);
  // Probe the environment before the expensive WASM load so the error names
  // the real cause (no canvas) instead of a decode-stage failure.
  assertEncodeEnvironment();

  // 2. Resolve input to a Uint8Array
  const buffer = await resolveInputBytes(input);

  // 3. Select decoder (user-injected or a fresh per-call instance, so
  // concurrent conversions never share mutable WASM state).
  const decoder = options?.decoder ?? new LibheifDecoder();
  const ownsDecoder = !options?.decoder;

  // Release the owned decoder right after decode() (before the memory-hungry
  // render/encode stage) and again in finally; never free a user-injected one.
  // free() is idempotent.
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

    const progress = createProgressReporter(options?.onProgress);
    const decoded = await decoder.decode(buffer, progress ? progress.report : undefined);

    // Pixel data is heap-independent (see LibheifDecoder), so freeing the
    // decoder here is safe.
    freeDecoder();

    // 5. Render to canvas and encode to target format
    const quality = options?.quality !== undefined ? options.quality : DEFAULT_QUALITY;

    let blob: Blob;
    try {
      blob = await renderAndEncode(
        decoded,
        format,
        quality,
        resizeOptions,
        options?.applyOrientation ?? true
      );
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
    progress?.complete(); // emits the withheld 100% (or the recorded host error)
    return blob;
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

  // Validate the shared options once, up front, so invalid values (and a
  // canvas-less environment) surface their own error code instead of being
  // wrapped in batch_item_failed by the first failing item.
  validateFormat(options?.to ?? 'jpeg');
  if (options?.quality !== undefined) {
    validateQuality(options.quality);
  }
  validateApplyOrientation(options?.applyOrientation);
  validateResize(
    options?.maxWidth !== undefined || options?.maxHeight !== undefined || options?.scale !== undefined
      ? options
      : undefined
  );
  assertEncodeEnvironment();

  const results: Blob[] = new Array(inputs.length);
  // Keep batch-only knobs out of the per-item options spread.
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
          // Cap at two extra messages: distinguishes one bad file from a
          // systemic failure without dumping the whole batch.
          otherErrorMessages.push(error instanceof Error ? error.message : String(error));
        }
      }
    }
  };

  const runnerCount = Math.min(concurrency, inputs.length);
  const runners = Array.from({ length: runnerCount }, () => runItem());

  // Reject on the first failure; in-flight items settle in the background
  // and release their own decoders.
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
