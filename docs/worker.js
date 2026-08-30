import { convertHeic } from './dist/index.mjs';

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
