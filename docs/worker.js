// HEIC conversion worker for the GitHub Pages demo.
//
// Protocol (implemented by convertHeicInWorker in src/worker.ts):
//   in:  { input: ArrayBuffer | Blob | TypedArray,
//          options: cloneable subset of WorkerConvertOptions }
//   out: { type: 'progress', percent }
//      | { type: 'result', ok: true, blob: Blob | string | ArrayBuffer }
//      | { type: 'result', ok: false, error: string }
//
// Keep in sync with test/browser/worker.js (same protocol, different import
// path) — src/worker.ts validates this contract and reports timeouts when a
// worker stops speaking it.
import { convertHeic } from './dist/index.mjs';

self.onmessage = async (event) => {
  const { input, options } = event.data;
  try {
    const blob = await convertHeic(input, {
      ...options,
      onProgress: (percent) => self.postMessage({ type: 'progress', percent }),
    });
    // output:'arrayBuffer' results move out zero-copy via the transfer list.
    self.postMessage(
      { type: 'result', ok: true, blob },
      blob instanceof ArrayBuffer ? [blob] : []
    );
  } catch (error) {
    self.postMessage({
      type: 'result',
      ok: false,
      error: error?.stack ?? error?.message ?? String(error),
    });
  }
};
