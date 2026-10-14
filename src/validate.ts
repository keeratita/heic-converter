import { Messages } from './messages/core';
import { HeicConverterError } from './errors';
import { SUPPORTED_FORMATS } from './types';
import type { CropOptions, ImageFormat, ResizeOptions } from './types';

/**
 * Option validators shared by `index.ts` (convertHeic/convertMany) and
 * `worker.ts` (the *InWorker APIs perform the same up-front checks so a
 * typo surfaces its own error code on the main thread instead of coming
 * back stringified as worker_failed). Lives in its own module to keep
 * index ↔ worker import-free; the render layer imports these too for its
 * internal re-checks, so validation lives in exactly one place.
 */

/**
 * Upper bound for `concurrency` / `maxConcurrentWorkers`. Every unit of
 * concurrency is a full WASM boot (its own instantiated module and grown
 * heap), so a runaway config value — a query param, a queue-size setting —
 * would otherwise boot hundreds of decoders and take the page down. The
 * default paths clamp to 8; explicit values may reach this ceiling.
 */
export const MAX_BATCH_CONCURRENCY = 64;

/** Validates every per-conversion option shared by all four entry points. */
export function validateConvertOptions(options?: {
  to?: ImageFormat;
  quality?: number;
  applyOrientation?: boolean;
  output?: unknown;
  signal?: AbortSignal;
  crop?: CropOptions;
  preserveExif?: boolean;
  nativeDecode?: boolean;
  maxWidth?: number;
  maxHeight?: number;
  scale?: number;
}): void {
  validateFormat(options?.to ?? 'jpeg');
  if (options?.quality !== undefined) {
    validateQuality(options.quality);
  }
  validateBooleanFlag('applyOrientation', options?.applyOrientation);
  validateOutputShape(options?.output);
  validateSignal(options?.signal);
  validateCrop(options?.crop);
  validateBooleanFlag('preserveExif', options?.preserveExif);
  validateBooleanFlag('nativeDecode', options?.nativeDecode);
  // validateResize inspects each knob and no-ops when none is set — no
  // "does any knob exist" pre-check, which would just duplicate that
  // knowledge at every call site.
  validateResize(options);
}

/**
 * Validates the batch knobs shared by both batch entry points (convertMany
 * and convertManyInWorker both call this). The worker-only knobs
 * (`maxConcurrentWorkers`, `timeoutMs`) are validated in `src/worker.ts`, so
 * their message text stays in the lazy worker chunk.
 */
export function validateBatchOptions(options?: {
  continueOnError?: boolean;
  reuseDecoders?: boolean;
}): void {
  validateBooleanFlag('continueOnError', options?.continueOnError);
  validateBooleanFlag('reuseDecoders', options?.reuseDecoders);
}

/** @throws `invalid_concurrency` for a `concurrency` outside 1..MAX_BATCH_CONCURRENCY. */
export function validateConcurrency(concurrency: number): void {
  if (
    !Number.isInteger(concurrency) ||
    concurrency < 1 ||
    concurrency > MAX_BATCH_CONCURRENCY
  ) {
    throw new HeicConverterError('invalid_concurrency', Messages.ConcurrencyInvalid(concurrency, MAX_BATCH_CONCURRENCY));
  }
}

/** @throws `invalid_quality` if quality is not between 0.0 and 1.0. */
function validateQuality(quality: unknown): void {
  if (typeof quality !== 'number' || !Number.isFinite(quality) || quality < 0 || quality > 1) {
    throw new HeicConverterError('invalid_quality', Messages.QualityInvalid(quality));
  }
}

/** @throws `invalid_input` for an output shape outside the OutputShape union. */
function validateOutputShape(output: unknown): void {
  if (
    output !== undefined &&
    output !== 'blob' &&
    output !== 'dataUrl' &&
    output !== 'arrayBuffer'
  ) {
    throw new HeicConverterError('invalid_input', Messages.OutputShapeInvalid(output));
  }
}

/**
 * The five boolean option knobs differ only in name, so they share one check
 * and one message template. (Messages is a single object literal esbuild
 * cannot tree-shake per property — five near-identical literal strings would
 * each ship permanently, whereas parameterized text ships once.)
 * @throws `invalid_input` for a non-boolean flag.
 */
function validateBooleanFlag(name: string, value: unknown): void {
  if (value !== undefined && typeof value !== 'boolean') {
    throw new HeicConverterError('invalid_input', Messages.BooleanOptionInvalid(name, value));
  }
}

/**
 * Validates the abort signal structurally, so a non-AbortSignal value fails
 * fast with `invalid_input` instead of throwing TypeError deep in the
 * pipeline (or being silently ignored).
 */
function validateSignal(signal: unknown): void {
  if (
    signal !== undefined &&
    (typeof signal !== 'object' ||
      signal === null ||
      typeof (signal as AbortSignal).addEventListener !== 'function')
  ) {
    throw new HeicConverterError('invalid_input', Messages.SignalInvalid(signal));
  }
}

/** Boundary check for cooperative cancellation (sync WASM decode cannot be preempted). */
export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new HeicConverterError('aborted', Messages.Aborted);
  }
}

/**
 * Validates that a requested output format is supported (case-insensitive).
 */
export function validateFormat(format: ImageFormat): void {
  const normalized = String(format).toLowerCase();
  if (!(SUPPORTED_FORMATS as readonly string[]).includes(normalized)) {
    throw new HeicConverterError('invalid_format', Messages.UnsupportedFormat(String(format)));
  }
}

/**
 * Validates resize options. Throws if any value is not a positive finite number.
 */
export function validateResize(resize?: ResizeOptions): void {
  if (!resize) {
    return;
  }
  const { maxWidth, maxHeight, scale } = resize;
  if (scale !== undefined && (typeof scale !== 'number' || !Number.isFinite(scale) || scale <= 0)) {
    throw new HeicConverterError('invalid_resize', Messages.ScaleInvalid(scale));
  }
  if (
    maxWidth !== undefined &&
    (typeof maxWidth !== 'number' || !Number.isFinite(maxWidth) || maxWidth <= 0)
  ) {
    throw new HeicConverterError('invalid_resize', Messages.MaxWidthInvalid(maxWidth));
  }
  if (
    maxHeight !== undefined &&
    (typeof maxHeight !== 'number' || !Number.isFinite(maxHeight) || maxHeight <= 0)
  ) {
    throw new HeicConverterError('invalid_resize', Messages.MaxHeightInvalid(maxHeight));
  }
}

/**
 * Validates the crop rectangle *shape* (integer, positive, non-negative).
 * Range checking against the image size happens in `renderAndEncode`, once
 * the post-orientation display dimensions are known.
 */
export function validateCrop(crop?: CropOptions): void {
  if (!crop) {
    return;
  }
  const { x = 0, y = 0, width, height } = crop;
  if (!Number.isInteger(width) || width <= 0) {
    throw new HeicConverterError('invalid_crop', Messages.CropInvalid('width', width));
  }
  if (!Number.isInteger(height) || height <= 0) {
    throw new HeicConverterError('invalid_crop', Messages.CropInvalid('height', height));
  }
  if (!Number.isInteger(x) || x < 0) {
    throw new HeicConverterError('invalid_crop', Messages.CropInvalid('x', x));
  }
  if (!Number.isInteger(y) || y < 0) {
    throw new HeicConverterError('invalid_crop', Messages.CropInvalid('y', y));
  }
}
