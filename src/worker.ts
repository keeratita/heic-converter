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
 * Per-workerUrl concurrency + reuse: calls beyond the cap queue, so a batch
 * cannot spawn unbounded workers. Workers answering a clean `ok: true` are
 * parked (listeners detached) and adopted by the next grant instead of
 * paying boot again; anything less clean is terminated, so a faulted module
 * never serves the next item. An idle slot keeps parked workers warm for
 * WORKER_POOL_IDLE_MS, then terminates them and drops the entry.
 */
const workerSlots = new Map<
  string,
  { active: number; waiters: Array<() => void>; parked: Worker[]; idleTimer?: ReturnType<typeof setTimeout> }
>();

/** How long an idle slot may keep parked workers alive before terminating them. */
const WORKER_POOL_IDLE_MS = 5000;

/** Hands the lease back; a `recycle` worker is parked for the next grant. */
type WorkerReleaser = (recycle?: Worker) => void;

function reserveWorkerSlot(
  key: string,
  max: number,
  start: (release: WorkerReleaser, recycled: Worker | undefined) => void
): WorkerReleaser {
  let slot = workerSlots.get(key);
  if (!slot) {
    slot = { active: 0, waiters: [], parked: [] };
    workerSlots.set(key, slot);
  }
  const state = { granted: false, released: false };

  const collectIfIdle = (): void => {
    if (slot!.active !== 0 || slot!.waiters.length !== 0) {
      return;
    }
    if (slot!.parked.length === 0) {
      workerSlots.delete(key);
      return;
    }
    // Keep the pool warm: the next sequential-batch call arrives within a
    // microtask. Only grant() makes the slot busy again and it cancels this
    // timer, so firing means "still idle".
    slot!.idleTimer = setTimeout(() => {
      slot!.idleTimer = undefined;
      for (const parked of slot!.parked.splice(0)) {
        parked.terminate();
      }
      workerSlots.delete(key);
    }, WORKER_POOL_IDLE_MS);
  };

  const release = (recycle?: Worker): void => {
    if (state.released) {
      return;
    }
    state.released = true;
    if (recycle) {
      slot!.parked.push(recycle);
    }
    if (state.granted) {
      state.granted = false;
      slot!.active -= 1;
      const next = slot!.waiters.shift();
      if (next) {
        next();
      } else {
        collectIfIdle();
      }
    } else {
      // Cancelled while still queued: drop our place in line. No active slot
      // was ever held, so we must NOT hand a grant to the next waiter — that
      // would push `active` past `max`. Only collect an emptied slot entry.
      const idx = slot!.waiters.indexOf(grant);
      if (idx !== -1) {
        slot!.waiters.splice(idx, 1);
      }
      collectIfIdle();
    }
  };

  const grant = (): void => {
    if (state.released) {
      return;
    }
    // The pool is busy again: cancel any pending idle prune.
    if (slot!.idleTimer !== undefined) {
      clearTimeout(slot!.idleTimer);
      slot!.idleTimer = undefined;
    }
    state.granted = true;
    slot!.active += 1;
    // The release callback is handed to start() directly: start may fail
    // (worker construction throw) synchronously, before the caller has had
    // a chance to store the returned release function. A parked worker is
    // adopted; start() attaches listeners and posts either way.
    start(release, slot!.parked.pop());
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
  WORKER_POOL_IDLE_MS,
};

/**
 * @internal Terminate parked workers, cancel idle prunes and drop slot
 * entries, so a parked worker is never adopted across tests. Tree-shaken
 * out of the shipped chunk.
 */
export function __resetWorkerPool(): void {
  for (const slot of workerSlots.values()) {
    if (slot.idleTimer !== undefined) {
      clearTimeout(slot.idleTimer);
      slot.idleTimer = undefined;
    }
    for (const parked of slot.parked.splice(0)) {
      parked.terminate();
    }
  }
  workerSlots.clear();
}

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
    let releaseSlot: WorkerReleaser | undefined;

    const cleanup = (recycle = false): void => {
      /* v8 ignore if -- each settle path calls cleanup once and removes listeners inline; double-settle is impossible single-threaded */
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
      }
      if (recycle && worker) {
        // Idle and listener-detached: park it for the next grant. Every
        // other settle path terminates, so a faulted module cannot leak into
        // the next item.
        releaseSlot?.(worker);
      } else {
        worker?.terminate();
        releaseSlot?.();
      }
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
      // Only a clean ok:true result recycles; an error result may well be a
      // faulted module inside the worker, so that path terminates.
      cleanup(message.ok === true && message.blob !== undefined);
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

    const start = (release: WorkerReleaser, recycled: Worker | undefined): void => {
      // Store the slot releaser first: every failure path below runs cleanup(),
      // which must be able to hand the slot back even if the worker never
      // got constructed.
      releaseSlot = release;
      // The call may already have timed out while queued; do not spawn a
      // worker for a settled promise.
      /* v8 ignore if -- release() prunes cancelled queue entries, so grant() never reaches a settled call */
      if (settled) {
        recycled?.terminate();
        return;
      }
      // Slot granted: distinguishes "timed out inside the worker" from "timed
      // out waiting for a worker" in the timeout diagnostic.
      startedAt = Date.now();
      try {
        worker =
          recycled ??
          new Worker(workerUrl, options.workerType === 'module' ? { type: 'module' } : undefined);
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
  /* v8 ignore next 1 -- options is required by every overload; omitting it throws at the decoder check above */
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
