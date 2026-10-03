import type { ConvertOptions, HeicInput } from './types';
import { Messages } from './messages';
import { HeicConverterError } from './errors';

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
  blob?: Blob;
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
 * Per-workerUrl bookkeeping: `inputs.map(i => convertHeicInWorker(i, …))`
 * must not start an unbounded number of workers, each with its own thread,
 * compiled WASM module, and grown linear-memory heap. Calls beyond the cap
 * queue until an earlier call settles.
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
      // Cancelled while still queued: drop our place in line.
      const idx = slot!.waiters.indexOf(grant);
      if (idx !== -1) {
        slot!.waiters.splice(idx, 1);
      }
      drainOrPrune();
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

/**
 * Converts a HEIC image inside a Web Worker so the main thread stays
 * responsive during the (potentially slow) WASM decode.
 *
 * The worker script is user-provided and must handle the following message
 * protocol (types are exported as {@link WorkerProgressMessage} and
 * {@link WorkerResultMessage}):
 *
 * ```js
 * // converter.worker.js — keep in sync with docs/worker.js,
 * // test/browser/worker.js, and this JSDoc example.
 * import { convertHeic } from '@keeratita/heic-converter';
 *
 * self.onmessage = async (event) => {
 *   const { input, options } = event.data;
 *   try {
 *     const blob = await convertHeic(input, {
 *       ...options,
 *       onProgress: (percent) => self.postMessage({ type: 'progress', percent }),
 *     });
 *     self.postMessage({ type: 'result', ok: true, blob });
 *   } catch (error) {
 *     self.postMessage({ type: 'result', ok: false, error: error?.stack ?? error?.message ?? String(error) });
 *   }
 * };
 * ```
 *
 * ```ts
 * const jpegBlob = await convertHeicInWorker(heicBlob, {
 *   workerUrl: new URL('./converter.worker.js', import.meta.url),
 *   workerType: 'module',
 *   to: 'jpeg',
 * });
 * ```
 *
 * Only `progress` and `result` messages are understood; any other message
 * type is ignored (the first unknown type is reported in the timeout
 * diagnostic). Use `workerType: 'module'` when the script uses ES module
 * imports (as in the example above); `'classic'` scripts must be
 * pre-bundled, since static ES imports are not supported there.
 *
 * The `decoder` option is rejected: class instances cannot cross the
 * worker boundary; the worker creates its own decoder.
 *
 * @param input HEIC image as a Blob, File, ArrayBuffer, or Uint8Array.
 * @param options Conversion options plus the worker script URL.
 * @returns A Promise resolving to the converted image as a Blob.
 */
export function convertHeicInWorker(
  input: HeicInput,
  options: WorkerConvertOptions
): Promise<Blob> {
  return new Promise<Blob>((resolve, reject) => {
    if (typeof Worker === 'undefined') {
      reject(new HeicConverterError('worker_unsupported', Messages.WorkerUnsupported));
      return;
    }
    if ((options as ConvertOptions).decoder !== undefined) {
      reject(new HeicConverterError('invalid_input', Messages.WorkerDecoderUnsupported));
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
      if (worker) {
        worker.removeEventListener('message', onMessage);
        worker.removeEventListener('messageerror', onMessageError);
        worker.removeEventListener('error', onError);
        worker.terminate();
      }
      releaseSlot?.();
    };

    const timeoutMs = options.timeoutMs ?? 60000;
    if (timeoutMs > 0) {
      timeoutId = setTimeout(() => {
        cleanup();
        reject(
          new HeicConverterError(
            'worker_timeout',
            Messages.WorkerTimeout(timeoutMs, {
              progressMessages: stats.progressMessages,
              lastPercent: stats.lastPercent,
              unknownType: stats.unknownType,
              workerUrl: options.workerUrl,
            })
          )
        );
      }, timeoutMs);
    }

    const onMessage = (event: MessageEvent): void => {
      const message = event.data as Partial<WorkerMessage> | undefined;
      if (message?.type === 'progress') {
        stats.progressMessages += 1;
        try {
          const percent = Number(message.percent);
          const normalized = Number.isFinite(percent) ? Math.min(100, Math.max(0, percent)) : 0;
          stats.lastPercent = normalized;
          options.onProgress?.(normalized);
        } catch (error) {
          // A throwing progress callback must not leak the worker.
          cleanup();
          reject(error instanceof Error ? error : new Error(String(error)));
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
      if (message.ok && message.blob) {
        resolve(message.blob);
      } else {
        reject(
          new HeicConverterError('worker_failed', message.error ?? Messages.WorkerConversionFailed)
        );
      }
    };

    const onError = (event: ErrorEvent): void => {
      cleanup();
      const location = event.filename ? ` (${event.filename}:${event.lineno})` : '';
      reject(
        new HeicConverterError(
          'worker_failed',
          `${event.message || Messages.WorkerFailed(options.workerUrl)}${location}`
        )
      );
    };

    const onMessageError = (event: MessageEvent): void => {
      cleanup();
      const detail = event.data;
      reject(
        detail instanceof Error
          ? detail
          : new HeicConverterError(
              'worker_failed',
              detail !== undefined ? String(detail) : Messages.WorkerFailed(options.workerUrl)
            )
      );
    };

    // Functions and class instances (decoder, onProgress) are not
    // structured-cloneable, and workerUrl/timeoutMs/workerType/
    // maxConcurrentWorkers are only needed on the main thread;
    // rest-destructuring forwards all remaining options.
    const { workerUrl, onProgress: _onProgress, timeoutMs: _timeoutMs, workerType: _workerType, maxConcurrentWorkers: _max, ...convertOptions } =
      options;

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
      try {
        worker = new Worker(workerUrl, options.workerType === 'module' ? { type: 'module' } : undefined);
      } catch (error) {
        cleanup();
        reject(
          new HeicConverterError(
            'worker_create_failed',
            Messages.WorkerCreateFailed(error instanceof Error ? error.message : String(error)),
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
            Messages.WorkerPostFailed(error instanceof Error ? error.message : String(error)),
            { cause: error }
          )
        );
      }
    };

    const key = `${String(workerUrl)}|${options.workerType ?? 'classic'}`;
    const max =
      typeof options.maxConcurrentWorkers === 'number' && Number.isInteger(options.maxConcurrentWorkers)
        ? Math.max(1, options.maxConcurrentWorkers)
        : defaultMaxWorkers();
    releaseSlot = reserveWorkerSlot(key, max, start);
  });
}
