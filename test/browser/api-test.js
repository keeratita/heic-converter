import { convertHeic, convertMany, convertHeicInWorker } from '/dist/index.mjs';

const results = {};

async function fetchFixture(name) {
  const res = await fetch(`/test/fixtures/${name}`);
  return res.blob();
}

async function loadImageSize(blob) {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error('image failed to load'));
      img.src = url;
    });
    return { width: img.naturalWidth, height: img.naturalHeight };
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function runResizeTest() {
  const blob = await fetchFixture('example.heic');
  const out = await convertHeic(blob, { to: 'png', maxWidth: 100 });
  results.resize = await loadImageSize(out);
}

async function runBatchTest() {
  const blob = await fetchFixture('colors-with-alpha.heic');
  const outs = await convertMany([blob, blob], { to: 'png', concurrency: 2 });
  results.batch = outs.length;
}

async function runWorkerTest() {
  const blob = await fetchFixture('example.heic');
  const out = await convertHeicInWorker(blob, {
    workerUrl: new URL('./worker.js', import.meta.url),
    workerType: 'module',
    to: 'png',
  });
  results.worker = out.size > 0;
}

Promise.all([runResizeTest(), runBatchTest(), runWorkerTest()])
  .then(() => {
    document.getElementById('results').textContent = JSON.stringify(results);
  })
  .catch((error) => {
    document.getElementById('results').textContent = JSON.stringify({
      error: error instanceof Error ? error.message : String(error),
    });
  });
