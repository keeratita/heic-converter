import type { ConvertOptions, HeicInput } from './types';
import { Messages } from './messages';

export interface WorkerConvertOptions extends ConvertOptions {
  /**
   * URL of the worker script that performs the conversion. Should be a
   * compile-time constant (e.g. `new URL('./worker.js', import.meta.url)`
   * under a bundler); the script runs with the page's privileges.
   */
  workerUrl: string | URL;

  /**
   * Maximum time in milliseconds to wait for the worker result before
   * rejecting with a timeout. Defaults to 60000 (60s). Set to 0 to
   * disable the timeout.
   */
  timeoutMs?: number;

  /**
   * Worker script type. Use `'module'` when the script uses ES module
   * imports (e.g. `import { convertHeic } from ...`); `'classic'`
   * scripts must be pre-bundled.
   * @default 'classic'
   */
  workerType?: 'classic' | 'module';
}

interface WorkerMessage {
  type?: string;
  ok?: boolean;
  blob?: Blob;
  error?: string;
  percent?: number;
}

/**
 * Converts a HEIC image inside a Web Worker so the main thread stays
 * responsive during the (potentially slow) WASM decode.
 *
 * The worker script is user-provided and must handle the following message
 * protocol:
 *
 * ```js
 * // converter.worker.js
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
 * type is ignored. Use `workerType: 'module'` when the script uses ES
 * module imports (as in the example above); `'classic'` scripts must be
 * pre-bundled, since static ES imports are not supported there.
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
      reject(new Error(Messages.WorkerUnsupported));
      return;
    }

    let worker: Worker;
    try {
      worker = new Worker(
        options.workerUrl,
        options.workerType === 'module' ? { type: 'module' } : undefined
      );
    } catch (error) {
      reject(
        new Error(
          Messages.WorkerCreateFailed(error instanceof Error ? error.message : String(error)),
          { cause: error }
        )
      );
      return;
    }

    const timeoutMs = options.timeoutMs ?? 60000;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    if (timeoutMs > 0) {
      timeoutId = setTimeout(() => {
        cleanup();
        reject(new Error(Messages.WorkerTimeout));
      }, timeoutMs);
    }

    const onMessage = (event: MessageEvent): void => {
      const message = event.data as WorkerMessage | undefined;
      if (message?.type === 'progress') {
        try {
          const percent = Number(message.percent);
          options.onProgress?.(Number.isFinite(percent) ? Math.min(100, Math.max(0, percent)) : 0);
        } catch (error) {
          // A throwing progress callback must not leak the worker.
          cleanup();
          reject(error instanceof Error ? error : new Error(String(error)));
        }
        return;
      }
      if (message?.type !== 'result') {
        // Unknown message types are not terminal; only 'result' settles.
        return;
      }
      cleanup();
      if (message.ok && message.blob) {
        resolve(message.blob);
      } else {
        reject(new Error(message.error ?? Messages.WorkerConversionFailed));
      }
    };

    const onError = (event: ErrorEvent): void => {
      cleanup();
      const location = event.filename ? ` (${event.filename}:${event.lineno})` : '';
      reject(new Error(`${event.message || Messages.WorkerFailed}${location}`));
    };

    const onMessageError = (event: MessageEvent): void => {
      cleanup();
      const detail = event.data;
      reject(
        detail instanceof Error
          ? detail
          : new Error(detail !== undefined ? String(detail) : Messages.WorkerFailed)
      );
    };

    const cleanup = (): void => {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId);
      }
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('messageerror', onMessageError);
      worker.removeEventListener('error', onError);
      worker.terminate();
    };

    worker.addEventListener('message', onMessage);
    worker.addEventListener('messageerror', onMessageError);
    worker.addEventListener('error', onError);

    // Functions and class instances (decoder, onProgress) are not
    // structured-cloneable, and workerUrl/timeoutMs/workerType are only
    // needed on the main thread; rest-destructuring forwards all remaining
    // options.
    const { workerUrl: _workerUrl, decoder: _decoder, onProgress: _onProgress, timeoutMs: _timeoutMs, workerType: _workerType, ...convertOptions } = options;

    try {
      worker.postMessage({ input, options: convertOptions });
    } catch (error) {
      // A failed post (e.g. data clone error) must not leak the worker.
      cleanup();
      reject(
        new Error(
          Messages.WorkerPostFailed(error instanceof Error ? error.message : String(error)),
          { cause: error }
        )
      );
    }
  });
}
