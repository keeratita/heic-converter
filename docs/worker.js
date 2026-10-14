// Canonical HEIC conversion worker script — this file is the reference the
// README, API.md, and the JSDoc examples are byte-equal to. The compared
// scope starts at the `import { convertHeic }` line and runs through the
// final `};`; the doc copies must match modulo the import specifier and the
// JSDoc ` * ` gutter (the header comments above the import are this file's
// own annotations). test/unit/docs-sync.test.ts pins that — edit all four
// copies together. The sandbox E2E and the GitHub Pages demo both serve it.
//
// Contract for user-authored workers (see API.md):
//   - keep a persistent `onmessage`; never `self.close()` after replying
//     (the pool parks and re-adopts live workers),
//   - echo the request's `id` in every reply — workers are pooled, so a reply
//     without it (or with a stale one) is ignored and the conversion times out.
//
// Protocol (implemented by convertHeicInWorker in src/worker.ts):
//   in:  { id: number,
//          input: ArrayBuffer | Blob | TypedArray,
//          options: cloneable subset of WorkerConvertOptions }
//   out: { id, type: 'progress', percent }
//      | { id, type: 'result', ok: true, blob: Blob | string | ArrayBuffer }
//      | { id, type: 'result', ok: false, error: string }
import { convertHeic } from './dist/index.mjs';

self.onmessage = async (event) => {
  const { id, input, options } = event.data;
  try {
    const blob = await convertHeic(input, {
      ...options,
      onProgress: (percent) => self.postMessage({ id, type: 'progress', percent }),
    });
    // With output: 'arrayBuffer' the payload is zero-copy via a transfer list.
    self.postMessage(
      { id, type: 'result', ok: true, blob },
      blob instanceof ArrayBuffer ? [blob] : []
    );
  } catch (error) {
    self.postMessage({ id, type: 'result', ok: false, error: error?.stack ?? error?.message ?? String(error) });
  }
};
