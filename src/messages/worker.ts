/**
 * Error strings thrown from `src/worker.ts`, which is the lazily loaded worker
 * chunk. Add a string here when the *chunk* throws it — not when the API is
 * worker-related: text that `src/index.ts` or `src/validate.ts` can reach must
 * go to `./core`, or the eager bundle grows, because an object literal cannot
 * be tree-shaken per property.
 */
export const WorkerMessages = {
  WorkerUnsupported: 'Web Worker is not supported in the current environment',
  WorkerCreateFailed: (message: string): string => `Failed to create Web Worker: ${message}`,
  WorkerPostFailed: (message: string): string => `Failed to post message to Web Worker: ${message}`,
  WorkerConversionFailed: 'Worker conversion failed',
  WorkerDecoderUnsupported:
    'The decoder option is not supported by convertHeicInWorker: the worker creates its own ' +
    'decoder (functions and class instances cannot cross the worker boundary). Use convertHeic ' +
    'with an injected decoder instead.',
  WorkerFailed: (workerUrl?: string | URL): string =>
    'Worker failed' +
    (workerUrl !== undefined
      ? ` (could not load worker script at ${String(workerUrl)}; check the path resolves and the ` +
        'script is served as JavaScript, e.g. Content-Type: text/javascript)'
      : ''),
  WorkerTimeout: (
    timeoutMs: number,
    stats: {
      progressMessages: number;
      lastPercent?: number;
      unknownType?: string;
      workerUrl?: string | URL;
      /** Required, not optional: the caller knows whether a slot was granted, and
       *  guessing from an omitted field would decide the diagnosis for it. */
      startedAt: number | undefined;
      queueWaitMs?: number;
    }
  ): string => {
    if (stats.startedAt === undefined) {
      // Nothing ever ran, so progress counts would be meaningless and the
      // "large image" advice below would point at the wrong knob.
      return (
        `Web Worker conversion timed out after ${timeoutMs}ms before a worker slot was granted — ` +
        'the deadline was spent waiting behind other conversions (timeoutMs includes queue wait). ' +
        'Raise maxConcurrentWorkers or timeoutMs, or set timeoutMs to 0 to disable the timeout.'
      );
    }
    const details: string[] = [`${stats.progressMessages} progress message(s) received`];
    if (stats.queueWaitMs !== undefined && stats.queueWaitMs > 0) {
      details.unshift(`started after ${stats.queueWaitMs}ms queued`);
    }
    if (stats.lastPercent !== undefined) {
      details.push(`last percent ${stats.lastPercent}`);
    }
    if (stats.unknownType !== undefined) {
      details.push(`last unknown message type '${stats.unknownType}' (worker may not implement the progress/result protocol)`);
    }
    if (stats.workerUrl !== undefined) {
      details.push(`worker ${String(stats.workerUrl)}`);
    }
    return (
      `Web Worker conversion timed out after ${timeoutMs}ms (${details.join('; ')}). ` +
      'Increase timeoutMs for large images, set timeoutMs to 0 to disable the timeout, and ' +
      'verify the worker script implements the { type: "progress" | "result" } protocol.'
    );
  },
  MaxConcurrentWorkersInvalid: (value: unknown): string =>
    `maxConcurrentWorkers must be a positive integer, got: ${value}`,
  TimeoutInvalid: (value: unknown): string =>
    `timeoutMs must be a finite number >= 0 (0 disables the timeout), got: ${value}`
} as const;
