import { convertHeic, convertHeicInWorker } from './dist/index.mjs';

const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('fileInput');
const fileMeta = document.getElementById('fileMeta');
const metaName = document.getElementById('metaName');
const metaSize = document.getElementById('metaSize');
const formatEl = document.getElementById('format');
const qualityWrap = document.getElementById('qualityWrap');
const qualityEl = document.getElementById('quality');
const qualityVal = document.getElementById('qualityVal');
const maxWidthEl = document.getElementById('maxWidth');
const workerEl = document.getElementById('worker');
const convertBtn = document.getElementById('convert');
const cancelBtn = document.getElementById('cancel');
const progressEl = document.getElementById('progress');
const statusEl = document.getElementById('status');
const previewHint = document.getElementById('previewHint');
const previewImg = document.getElementById('previewImg');
const outputMeta = document.getElementById('outputMeta');
const outFormat = document.getElementById('outFormat');
const outSize = document.getElementById('outSize');
const download = document.getElementById('download');

/** @type {File | null} */
let selectedFile = null;
/** @type {string | null} */
let objectUrl = null;
/**
 * Monotonic counter used to invalidate in-flight conversions when the user
 * picks a different file, so stale results never overwrite the current UI.
 */
let conversionId = 0;

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  return `${(kb / 1024).toFixed(2)} MB`;
}

function setStatus(message, type = '') {
  statusEl.className = `status ${type}`.trim();
  statusEl.textContent = message;
}

function resetOutput() {
  if (objectUrl) {
    URL.revokeObjectURL(objectUrl);
    objectUrl = null;
  }
  previewImg.style.display = 'none';
  previewImg.removeAttribute('src');
  previewHint.hidden = false;
  outputMeta.hidden = true;
  download.classList.remove('enabled');
  download.removeAttribute('download');
  download.setAttribute('aria-disabled', 'true');
  download.setAttribute('href', '#');
  progressEl.style.width = '0%';
}

/** Lock the form (and show Cancel) while a conversion is in flight. */
function setControlsEnabled(enabled) {
  convertBtn.disabled = !enabled || !selectedFile;
  formatEl.disabled = !enabled;
  qualityEl.disabled = !enabled;
  maxWidthEl.disabled = !enabled;
  workerEl.disabled = !enabled;
  cancelBtn.hidden = enabled;
}

// Brands that identify a HEIF/HEIC container's ftyp box (ISO-BMFF). The
// decoder build handles the HEVC-based family plus the generic containers.
const HEIF_BRANDS = ['heic', 'heix', 'heim', 'heis', 'hevc', 'hevm', 'hevs', 'mif1', 'msf1'];

/** Content-level sniff: a .heic file name alone is not enough. */
async function looksLikeHeicContainer(file) {
  if (file.size < 12) {
    return false;
  }
  const head = new Uint8Array(await file.slice(0, 64).arrayBuffer());
  const fourcc = (offset) => String.fromCharCode(...head.subarray(offset, offset + 4));
  if (fourcc(4) !== 'ftyp') {
    return false;
  }
  // Scan the ftyp box: major brand at 8, compatible brands until box end.
  const boxLength = ((head[0] << 24) | (head[1] << 16) | (head[2] << 8) | head[3]) >>> 0;
  const end = Math.min(head.length, boxLength < 12 ? head.length : boxLength);
  for (let offset = 8; offset + 4 <= end; offset += 4) {
    if (HEIF_BRANDS.includes(fourcc(offset))) {
      return true;
    }
  }
  return false;
}

async function setFile(file) {
  // Invalidate any conversion still in flight from a previous selection —
  // including when the new file is rejected, so stale completions can never
  // repopulate cleared UI state.
  conversionId++;
  const id = conversionId;

  const reject = (message) => {
    // Clear any previous selection so the UI cannot keep acting on a stale file.
    selectedFile = null;
    fileMeta.hidden = true;
    convertBtn.disabled = true;
    fileInput.value = ''; // Allow re-selecting the same file later.
    resetOutput();
    setStatus(message, 'error');
  };

  const name = file.name.toLowerCase();
  const isHeic = name.endsWith('.heic') || name.endsWith('.heif');
  if (!isHeic) {
    reject('Please select a .heic or .heif file.');
    return;
  }

  let looksLikeHeic;
  try {
    looksLikeHeic = await looksLikeHeicContainer(file);
  } catch {
    looksLikeHeic = false;
  }
  if (id !== conversionId) {
    return; // Superseded while the header was being read.
  }
  if (!looksLikeHeic) {
    reject('That file does not look like a HEIC/HEIF image (no HEIF ftyp header).');
    return;
  }

  selectedFile = file;
  metaName.textContent = file.name;
  metaSize.textContent = formatBytes(file.size);
  fileMeta.hidden = false;
  resetOutput();
  setControlsEnabled(true);
  setStatus('File ready. Choose output settings and convert.');
}

dropzone.addEventListener('click', () => fileInput.click());

dropzone.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    fileInput.click();
  }
});

dropzone.addEventListener('dragover', (event) => {
  event.preventDefault();
  dropzone.classList.add('dragging');
});

dropzone.addEventListener('dragleave', () => {
  dropzone.classList.remove('dragging');
});

dropzone.addEventListener('drop', (event) => {
  event.preventDefault();
  dropzone.classList.remove('dragging');
  const file = event.dataTransfer?.files?.[0];
  if (file) setFile(file);
});

fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0];
  if (file) setFile(file);
});

formatEl.addEventListener('change', () => {
  qualityWrap.hidden = formatEl.value !== 'jpeg' && formatEl.value !== 'webp';
});

qualityEl.addEventListener('input', () => {
  qualityVal.textContent = `${Math.round(Number(qualityEl.value) * 100)}%`;
});

convertBtn.addEventListener('click', async () => {
  if (!selectedFile) return;

  const id = ++conversionId;
  resetOutput();
  setControlsEnabled(false);
  setStatus('Converting...', '');

  const format = formatEl.value;
  const quality = Number(qualityEl.value);
  const maxWidth = Number(maxWidthEl.value);
  const useWorker = workerEl.value === 'worker';

  const options = {
    to: format,
    quality,
    ...(maxWidth > 0 ? { maxWidth } : {}),
    onProgress: (percent) => {
      // A stale conversion must not keep writing to the progress bar.
      if (id !== conversionId) {
        return;
      }
      progressEl.style.width = `${Math.max(0, Math.min(100, percent)).toFixed(0)}%`;
    },
  };

  try {
    const result = useWorker
      ? await convertHeicInWorker(selectedFile, {
          workerUrl: new URL('./worker.js', import.meta.url),
          workerType: 'module',
          ...options,
        })
      : await convertHeic(selectedFile, options);

    // Ignore completions from stale conversions (file/settings changed mid-flight).
    if (id !== conversionId) {
      return;
    }

    objectUrl = URL.createObjectURL(result);

    previewHint.hidden = true;
    previewImg.style.display = 'block';
    previewImg.src = objectUrl;

    outputMeta.hidden = false;
    outFormat.textContent = (result.type.split('/')[1] || format).toUpperCase();
    outSize.textContent = formatBytes(result.size);

    const extMap = {
      jpeg: 'jpg',
      jpg: 'jpg',
      png: 'png',
      svg: 'svg',
      webp: 'webp',
    };
    const ext = extMap[format] || format;
    const baseName = selectedFile.name.replace(/\.[^/.]+$/, '') || 'converted';
    download.href = objectUrl;
    download.download = `${baseName}.${ext}`;
    download.classList.add('enabled');
    download.removeAttribute('aria-disabled');

    setStatus('Conversion complete.', 'ok');
    progressEl.style.width = '100%';
  } catch (error) {
    if (id !== conversionId) {
      return;
    }
    // Keep the full error (including cause chain) available for debugging;
    // stays fully local to the page.
    console.error('[heic-converter] conversion failed', error);
    const message =
      error instanceof Error ? error.message : 'Unknown conversion error';
    setStatus(`Conversion failed: ${message}`, 'error');
    progressEl.style.width = '0%';
  } finally {
    if (id === conversionId) {
      setControlsEnabled(true);
    }
  }
});

cancelBtn.addEventListener('click', () => {
  // Cooperative cancellation: bumping conversionId makes the in-flight
  // conversion's progress and result ignored when it eventually settles
  // (a WASM decode cannot be aborted mid-run, so the job is left to finish
  // harmlessly in the background).
  conversionId++;
  progressEl.style.width = '0%';
  setControlsEnabled(true);
  setStatus('Conversion cancelled.', '');
});

setStatus('Select a HEIC file to begin.');
