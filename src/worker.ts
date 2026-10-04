import type {
  ConvertItemResult,
  ConvertOptions,
  ConvertResult,
  HeicInput,
  OutputShape,
} from './types';
import { Messages } from './messages/core';
import { WorkerMessages } from './messages/worker';
import { clampPercent } from './progress';
import { HeicConverterError } from './errors';
import { runBoundedBatch } from './batch';
import { validateConvertOptions, validateContinueOnError } from './validate';

/**
 * Worker-only option validators live here, not in `./validate`: `validate.ts` is
 * eagerly imported by `index.ts`, so a validator that reads a `WorkerMessages`
 * string would drag that text into the eager chunk. Same call sites, same error
 * codes — only the module they live in keeps ~120 B out of the first load.
 */

/** @throws `invalid_concurrency` for a non-positive-integer maxConcurrentWorkers. */
function validateMaxConcurrentWorkers(maxConcurrentWorkers: unknown): void {
  if (maxConcurrentWorkers !== undefined && (!Number.isInteger(maxConcurrentWorkers) || (maxConcurrentWorkers as number) < 1)) {
    throw new HeicConverterError('invalid_concurrency', WorkerMessages.MaxConcurrentWorkersInvalid(maxConcurrentWorkers));
  }
}

/** @throws `invalid_input` for a negative or non-finite timeoutMs. */
function validateTimeoutMs(timeoutMs: unknown): void {
  if (timeoutMs !== undefined && (typeof timeoutMs !== 'number' || !Number.isFinite(timeoutMs) || timeoutMs < 0)) {
    throw new HeicConverterError('invalid_input', WorkerMessages.TimeoutInvalid(timeoutMs));
  }
}

export interface WorkerConvertOptions extends Omit<ConvertOptions, 'decoder'> {
  /**
   * URL of the worker script that performs the conversion. Should be a
   * compile-time constant (e.g. `new URL('./worker.js', import.meta.url)`
   * under a bundler); the script runs with the page's privileges.
   */
  workerUrl: string | URL;

  /**
   * Maximum time in milliseconds to wait for the worker result before
   * rejecting with a timeout (queueing for a free worker slot counts toward
   * this). Defaults to 60000 (60s). Set to 0 to disable the timeout.
   */
  timeoutMs?: number;

  /**
   * Worker script type. Use `'module'` when the script uses ES module
   * imports (e.g. `import { convertHeic } from ...`); `'classic'`
   * scripts must be pre-bundled.
   * @default 'classic'
   */
  workerType?: 'classic' | 'module';

  /**
   * Upper bound on simultaneously live workers for this worker script.
   * Calls beyond the bound queue until a slot frees, which keeps bulk
   * conversions (`inputs.map(i => convertHeicInWorker(i, …))`) from
   * exhausting memory or the browser's worker limit.
   * Defaults to `navigator.hardwareConcurrency` clamped to 1–8.
   */
  maxConcurrentWorkers?: number;
}

/** Progress message a worker script posts to report decode progress. */
export interface WorkerProgressMessage {
  type: 'progress';
  percent: number;
}

/** Result message a worker script posts to settle a conversion. */
export interface WorkerResultMessage {
  type: 'result';
  ok: boolean;
  /**
   * The converted image exactly as `convertHeic` returned it inside the
   * worker: a Blob, a data-URL string (`output: 'dataUrl'`), or an
   * ArrayBuffer (`output: 'arrayBuffer'`). The field name `blob` is kept
   * for protocol compatibility.
   */
  blob?: Blob | string | ArrayBuffer;
  error?: string;
}

export type WorkerMessage = WorkerProgressMessage | WorkerResultMessage;

interface ReceivedStats {
  progressMessages: number;
  lastPercent?: number;
  unknownType?: string;
}

function defaultMaxWorkers(): number {
  const cores =
    typeof navigator !== 'undefined' && typeof navigator.hardwareConcurrency === 'number'
      ? navigator.hardwareConcurrency
      : 4;
  return Math.max(1, Math.min(cores, 8));
}

/**
 * Per-workerUrl concurrency bookkeeping: calls beyond the cap queue until an
 * earlier call settles, so a batch cannot spawn unbounded workers.
 */
const workerSlots = new Map<string, { active: number; waiters: Array<() => void> }>();

function reserveWorkerSlot(key: string, max: number, start: (release: () => void) => void): () => void {
  let slot = workerSlots.get(key);
  if (!slot) {
    slot = { active: 0, waiters: [] };
    workerSlots.set(key, slot);
  }
  const state = { granted: false, released: false };

  const drainOrPrune = (): void => {
    const next = slot!.waiters.shift();
    if (next) {
      next();
    } else if (slot!.active === 0 && slot!.waiters.length === 0) {
      workerSlots.delete(key);
    }
  };

  const release = (): void => {
    if (state.released) {
      return;
    }
    state.released = true;
    if (state.granted) {
      state.granted = false;
      slot!.active -= 1;
      drainOrPrune();
    } else {
      // Cancelled while still queued: drop our place in line. No active slot
      // was ever held, so we must NOT hand a grant to the next waiter — that
      // would push `active` past `max`. Only collect an emptied slot entry.
      const idx = slot!.waiters.indexOf(grant);
      if (idx !== -1) {
        slot!.waiters.splice(idx, 1);
      }
      if (slot!.active === 0 && slot!.waiters.length === 0) {
        workerSlots.delete(key);
      }
    }
  };

  const grant = (): void => {
    if (state.released) {
      return;
    }
    state.granted = true;
    slot!.active += 1;
    // The release callback is handed to start() directly: start may fail
    // (worker construction throw) synchronously, before the caller has had
    // a chance to store the returned release function.
    start(release);
  };

  if (slot.active < max) {
    // Grant synchronously when a slot is free so single conversions behave
    // exactly like the unpooled path.
    grant();
  } else {
    slot.waiters.push(grant);
  }
  return release;
}

function toProgressCallbackError(error: unknown): HeicConverterError {
  return new HeicConverterError(
    'progress_callback_failed',
    Messages.ProgressCallbackThrew(error instanceof Error ? error.message : String(error)),
    { cause: error }
  );
}

/** @internal Semaphore unit-test hooks; not part of the public API. */
export const __semaphoreTestHooks = {
  reserveWorkerSlot,
  workerSlots,
  defaultMaxWorkers,
};

/**
 * Implementation behind the public `convertHeicInWorker` wrapper in
 * `src/index.ts`, which carries the published JSDoc: the worker-script message
 * protocol, the `workerType` and `decoder` rules, and the caveats about
 * `timeoutMs` (queue wait counts) and the stringified worker boundary. Keep
 * behaviour in sync with that doc — it is what `dist/index.d.ts` ships, and
 * this file's comments do not reach consumers.
 */
export function convertHeicInWorker<S extends OutputShape = 'blob'>(
  input: HeicInput,
  options: WorkerConvertOptions & { output?: S }
): Promise<ConvertResult<S>> {
  return new Promise<ConvertResult<S>>((resolve, reject) => {
    if (typeof Worker === 'undefined') {
      reject(new HeicConverterError('worker_unsupported', WorkerMessages.WorkerUnsupported));
      return;
    }
    if ((options as ConvertOptions).decoder !== undefined) {
      reject(new HeicConverterError('invalid_input', WorkerMessages.WorkerDecoderUnsupported));
      return;
    }
    try {
      // Same up-front validation as the in-process APIs: a typo surfaces its
      // own error code on the main thread instead of coming back stringified
      // as worker_failed from inside the worker.
      validateConvertOptions(options);
      validateMaxConcurrentWorkers(options?.maxConcurrentWorkers);
      validateTimeoutMs(options?.timeoutMs);
    } catch (error) {
      reject(error);
      return;
    }
    if (options.signal?.aborted) {
      reject(new HeicConverterError('aborted', Messages.Aborted));
      return;
    }

    const stats: ReceivedStats = { progressMessages: 0 };
    let worker: Worker | undefined;
    let settled = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let releaseSlot: (() => void) | undefined;

    const cleanup = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
      options.signal?.removeEventListener('abort', onAbort);
      if (worker) {
        worker.removeEventListener('message', onMessage);
        worker.removeEventListener('messageerror', onMessageError);
        worker.removeEventListener('error', onError);
        worker.terminate();
      }
      releaseSlot?.();
    };

    const onAbort = (): void => {
      // terminate() kills even a still-decoding worker; this is the one
      // path where cancellation is immediate rather than boundary-based.
      cleanup();
      reject(new HeicConverterError('aborted', Messages.Aborted));
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });

    const timeoutMs = options.timeoutMs ?? 60000;
    const queuedAt = Date.now();
    let startedAt: number | undefined;
    if (timeoutMs > 0) {
      timeoutId = setTimeout(() => {
        cleanup();
        reject(
          new HeicConverterError(
            'worker_timeout',
            WorkerMessages.WorkerTimeout(timeoutMs, {
              progressMessages: stats.progressMessages,
              lastPercent: stats.lastPercent,
              unknownType: stats.unknownType,
              workerUrl: options.workerUrl,
              startedAt,
              queueWaitMs: startedAt === undefined ? undefined : startedAt - queuedAt,
            })
          )
        );
      }, timeoutMs);
    }

    const onMessage = (event: MessageEvent): void => {
      const message = event.data as Partial<WorkerMessage> | undefined;
      if (message?.type === 'progress') {
        stats.progressMessages += 1;
        const normalized = clampPercent(message.percent);
        stats.lastPercent = normalized;
        if (normalized >= 100) {
          return; // 100% is emitted on success only
        }
        try {
          options.onProgress?.(normalized);
        } catch (error) {
          // A throwing progress callback must not leak the worker.
          cleanup();
          reject(toProgressCallbackError(error));
        }
        return;
      }
      if (message?.type !== 'result') {
        // Unknown message types are not terminal; only 'result' settles.
        if (typeof message?.type === 'string') {
          stats.unknownType = message.type;
        }
        return;
      }
      cleanup();
      if (message.ok && message.blob !== undefined) {
        try {
          options.onProgress?.(100);
        } catch (error) {
          reject(toProgressCallbackError(error));
          return;
        }
        resolve(message.blob as ConvertResult<S>);
      } else {
        reject(
          new HeicConverterError('worker_failed', message.error ?? WorkerMessages.WorkerConversionFailed)
        );
      }
    };

    const onError = (event: ErrorEvent): void => {
      cleanup();
      const location = event.filename ? ` (${event.filename}:${event.lineno})` : '';
      reject(
        new HeicConverterError(
          'worker_failed',
          `${event.message || WorkerMessages.WorkerFailed(options.workerUrl)}${location}`
        )
      );
    };

    const onMessageError = (event: MessageEvent): void => {
      cleanup();
      const detail = event.data;
      reject(
        new HeicConverterError(
          'worker_failed',
          detail instanceof Error
            ? detail.message
            : detail !== undefined
              ? String(detail)
              : WorkerMessages.WorkerFailed(options.workerUrl),
          { cause: detail }
        )
      );
    };

    // Functions and class instances (decoder, onProgress, signal) are not
    // structured-cloneable, and workerUrl/timeoutMs/workerType/
    // maxConcurrentWorkers are only needed on the main thread;
    // rest-destructuring forwards all remaining options.
    const {
      workerUrl,
      onProgress: _onProgress,
      timeoutMs: _timeoutMs,
      workerType: _workerType,
      maxConcurrentWorkers: _max,
      signal: _signal,
      ...convertOptions
    } = options;

    const start = (release: () => void): void => {
      // Store the slot releaser first: every failure path below runs cleanup(),
      // which must be able to hand the slot back even if the worker never
      // got constructed.
      releaseSlot = release;
      // The call may already have timed out while queued; do not spawn a
      // worker for a settled promise.
      if (settled) {
        return;
      }
      // Slot granted: distinguishes "timed out inside the worker" from "timed
      // out waiting for a worker" in the timeout diagnostic.
      startedAt = Date.now();
      try {
        worker = new Worker(workerUrl, options.workerType === 'module' ? { type: 'module' } : undefined);
      } catch (error) {
        cleanup();
        reject(
          new HeicConverterError(
            'worker_create_failed',
            WorkerMessages.WorkerCreateFailed(error instanceof Error ? error.message : String(error)),
            { cause: error }
          )
        );
        return;
      }

      worker.addEventListener('message', onMessage);
      worker.addEventListener('messageerror', onMessageError);
      worker.addEventListener('error', onError);

      try {
        worker.postMessage({ input, options: convertOptions });
      } catch (error) {
        // A failed post (e.g. data clone error) must not leak the worker.
        cleanup();
        reject(
          new HeicConverterError(
            'worker_post_failed',
            WorkerMessages.WorkerPostFailed(error instanceof Error ? error.message : String(error)),
            { cause: error }
          )
        );
      }
    };

    const key = `${String(workerUrl)}|${options.workerType ?? 'classic'}`;
    const max = toRunnerConcurrency(options.maxConcurrentWorkers);
    releaseSlot = reserveWorkerSlot(key, max, start);
  });
}

/**
 * Options for {@link convertManyInWorker}: the {@link convertHeicInWorker}
 * worker options plus the batch semantics of `convertMany`.
 */
export interface WorkerBatchOptions extends Omit<WorkerConvertOptions, 'onProgress'> {
  /**
   * Per-item progress callback: receives the 0-based item index and its
   * progress percentage (normalized 0–100). Fires only for successful items.
   */
  onProgress?: (index: number, percent: number) => void;

  /**
   * Resolve with per-item results instead of rejecting the batch on the
   * first failure; all items run to completion (see
   * `ConvertManyOptions.continueOnError`).
   * @default false
   */
  continueOnError?: boolean;
}

function toRunnerConcurrency(maxConcurrentWorkers: number | undefined): number {
  return typeof maxConcurrentWorkers === 'number' && Number.isInteger(maxConcurrentWorkers)
    ? Math.max(1, maxConcurrentWorkers)
    : defaultMaxWorkers();
}

/**
 * Implementation behind the public `convertManyInWorker` wrapper in
 * `src/index.ts`, which carries the published JSDoc (semantics, the
 * `maxConcurrentWorkers` default, `continueOnError` result shapes). This is the
 * code the worker chunk actually runs; the entry point just resolves the lazy
 * chunk and forwards.
 */
export function convertManyInWorker<S extends OutputShape = 'blob'>(
  inputs: HeicInput[],
  options: WorkerBatchOptions & { output?: S; continueOnError: true }
): Promise<ConvertItemResult<ConvertResult<S>>[]>;
export function convertManyInWorker<S extends OutputShape = 'blob'>(
  inputs: HeicInput[],
  options: WorkerBatchOptions & { output?: S; continueOnError?: false }
): Promise<ConvertResult<S>[]>;
export function convertManyInWorker<S extends OutputShape = 'blob'>(
  inputs: HeicInput[],
  options: WorkerBatchOptions & { output?: S; continueOnError: boolean }
): Promise<Array<ConvertResult<S> | ConvertItemResult<ConvertResult<S>>>>;
export async function convertManyInWorker<S extends OutputShape = 'blob'>(
  inputs: HeicInput[],
  options: WorkerBatchOptions & { output?: S }
): Promise<ConvertResult<S>[] | ConvertItemResult<ConvertResult<S>>[]> {
  if (!Array.isArray(inputs)) {
    throw new HeicConverterError('invalid_input', Messages.InputsMustBeArray);
  }
  if (typeof Worker === 'undefined') {
    throw new HeicConverterError('worker_unsupported', WorkerMessages.WorkerUnsupported);
  }
  if ((options as ConvertOptions).decoder !== undefined) {
    throw new HeicConverterError('invalid_input', WorkerMessages.WorkerDecoderUnsupported);
  }
  // Same up-front shared validation as convertMany: option typos surface
  // their own code on the main thread instead of returning stringified as
  // worker_failed from inside the worker.
  validateConvertOptions(options);
  validateContinueOnError(options?.continueOnError);
  validateMaxConcurrentWorkers(options?.maxConcurrentWorkers);
  validateTimeoutMs(options?.timeoutMs);

  // Batch-only knobs stay out of the per-item worker options.
  const { onProgress, continueOnError: _continueOnError, ...perItemOptions } = options ?? {};

  return runBoundedBatch<ConvertResult<S>>(
    inputs,
    toRunnerConcurrency(options?.maxConcurrentWorkers),
    (input, index) =>
      convertHeicInWorker<S>(input as HeicInput, {
        ...perItemOptions,
        ...(onProgress !== undefined
          ? { onProgress: (percent: number): void => onProgress(index, percent) }
          : {}),
      }),
    { continueOnError: options?.continueOnError === true, signal: options?.signal }
  ) as Promise<ConvertResult<S>[] | ConvertItemResult<ConvertResult<S>>[]>;
}
