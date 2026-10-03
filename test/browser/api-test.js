import {
  convertHeic,
  convertMany,
  convertHeicInWorker,
  convertManyInWorker,
} from '/dist/index.mjs';

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

// --- 0.5.0 feature coverage -------------------------------------------------

async function runAvifTest() {
  const blob = await fetchFixture('colors-with-alpha.heic');
  try {
    const out = await convertHeic(blob, { to: 'avif' });
    if (out.type !== 'image/avif') {
      throw new Error(`avif output mistyped as ${out.type}`);
    }
    results.avif = 'supported';
  } catch (error) {
    if (error && error.code === 'format_unsupported') {
      // Graceful degradation path (e.g. Safari): expected alternative.
      results.avif = 'unsupported';
    } else {
      throw error;
    }
  }
}

async function runOutputShapeTest() {
  const blob = await fetchFixture('colors-with-alpha.heic');
  const dataUrl = await convertHeic(blob, { to: 'png', output: 'dataUrl' });
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/png;base64,')) {
    throw new Error(`dataUrl output malformed: ${String(dataUrl).slice(0, 40)}`);
  }
  const buffer = await convertHeic(blob, { to: 'png', output: 'arrayBuffer' });
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength === 0) {
    throw new Error('arrayBuffer output empty');
  }
  results.outputShapes = true;
}

async function runContinueOnErrorTest() {
  const good = await fetchFixture('colors-with-alpha.heic');
  const corrupt = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
  const outs = await convertMany([good, corrupt, good], {
    to: 'png',
    continueOnError: true,
    concurrency: 3,
  });
  if (outs.length !== 3) {
    throw new Error(`continueOnError: expected 3 entries, got ${outs.length}`);
  }
  const okFlags = outs.map((entry) => entry.ok);
  if (!(outs[0].ok && outs[2].ok) || outs[1].ok !== false || outs[1].index !== 1) {
    throw new Error(`continueOnError: wrong ok pattern ${JSON.stringify(okFlags)}`);
  }
  if (!outs[1].error || !('code' in outs[1].error)) {
    throw new Error('continueOnError: failure entry lacks a coded error');
  }
  results.continueOnError = outs[1].error.code;
}

async function runAbortTest() {
  const blob = await fetchFixture('colors-with-alpha.heic');
  const controller = new AbortController();
  controller.abort();
  try {
    await convertHeic(blob, { signal: controller.signal });
    throw new Error('aborted signal did not reject');
  } catch (error) {
    if (!error || error.code !== 'aborted') throw error;
  }
  results.abort = true;
}

async function runCropTest() {
  const blob = await fetchFixture('colors-with-alpha.heic'); // 64x64
  const out = await convertHeic(blob, { to: 'png', crop: { x: 8, y: 8, width: 40, height: 32 } });
  const size = await loadImageSize(out);
  if (size.width !== 40 || size.height !== 32) {
    throw new Error(`crop produced ${size.width}x${size.height}, expected 40x32`);
  }
  results.crop = size;
}

async function runPreserveExifTest() {
  const blob = await fetchFixture('exif-orientation-6.heic');
  const WITH = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00]; // "Exif\0\0"
  const containsExifMarker = (bytes) =>
    bytes.some((_, i) => WITH.every((b, j) => bytes[i + j] === b));

  const kept = await convertHeic(blob, { to: 'jpeg', preserveExif: true });
  const keptBytes = new Uint8Array(await kept.arrayBuffer());
  if (keptBytes[0] !== 0xff || keptBytes[1] !== 0xd8) {
    throw new Error('preserveExif: output is not a JPEG');
  }
  if (!containsExifMarker(keptBytes)) {
    throw new Error('preserveExif: APP1 Exif segment missing');
  }

  const dropped = await convertHeic(blob, { to: 'jpeg' });
  const droppedBytes = new Uint8Array(await dropped.arrayBuffer());
  if (containsExifMarker(droppedBytes)) {
    throw new Error('preserveExif default leaked metadata');
  }
  results.preserveExif = true;
}

async function runWorkerBatchTest() {
  const blob = await fetchFixture('colors-with-alpha.heic');
  const progress = [];
  const outs = await convertManyInWorker([blob, blob], {
    workerUrl: new URL('./worker.js', import.meta.url),
    workerType: 'module',
    to: 'webp',
    maxConcurrentWorkers: 2,
    onProgress: (index, percent) => progress.push([index, percent]),
  });
  if (outs.length !== 2 || !outs.every((b) => b.size > 0)) {
    throw new Error('worker batch: missing outputs');
  }
  if (!progress.some(([index, percent]) => index === 0 && percent === 100) ||
      !progress.some(([index, percent]) => index === 1 && percent === 100)) {
    throw new Error(`worker batch: per-item progress missing ${JSON.stringify(progress)}`);
  }
  results.workerBatch = true;
}

async function runPooledBatchTest() {
  const blob = await fetchFixture('colors-with-alpha.heic');
  const outs = await convertMany([blob, blob, blob], {
    to: 'png',
    concurrency: 2,
    reuseDecoders: true,
  });
  if (outs.length !== 3 || !outs.every((b) => b.size > 0)) {
    throw new Error('pooled batch: missing outputs');
  }
  results.pooledBatch = true;
}

Promise.all([
  runResizeTest(),
  runBatchTest(),
  runWorkerTest(),
  runAvifTest(),
  runOutputShapeTest(),
  runContinueOnErrorTest(),
  runAbortTest(),
  runCropTest(),
  runPreserveExifTest(),
  runWorkerBatchTest(),
  runPooledBatchTest(),
])
  .then(() => {
    document.getElementById('results').textContent = JSON.stringify(results);
  })
  .catch((error) => {
    document.getElementById('results').textContent = JSON.stringify({
      error: error instanceof Error ? error.message : String(error),
    });
  });
