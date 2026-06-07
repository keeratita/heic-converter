import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '../..');

async function runTest() {
  console.log('Starting Playwright automated browser test...');
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  // Listen for console errors or violations
  page.on('console', msg => {
    if (msg.type() === 'error') {
      console.log(`[Browser Console Error]: ${msg.text()}`);
    }
  });

  page.on('pageerror', err => {
    console.log(`[Browser Unhandled Exception]: ${err.message}`);
  });

  try {
    console.log('Navigating to http://localhost:3000...');
    await page.goto('http://localhost:3000');

    // Helper function to run conversion on the page
    const runConversion = async (fileName, format, quality) => {
      console.log(`\n--- Testing conversion: ${fileName} -> ${format.toUpperCase()} (quality=${quality ?? 'default'}) ---`);
      
      // Upload file
      const fileInput = await page.locator('#fileInput');
      await fileInput.setInputFiles(path.join(ROOT_DIR, 'test/fixtures', fileName));

      // Select format
      await page.selectOption('#formatSelect', format);

      // Set quality if JPEG
      if (format === 'jpeg' && quality !== undefined) {
        await page.fill('#qualityRange', quality.toString());
        await page.dispatchEvent('#qualityRange', 'input');
      }

      // Clear logs first
      await page.click('#clearLogsBtn');

      // Click Convert button
      await page.click('#convertBtn');

      // Wait for the SUCCESS log line to appear in the UI console output
      await page.waitForFunction(() => {
        const lines = Array.from(document.querySelectorAll('#consoleOutput .log-success'));
        return lines.some(line => line.textContent && line.textContent.includes('Conversion successful!'));
      }, { timeout: 15000 });

      const duration = await page.locator('#outTime').textContent();
      const resolution = await page.locator('#outResolution').textContent();
      const outputSize = await page.locator('#outSize').textContent();
      const outputFormat = await page.locator('#outFormat').textContent();

      console.log(`🎉 Success! Duration: ${duration} | Resolution: ${resolution} | Size: ${outputSize} | Format: ${outputFormat}`);

      // Get page console output
      const logs = await page.evaluate(() => {
        const lines = document.querySelectorAll('#consoleOutput .log-line');
        return Array.from(lines).map(line => line.textContent?.trim() || '');
      });

      console.log('Page Logs:');
      logs.forEach(log => console.log('  ' + log));
    };

    // Test 1: PNG conversion (colors-with-alpha.heic)
    await runConversion('colors-with-alpha.heic', 'png');

    // Test 2: JPEG conversion (example.heic, quality=0.5)
    await runConversion('example.heic', 'jpeg', 0.5);

    // Test 3: SVG conversion (colors-no-alpha.heic)
    await runConversion('colors-no-alpha.heic', 'svg');

    // Take screenshot of final SVG success state
    const screenshotPath = path.join(__dirname, 'sandbox-success.png');
    await page.screenshot({ path: screenshotPath });
    console.log(`\nScreenshot of last conversion state saved to ${screenshotPath}`);

  } catch (error) {
    console.error('Test execution failed:', error);
    throw error;
  } finally {
    await browser.close();
  }
}

runTest().catch(() => process.exit(1));
