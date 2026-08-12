import { convertHeic } from './dist/index.mjs';

const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('fileInput');
const fileMeta = document.getElementById('fileMeta');
const metaName = document.getElementById('metaName');
const metaSize = document.getElementById('metaSize');
const formatEl = document.getElementById('format');
const qualityWrap = document.getElementById('qualityWrap');
const qualityEl = document.getElementById('quality');
const qualityVal = document.getElementById('qualityVal');
const convertBtn = document.getElementById('convert');
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
  download.setAttribute('href', '#');
  progressEl.style.width = '0%';
}

function setFile(file) {
  // Invalidate any conversion still in flight from a previous selection —
  // including when the new file is rejected, so stale completions can never
  // repopulate cleared UI state.
  conversionId++;

  const name = file.name.toLowerCase();
  const isHeic = name.endsWith('.heic') || name.endsWith('.heif');
  if (!isHeic) {
    // Clear any previous selection so the UI cannot keep acting on a stale file.
    selectedFile = null;
    fileMeta.hidden = true;
    convertBtn.disabled = true;
    fileInput.value = ''; // Allow re-selecting the same file later.
    resetOutput();
    setStatus('Please select a .heic or .heif file.', 'error');
    return;
  }

  selectedFile = file;
  metaName.textContent = file.name;
  metaSize.textContent = formatBytes(file.size);
  fileMeta.hidden = false;
  convertBtn.disabled = false;
  resetOutput();
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
  convertBtn.disabled = true;
  setStatus('Converting...', '');

  const format = formatEl.value;
  const quality = Number(qualityEl.value);

  try {
    const result = await convertHeic(selectedFile, {
      to: format,
      quality,
      onProgress: (percent) => {
        // A stale conversion must not keep writing to the progress bar.
        if (id !== conversionId) {
          return;
        }
        progressEl.style.width = `${Math.max(0, Math.min(100, percent)).toFixed(0)}%`;
      },
    });

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
      convertBtn.disabled = false;
    }
  }
});

setStatus('Select a HEIC file to begin.');
