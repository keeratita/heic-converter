import { convertHeic } from '../../dist/index.mjs';

// State
let selectedFile = null;

// Elements
const dropzone = document.getElementById('dropzone');
const fileInput = document.getElementById('fileInput');
const fileDetails = document.getElementById('fileDetails');
const fileName = document.getElementById('fileName');
const fileType = document.getElementById('fileType');
const fileSize = document.getElementById('fileSize');
const formatSelect = document.getElementById('formatSelect');
const qualityRange = document.getElementById('qualityRange');
const qualityVal = document.getElementById('qualityVal');
const qualityGroup = document.getElementById('qualityGroup');
const convertBtn = document.getElementById('convertBtn');
const previewPlaceholder = document.getElementById('previewPlaceholder');
const previewImage = document.getElementById('previewImage');
const downloadBtn = document.getElementById('downloadBtn');
const outputInfo = document.getElementById('outputInfo');
const outResolution = document.getElementById('outResolution');
const outSize = document.getElementById('outSize');
const outTime = document.getElementById('outTime');
const outFormat = document.getElementById('outFormat');
const consoleOutput = document.getElementById('consoleOutput');
const clearLogsBtn = document.getElementById('clearLogsBtn');
const progressContainer = document.getElementById('progressContainer');
const progressBar = document.getElementById('progressBar');

// Logging helpers
function log(message, type = 'info') {
  const time = new Date().toLocaleTimeString([], { hour12: false, fractionalSecondDigits: 3 });
  const tag = type.toUpperCase();
  
  const line = document.createElement('div');
  line.className = `log-line log-${type}`;
  
  line.innerHTML = `
    <span class="log-time">[${time}]</span>
    <span class="log-tag">${tag}:</span>
    <span class="log-message">${message}</span>
  `;
  
  consoleOutput.appendChild(line);
  consoleOutput.scrollTop = consoleOutput.scrollHeight;
}

log('CSP sandbox loaded. Ready to test HEIC conversion.');

// Event Listeners
dropzone.addEventListener('click', () => fileInput.click());

dropzone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropzone.classList.add('dragover');
});

dropzone.addEventListener('dragleave', () => {
  dropzone.classList.remove('dragover');
});

dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropzone.classList.remove('dragover');
  if (e.dataTransfer.files.length > 0) {
    handleFileSelect(e.dataTransfer.files[0]);
  }
});

fileInput.addEventListener('change', (e) => {
  if (e.target.files.length > 0) {
    handleFileSelect(e.target.files[0]);
  }
});

formatSelect.addEventListener('change', (e) => {
  if (e.target.value === 'jpeg') {
    qualityGroup.style.display = 'flex';
  } else {
    qualityGroup.style.display = 'none';
  }
  log(`Output format set to: ${e.target.value.toUpperCase()}`);
});

qualityRange.addEventListener('input', (e) => {
  qualityVal.textContent = `${Math.round(e.target.value * 100)}%`;
});

clearLogsBtn.addEventListener('click', () => {
  consoleOutput.innerHTML = '';
  log('Logs cleared.');
});

// Handle uploaded file
function handleFileSelect(file) {
  const isHeic = file.name.toLowerCase().endsWith('.heic') || file.name.toLowerCase().endsWith('.heif');
  if (!isHeic) {
    log(`Rejected file: ${file.name}. Only HEIC/HEIF files are supported.`, 'error');
    alert('Please select a valid .heic or .heif image.');
    return;
  }

  selectedFile = file;
  fileName.textContent = file.name;
  fileType.textContent = file.type || 'image/heic';
  fileSize.textContent = formatBytes(file.size);
  
  fileDetails.classList.add('active');
  convertBtn.removeAttribute('disabled');
  log(`Selected file: ${file.name} (${formatBytes(file.size)})`);
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// Run Conversion
convertBtn.addEventListener('click', async () => {
  if (!selectedFile) return;

  convertBtn.disabled = true;
  convertBtn.querySelector('span').textContent = 'Converting...';
  log(`Starting conversion for ${selectedFile.name}...`);

  progressContainer.style.display = 'block';
  progressBar.style.width = '0%';

  const startTime = performance.now();
  const targetFormat = formatSelect.value;
  const quality = parseFloat(qualityRange.value);

  try {
    log('Loading file data into buffer...');
    
    // Convert to Blob options
    const options = {
      to: targetFormat,
      quality: quality,
      onProgress: (percent) => {
        const p = Math.round(percent);
        progressBar.style.width = `${p}%`;
        convertBtn.querySelector('span').textContent = `Converting (${p}%)...`;
        log(`Progress: ${p}%`);
      }
    };

    log(`Invoking convertHeic() with format=${targetFormat}, quality=${quality}...`);
    const resultBlob = await convertHeic(selectedFile, options);
    
    const duration = (performance.now() - startTime).toFixed(1);
    log(`Conversion successful! Completed in ${duration}ms.`, 'success');

    // Create Object URL for preview & download
    const url = URL.createObjectURL(resultBlob);
    
    // Hide placeholder and show image preview
    previewPlaceholder.style.display = 'none';
    previewImage.src = url;
    previewImage.style.display = 'block';

    // Load image resolution
    previewImage.onload = () => {
      outResolution.textContent = `${previewImage.naturalWidth} x ${previewImage.naturalHeight}`;
      log(`Output image resolution: ${previewImage.naturalWidth}x${previewImage.naturalHeight}`);
    };

    // Update stats
    outSize.textContent = formatBytes(resultBlob.size);
    outTime.textContent = `${duration}ms`;
    outFormat.textContent = resultBlob.type.split('/')[1]?.toUpperCase() || targetFormat.toUpperCase();
    outputInfo.classList.add('active');

    // Configure download button
    downloadBtn.href = url;
    downloadBtn.download = `converted_${Date.now()}.${targetFormat === 'jpeg' ? 'jpg' : targetFormat}`;
    downloadBtn.style.display = 'flex';
    log(`Output blob size: ${formatBytes(resultBlob.size)} of type ${resultBlob.type}`);

  } catch (err) {
    log(`Error converting image: ${err.message}`, 'error');
    console.error(err);
    alert(`Failed to convert image: ${err.message}`);
  } finally {
    convertBtn.disabled = false;
    convertBtn.querySelector('span').textContent = 'Convert Image';
    setTimeout(() => {
      progressContainer.style.display = 'none';
      progressBar.style.width = '0%';
    }, 1000);
  }
});
