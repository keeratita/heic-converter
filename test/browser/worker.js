// HEIC conversion worker for the CSP sandbox E2E (test/browser).
//
// Protocol (implemented by convertHeicInWorker in src/worker.ts):
//   in:  { id: number,
//          input: ArrayBuffer | Blob | TypedArray,
//          options: cloneable subset of WorkerConvertOptions }
//   out: { id, type: 'progress', percent }
//      | { id, type: 'result', ok: true, blob: Blob | string | ArrayBuffer }
//      | { id, type: 'result', ok: false, error: string }
//
// Every reply must echo the request's `id` — workers are pooled, so a reply
// without it (or with a stale one) is ignored and the conversion times out.
// Keep in sync with docs/worker.js (same protocol, different import path).
import { convertHeic } from '/dist/index.mjs';

self.onmessage = async (event) => {
  const { id, input, options } = event.data;
  try {
    const blob = await convertHeic(input, {
      ...options,
      onProgress: (percent) => self.postMessage({ id, type: 'progress', percent }),
    });
    // output:'arrayBuffer' results move out zero-copy via the transfer list.
    self.postMessage(
      { id, type: 'result', ok: true, blob },
      blob instanceof ArrayBuffer ? [blob] : []
    );
  } catch (error) {
    self.postMessage({
      id,
      type: 'result',
      ok: false,
      error: error?.stack ?? error?.message ?? String(error),
    });
  }
};
