import { chromium } from 'playwright';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '../..');
const BASE_URL = 'http://localhost:3000';
const SERVER_PATH = path.join(__dirname, 'server.mjs');

function fail(message) {
  throw new Error(`E2E assertion failed: ${message}`);
}

async function isServerUp() {
  try {
    const res = await fetch(`${BASE_URL}/`);
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForServer(timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isServerUp()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('CSP sandbox server did not start in time');
}

/**
 * CSP sandbox (test/browser/index.html): every conversion must produce a real
 * blob with the requested format, a valid resolution, and a non-zero size.
 */
async function runSandboxConversions(page) {
  const runConversion = async (fileName, format, quality) => {
    console.log(`\n--- Sandbox: ${fileName} -> ${format.toUpperCase()} (quality=${quality ?? 'default'}) ---`);

    await page.locator('#fileInput').setInputFiles(path.join(ROOT_DIR, 'test/fixtures', fileName));
    await page.selectOption('#formatSelect', format);
    if (quality !== undefined) {
      await page.fill('#qualityRange', quality.toString());
      await page.dispatchEvent('#qualityRange', 'input');
    }
    await page.click('#clearLogsBtn');
    await page.click('#convertBtn');

    await page.waitForFunction(() => {
      const lines = Array.from(document.querySelectorAll('#consoleOutput .log-success'));
      return lines.some((line) => line.textContent && line.textContent.includes('Conversion successful!'));
    }, { timeout: 30000 });

    const outFormat = (await page.locator('#outFormat').textContent())?.trim();
    const outResolution = (await page.locator('#outResolution').textContent())?.trim();
    const outSize = (await page.locator('#outSize').textContent())?.trim();

    const expectedFormat = { png: 'PNG', jpeg: 'JPEG', svg: 'SVG+XML' }[format];
    if (outFormat !== expectedFormat) {
      fail(`format: expected ${expectedFormat}, got ${outFormat}`);
    }

    const match = /^(\d+)\s*x\s*(\d+)$/.exec(outResolution || '');
    if (!match || Number(match[1]) <= 0 || Number(match[2]) <= 0) {
      fail(`resolution: got "${outResolution}"`);
    }

    if (!outSize || outSize === '0 Bytes') {
      fail(`size: got "${outSize}"`);
    }

    console.log(`✅ Sandbox ${format.toUpperCase()} OK: ${outFormat} | ${outResolution} | ${outSize}`);
  };

  await runConversion('colors-with-alpha.heic', 'png');
  await runConversion('example.heic', 'jpeg', 0.5);
  await runConversion('colors-no-alpha.heic', 'svg');
}

/**
 * GitHub Pages demo (docs/): the same asset set that gets deployed. Asserts a
 * real conversion end-to-end (preview, output meta, download link) plus the
 * non-HEIC rejection path and stale-state clearing.
 */
async function runDemoConversions(page) {
  console.log('\n--- Demo (docs/): PNG conversion + rejection path ---');

  // Trailing slash matters: the demo page resolves "./demo.js" relative to its
  // directory, so it must be served as /demo/, not /demo.
  await page.goto(`${BASE_URL}/demo/`);

  // Happy path: select fixture, convert to PNG.
  await page.locator('#fileInput').setInputFiles(path.join(ROOT_DIR, 'test/fixtures', 'example.heic'));
  await page.waitForFunction(() =>
    document.querySelector('#status')?.textContent?.includes('File ready'));
  await page.selectOption('#format', 'png');
  await page.click('#convert');

  await page.waitForFunction(() =>
    document.querySelector('#status')?.textContent?.includes('Conversion complete.'), { timeout: 30000 });

  const previewWidth = await page.locator('#previewImg').evaluate((img) => img.naturalWidth);
  if (previewWidth <= 0) {
    fail('preview image did not render');
  }

  const outFormat = (await page.locator('#outFormat').textContent())?.trim().toUpperCase();
  if (outFormat !== 'PNG') {
    fail(`output meta format: expected PNG, got ${outFormat}`);
  }

  const downloadAttr = await page.locator('#download').getAttribute('download');
  if (downloadAttr !== 'example.png') {
    fail(`download attribute: expected example.png, got ${downloadAttr}`);
  }
  const href = await page.locator('#download').getAttribute('href');
  if (!href || !href.startsWith('blob:')) {
    fail(`download href: expected blob: URL, got ${href}`);
  }

  console.log('✅ Demo PNG conversion OK: preview rendered, output meta + download wired');

  // Error path: dropping a non-HEIC file must clear the previous selection.
  await page.locator('#fileInput').setInputFiles({
    name: 'not-an-image.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('this is not an image'),
  });
  await page.waitForFunction(() =>
    document.querySelector('#status')?.textContent?.includes('Please select a .heic or .heif file.'));

  if (!(await page.locator('#convert').isDisabled())) {
    fail('convert button must be disabled after a rejected file');
  }
  if (!(await page.locator('#fileMeta').isHidden())) {
    fail('file meta must be hidden after a rejected file');
  }

  // Re-selecting a valid file must still work after a rejection.
  await page.locator('#fileInput').setInputFiles(path.join(ROOT_DIR, 'test/fixtures', 'example.heic'));
  await page.waitForFunction(() =>
    document.querySelector('#status')?.textContent?.includes('File ready'));
  if (await page.locator('#convert').isDisabled()) {
    fail('convert button must be enabled after selecting a valid file');
  }

  console.log('✅ Demo rejection path OK: stale state cleared, re-selection works');

  // Verify a WebP conversion with quality on the demo, and its download name.
  await page.selectOption('#format', 'webp');
  await page.click('#convert');
  await page.waitForFunction(() =>
    document.querySelector('#status')?.textContent?.includes('Conversion complete.'), { timeout: 30000 });

  const webpDownloadAttr = await page.locator('#download').getAttribute('download');
  if (webpDownloadAttr !== 'example.webp') {
    fail(`webp download attribute: expected example.webp, got ${webpDownloadAttr}`);
  }
  console.log('✅ Demo WebP conversion OK');
}

async function runTest() {
  let serverProcess = null;
  if (await isServerUp()) {
    console.log('Reusing an already-running CSP sandbox server on :3000');
  } else {
    console.log('Starting CSP sandbox server...');
    serverProcess = spawn(process.execPath, [SERVER_PATH], { stdio: 'inherit' });
    await waitForServer();
  }

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  // Surface browser diagnostics (purely informational — assertions cover behavior).
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      console.log(`[Browser Console Error]: ${msg.text()}`);
    }
  });
  page.on('pageerror', (err) => {
    console.log(`[Browser Unhandled Exception]: ${err.message}`);
  });
  page.on('response', (res) => {
    if (res.status() >= 400) {
      console.log(`[HTTP ${res.status()}]: ${res.url()}`);
    }
  });

  try {
    console.log(`Navigating to ${BASE_URL}...`);
    await page.goto(BASE_URL);

    await runSandboxConversions(page);
    await runDemoConversions(page);

    const screenshotPath = path.join(__dirname, 'e2e-success.png');
    await page.screenshot({ path: screenshotPath });
    console.log(`\n🎉 All E2E checks passed. Screenshot: ${screenshotPath}`);
  } catch (error) {
    console.error('E2E test execution failed:', error);
    throw error;
  } finally {
    await browser.close();
    if (serverProcess) {
      serverProcess.kill();
    }
  }
}

runTest().catch(() => process.exit(1));
