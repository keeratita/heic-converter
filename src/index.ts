import { LibheifDecoder } from './wasm';
import {
  renderAndEncode,
  validateResize,
  validateCrop,
  validateFormat,
  assertEncodeEnvironment,
  blobToBase64,
} from './render/canvas';
import { Messages } from './messages';
import { clampPercent } from './progress';
import { HeicConverterError } from './errors';
import { runBoundedBatch } from './batch';
import {
  throwIfAborted,
  validateApplyOrientation,
  validateContinueOnError,
  validateOutputShape,
  validatePreserveExif,
  validateQuality,
  validateReuseDecoders,
  validateSignal,
} from './validate';
import type {
  ConvertItemResult,
  ConvertManyOptions,
  ConvertOptions,
  ConvertResult,
  HeicInput,
  OutputShape,
} from './types';
import { DEFAULT_QUALITY } from './types';

export * from './types';
export { LibheifDecoder } from './wasm';
export type { LibheifDecoderOptions } from './wasm';
export { convertHeicInWorker, convertManyInWorker } from './worker';
export type {
  WorkerConvertOptions,
  WorkerBatchOptions,
  WorkerResultMessage,
  WorkerProgressMessage,
} from './worker';
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
 * Converts a Blob to the requested output representation. The base64 path
 * reuses the canvas module's FileReader/btoa helper.
 */
async function shapeOutput<S extends OutputShape>(blob: Blob, output: S): Promise<ConvertResult<S>> {
  if (output === 'dataUrl') {
    return (await blobToBase64(blob)) as ConvertResult<S>;
  }
  if (output === 'arrayBuffer') {
    return (await blob.arrayBuffer()) as ConvertResult<S>;
  }
  return blob as ConvertResult<S>;
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
 * Converts HEIC image data to a standard web format (JPEG, PNG, WebP, AVIF,
 * or SVG).
 *
 * @param input HEIC image as a Blob, File, ArrayBuffer, or Uint8Array.
 * @param options Conversion configuration options (see {@link ConvertOptions}).
 * @returns The converted image as a Blob, data URL string, or ArrayBuffer
 *   depending on `options.output` (default Blob).
 * @throws HeicConverterError with a machine-readable `code`:
 *   `invalid_input` (unsupported input type or option value),
 *   `invalid_quality`, `invalid_resize`, `invalid_crop`,
 *   `invalid_format` (unknown `to` value), `decoder_init_failed` (WASM
 *   module could not load), `decode_failed` (invalid/corrupt HEIC),
 *   `unsupported_environment` (no canvas APIs — e.g. Node.js, where raw RGBA
 *   decoding via `LibheifDecoder` is the supported path),
 *   `format_unsupported` (environment cannot encode the format, e.g. AVIF
 *   in Safari), `aborted` (`options.signal` aborted), or
 *   `render_encode_failed`.
 */
export async function convertHeic<S extends OutputShape = 'blob'>(
  input: HeicInput,
  options?: ConvertOptions & { output?: S }
): Promise<ConvertResult<S>> {
  // 1. Validate options first so invalid values fail before any I/O or decode.
  if (options?.quality !== undefined) {
    validateQuality(options.quality);
  }
  validateApplyOrientation(options?.applyOrientation);
  validateOutputShape(options?.output);
  validateSignal(options?.signal);
  validateCrop(options?.crop);
  validatePreserveExif(options?.preserveExif);
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
  const signal = options?.signal;
  throwIfAborted(signal);

  // 2. Resolve input to a Uint8Array
  const buffer = await resolveInputBytes(input);
  throwIfAborted(signal);

  // 3. Select decoder (user-injected, a pooled instance injected by
  // convertMany, or a fresh per-call instance, so concurrent conversions
  // never share mutable WASM state).
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
    throwIfAborted(signal);

    const progress = createProgressReporter(options?.onProgress);
    const decoded = await decoder.decode(buffer, progress ? progress.report : undefined);

    // Pixel data is heap-independent (see LibheifDecoder), so freeing the
    // decoder here is safe.
    freeDecoder();
    throwIfAborted(signal);

    // 5. Render to canvas and encode to target format
    const quality = options?.quality !== undefined ? options.quality : DEFAULT_QUALITY;

    let blob: Blob;
    try {
      blob = await renderAndEncode(
        decoded,
        format,
        quality,
        resizeOptions,
        options?.applyOrientation ?? true,
        options?.crop,
        options?.preserveExif ?? false
      );
    } catch (error) {
      // Pass library errors through unchanged so their specific code
      // (invalid_crop, format_unsupported, ...) survives; wrap anything else.
      if (error instanceof HeicConverterError) {
        throw error;
      }
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
    throwIfAborted(signal);
    return shapeOutput(blob, (options?.output ?? 'blob') as S);
  } finally {
    freeDecoder();
  }
}

/**
 * Pool of library-owned decoder instances shared across the runners of one
 * `convertMany` batch (`reuseDecoders: true`). Each in-use instance belongs
 * to exactly one item at a time — the exclusive-use invariant of the
 * per-conversion path is preserved; only the creation (WASM init/free) cost
 * is amortized. `dispose()` is safe to call while items are still running:
 * leased instances are freed when they come back.
 */
class DecoderPool {
  private readonly max: number;
  private readonly idle: LibheifDecoder[] = [];
  private readonly waiters: Array<(decoder: LibheifDecoder) => void> = [];
  private leasedCount = 0;
  private disposed = false;

  constructor(max: number) {
    this.max = Math.max(1, max);
  }

  async acquire(): Promise<LibheifDecoder> {
    const idle = this.idle.pop();
    if (idle) {
      return idle;
    }
    if (this.leasedCount < this.max) {
      this.leasedCount += 1;
      return new LibheifDecoder();
    }
    return new Promise<LibheifDecoder>((resolve) => this.waiters.push(resolve));
  }

  release(decoder: LibheifDecoder): void {
    if (this.disposed) {
      try {
        decoder.free();
      } catch {
        // Best-effort cleanup.
      }
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(decoder);
    } else {
      this.idle.push(decoder);
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const decoder of this.idle) {
      try {
        decoder.free();
      } catch {
        // Best-effort cleanup.
      }
    }
    this.idle.length = 0;
  }
}

export function convertMany<S extends OutputShape = 'blob'>(
  inputs: HeicInput[],
  options: ConvertManyOptions & { output?: S; continueOnError: true }
): Promise<ConvertItemResult<ConvertResult<S>>[]>;
export function convertMany<S extends OutputShape = 'blob'>(
  inputs: HeicInput[],
  options?: ConvertManyOptions & { output?: S }
): Promise<ConvertResult<S>[]>;
/**
 * Converts multiple HEIC images to a standard web format.
 *
 * Conversions run with a bounded concurrency (default 4) and results are
 * returned in the same order as the inputs. By default, if any conversion
 * fails, the returned promise rejects as soon as the failure is known
 * (in-flight conversions are allowed to finish in the background) with a
 * `batch_item_failed` HeicConverterError carrying `itemIndex`, `itemTotal`,
 * and `failedCount` — a batch is all-or-nothing. With
 * `options.continueOnError: true` the promise instead fulfills with
 * per-item `ConvertItemResult` entries and all items run to completion.
 *
 * @param inputs HEIC images as Blobs, Files, ArrayBuffers, or Uint8Arrays.
 * @param options Batch conversion options (see {@link ConvertManyOptions}).
 * @returns The converted images in input order: results array by default,
 *   or per-item result entries when `continueOnError: true`.
 */
export async function convertMany<S extends OutputShape = 'blob'>(
  inputs: HeicInput[],
  options?: ConvertManyOptions & { output?: S }
): Promise<ConvertResult<S>[] | ConvertItemResult<ConvertResult<S>>[]> {
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
  validateOutputShape(options?.output);
  validateSignal(options?.signal);
  validateCrop(options?.crop);
  validatePreserveExif(options?.preserveExif);
  validateReuseDecoders(options?.reuseDecoders);
  validateContinueOnError(options?.continueOnError);
  validateResize(
    options?.maxWidth !== undefined || options?.maxHeight !== undefined || options?.scale !== undefined
      ? options
      : undefined
  );
  assertEncodeEnvironment();

  // Keep batch-only knobs out of the per-item options spread.
  const {
    concurrency: _concurrency,
    onProgress,
    continueOnError: _continueOnError,
    reuseDecoders,
    ...itemOptions
  } = options ?? {};

  const usePool = reuseDecoders === true && options?.decoder === undefined;
  const pool = usePool ? new DecoderPool(Math.min(concurrency, inputs.length)) : null;

  try {
    return (await runBoundedBatch<ConvertResult<S>>(
      inputs,
      concurrency,
      async (input, index) => {
        const leased = pool ? await pool.acquire() : null;
        try {
          return await convertHeic<S>(input as HeicInput, {
            ...itemOptions,
            ...(leased ? { decoder: leased } : {}),
            onProgress:
              onProgress !== undefined
                ? (percent: number) => onProgress(index, percent)
                : undefined,
          });
        } finally {
          if (leased) {
            pool!.release(leased);
          }
        }
      },
      { continueOnError: options?.continueOnError === true, signal: options?.signal }
    )) as ConvertResult<S>[] | ConvertItemResult<ConvertResult<S>>[];
  } finally {
    pool?.dispose();
  }
}
