import { Messages } from './messages';
import { HeicConverterError } from './errors';

/**
 * Option validators shared by `index.ts` (convertHeic/convertMany) and
 * `worker.ts` (the *InWorker APIs perform the same up-front checks so a
 * typo surfaces its own error code on the main thread instead of coming
 * back stringified as worker_failed). Lives in its own module to keep
 * index ↔ worker import-free.
 */

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
