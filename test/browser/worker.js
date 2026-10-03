// HEIC conversion worker for the CSP sandbox E2E (test/browser).
//
// Protocol (implemented by convertHeicInWorker in src/worker.ts):
//   in:  { input: ArrayBuffer, options: CloneableConvertOptions }
//   out: { type: 'progress', percent } | { type: 'result', ok, blob | error }
//
// Keep in sync with docs/worker.js (same protocol, different import path).
import { convertHeic } from '/dist/index.mjs';

self.onmessage = async (event) => {
  const { input, options } = event.data;
  try {
    const blob = await convertHeic(input, {
      ...options,
      onProgress: (percent) => self.postMessage({ type: 'progress', percent }),
    });
    self.postMessage({ type: 'result', ok: true, blob });
  } catch (error) {
    self.postMessage({
      type: 'result',
      ok: false,
      error: error?.stack ?? error?.message ?? String(error),
    });
  }
};
