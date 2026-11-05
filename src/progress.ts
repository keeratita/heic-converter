import { Messages } from './messages/core';
import { HeicConverterError } from './errors';

/**
 * The public onProgress contract — percentages clamped to 0-100, the final
 * 100% withheld until success, a throwing host callback surfaced as
 * `progress_callback_failed` — implemented once so the in-process path
 * (`convertHeic`) and the worker transport cannot drift. Stages funnel
 * host-visible percentages through `clampPercent`/`createProgressGate` and
 * decide only *when* to surface a recorded host failure: in-process defers
 * it to completion; the worker rejects on the spot and terminates.
 */

/** Coerce an arbitrary value to the documented 0-100 progress range. */
export function clampPercent(value: unknown): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.min(100, Math.max(0, numeric)) : 0;
}

/** The one construction of the `progress_callback_failed` contract error. */
export function progressCallbackError(error: unknown): HeicConverterError {
  return new HeicConverterError(
    'progress_callback_failed',
    Messages.ProgressCallbackThrew(error instanceof Error ? error.message : String(error)),
    { cause: error }
  );
}

/**
 * The host callback when callable, `undefined` when effectively absent.
 * Everything non-function — truthy or not — counts as absent, so a malformed
 * `onProgress` is silently ignored rather than TypeErroring (and surfacing
 * as `progress_callback_failed`). One decision for all entry points and the
 * worker transport.
 */
export function progressCallbackFor<A extends unknown[]>(
  value: ((...args: A) => void) | undefined
): ((...args: A) => void) | undefined {
  return typeof value === 'function' ? value : undefined;
}

/** Build the gate for a host callback, or `undefined` when it is effectively absent (absence rule: `progressCallbackFor`). */
export function progressGateFor(onProgress: ((percent: number) => void) | undefined): ProgressGate | undefined {
  const callback = progressCallbackFor(onProgress);
  return callback ? createProgressGate(callback) : undefined;
}

export interface ProgressGate {
  /** Forward a clamped sub-100 percentage; a host throw is recorded, never rethrown here. */
  report(percent: number): void;
  /** Emit the withheld 100%, or throw the recorded host failure. Idempotent. */
  complete(): void;
  /** The recorded host failure, if the callback has thrown so far. */
  pendingError(): HeicConverterError | undefined;
}

export function createProgressGate(onProgress: (percent: number) => void): ProgressGate {
  let done = false;
  let hostError: unknown;
  return {
    report: (percent: number): void => {
      if (done) {
        return;
      }
      const value = clampPercent(percent);
      if (value >= 100) {
        return; // withheld; emitted by `complete()`
      }
      try {
        onProgress(value);
      } catch (error) {
        hostError = hostError ?? error;
      }
    },
    complete: (): void => {
      /* v8 ignore if -- single call site per conversion; the idempotence guard is the contract */
      if (done) {
        return;
      }
      done = true;
      if (hostError !== undefined) {
        throw progressCallbackError(hostError);
      }
      try {
        onProgress(100);
      } catch (error) {
        throw progressCallbackError(error);
      }
    },
    pendingError: (): HeicConverterError | undefined =>
      hostError === undefined ? undefined : progressCallbackError(hostError),
  };
}
