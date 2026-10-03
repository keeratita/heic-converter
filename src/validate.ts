import { Messages } from './messages';
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

/** Validates every per-conversion option shared by all four entry points. */
export function validateConvertOptions(options?: {
  to?: ImageFormat;
  quality?: number;
  applyOrientation?: boolean;
  output?: unknown;
  signal?: AbortSignal;
  crop?: CropOptions;
  preserveExif?: boolean;
  maxWidth?: number;
  maxHeight?: number;
  scale?: number;
}): void {
  validateFormat(options?.to ?? 'jpeg');
  if (options?.quality !== undefined) {
    validateQuality(options.quality);
  }
  validateApplyOrientation(options?.applyOrientation);
  validateOutputShape(options?.output);
  validateSignal(options?.signal);
  validateCrop(options?.crop);
  validatePreserveExif(options?.preserveExif);
  validateResize(
    options?.maxWidth !== undefined || options?.maxHeight !== undefined || options?.scale !== undefined
      ? options
      : undefined
  );
}

/** Validates batch-only knobs (`convertMany` / `convertManyInWorker`). */
export function validateBatchOptions(options?: {
  continueOnError?: boolean;
  reuseDecoders?: boolean;
}): void {
  validateContinueOnError(options?.continueOnError);
  validateReuseDecoders(options?.reuseDecoders);
}

/** @throws `invalid_quality` if quality is not between 0.0 and 1.0. */
export function validateQuality(quality: unknown): void {
  if (typeof quality !== 'number' || !Number.isFinite(quality) || quality < 0 || quality > 1) {
    throw new HeicConverterError('invalid_quality', Messages.QualityInvalid(quality));
  }
}

/** @throws `invalid_input` for a non-boolean applyOrientation. */
export function validateApplyOrientation(applyOrientation: unknown): void {
  if (applyOrientation !== undefined && typeof applyOrientation !== 'boolean') {
    throw new HeicConverterError('invalid_input', Messages.ApplyOrientationInvalid(applyOrientation));
  }
}

/** @throws `invalid_input` for an output shape outside the OutputShape union. */
export function validateOutputShape(output: unknown): void {
  if (
    output !== undefined &&
    output !== 'blob' &&
    output !== 'dataUrl' &&
    output !== 'arrayBuffer'
  ) {
    throw new HeicConverterError('invalid_input', Messages.OutputShapeInvalid(output));
  }
}

/** @throws `invalid_input` for a non-boolean reuseDecoders flag. */
export function validateReuseDecoders(reuseDecoders: unknown): void {
  if (reuseDecoders !== undefined && typeof reuseDecoders !== 'boolean') {
    throw new HeicConverterError('invalid_input', Messages.ReuseDecodersInvalid(reuseDecoders));
  }
}

/** @throws `invalid_input` for a non-boolean continueOnError flag. */
export function validateContinueOnError(continueOnError: unknown): void {
  if (continueOnError !== undefined && typeof continueOnError !== 'boolean') {
    throw new HeicConverterError('invalid_input', Messages.ContinueOnErrorInvalid(continueOnError));
  }
}

/** @throws `invalid_input` for a non-boolean preserveExif flag. */
export function validatePreserveExif(preserveExif: unknown): void {
  if (preserveExif !== undefined && typeof preserveExif !== 'boolean') {
    throw new HeicConverterError('invalid_input', Messages.PreserveExifInvalid(preserveExif));
  }
}

/**
 * Validates the abort signal structurally, so a non-AbortSignal value fails
 * fast with `invalid_input` instead of throwing TypeError deep in the
 * pipeline (or being silently ignored).
 */
export function validateSignal(signal: unknown): void {
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

/** @throws `invalid_concurrency` for a non-positive-integer maxConcurrentWorkers. */
export function validateMaxConcurrentWorkers(maxConcurrentWorkers: unknown): void {
  if (
    maxConcurrentWorkers !== undefined &&
    (!Number.isInteger(maxConcurrentWorkers) || (maxConcurrentWorkers as number) < 1)
  ) {
    throw new HeicConverterError(
      'invalid_concurrency',
      Messages.MaxConcurrentWorkersInvalid(maxConcurrentWorkers)
    );
  }
}

/** @throws `invalid_input` for a negative or non-finite timeoutMs. */
export function validateTimeoutMs(timeoutMs: unknown): void {
  if (
    timeoutMs !== undefined &&
    (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs < 0)
  ) {
    throw new HeicConverterError('invalid_input', Messages.TimeoutInvalid(timeoutMs));
  }
}
