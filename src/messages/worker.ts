/**
 * Error messages thrown only by the Web Worker entry points
 * (`convertHeicInWorker` / `convertManyInWorker`). Separate from `./core` so
 * the text stays in the lazily-loaded worker chunk — `Messages` is one object
 * literal and cannot be tree-shaken per property.
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
    }
  ): string => {
    const details: string[] = [`${stats.progressMessages} progress message(s) received`];
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
} as const;
