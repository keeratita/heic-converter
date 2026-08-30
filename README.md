# @keeratita/heic-converter

A modern, lightweight TypeScript library to convert `.heic` and `.heif` images to standard web formats (JPEG, PNG, WebP, SVG) client-side in the browser or on the backend in Node.js.

Designed specifically for environments with strict **Content Security Policy (CSP)** rules, it is built with WebAssembly compiled **without** dynamic code execution (`eval()` or `new Function()`).

---

## ✨ Features

- 🔒 **CSP Compliant**: Emscripten glue code is compiled with `-s DYNAMIC_EXECUTION=0`. Safe to run without `'unsafe-eval'`.
- 🧩 **Dependency Injection Architecture**: Swap the decoder module easily by implementing a simple `IHeicDecoder` interface.
- ⚡ **Optimized Performance**: A fresh decoder instance is created and released per conversion — memory is reclaimed promptly and concurrent conversions never share mutable WASM state.
- 🌐 **Isomorphic / Universal**: Runs in Node.js (decoding) and browser (decoding & canvas-based encoding).
- 📦 **No Bloat**: Zero external production dependencies. Small footprint.
- 🎨 **Format Support**: Convert to `jpeg` (with quality configuration), `png`, `webp`, and `svg` (embedded lossless vector).
- 📐 **Resize Support**: Downscale with `maxWidth`/`maxHeight` or apply a uniform `scale` factor during conversion.
- 📚 **Batch Conversion**: Convert many images at once with bounded concurrency via `convertMany`.
- 🧵 **Web Worker Helper**: Offload conversions to a Web Worker with `convertHeicInWorker` to keep the UI thread responsive.

---

## 📦 Installation

```bash
npm install @keeratita/heic-converter
```

---

## 🌍 Live Demo (GitHub Pages)

Try the browser demo here:

https://keeratita.github.io/heic-converter/

The demo is auto-deployed from the `main` branch by the GitHub Actions workflow in `.github/workflows/demo-pages.yml`.

---

## 🚀 Usage

### 1. Browser: Simple Conversion

In the browser, you can pass a `File` or `Blob` and get a converted `Blob` back:

```typescript
import { convertHeic } from '@keeratita/heic-converter';

// Convert input File/Blob to JPEG
const heicBlob = /* your file input */;
const jpegBlob = await convertHeic(heicBlob, {
  to: 'jpeg',
  quality: 0.9
});

// Create preview URL
const imageUrl = URL.createObjectURL(jpegBlob);
document.querySelector('img').src = imageUrl;
```

### 2. Browser: WebP Output

WebP offers excellent compression with quality configuration:

```typescript
import { convertHeic } from '@keeratita/heic-converter';

const webpBlob = await convertHeic(heicBlob, {
  to: 'webp',
  quality: 0.8,
});
```

### 3. Browser: SVG Output

SVG wraps the raster image as an embedded lossless PNG inside an SVG container:

```typescript
import { convertHeic } from '@keeratita/heic-converter';

const svgBlob = await convertHeic(heicBlob, {
  to: 'svg',
});
```

### 4. Browser: Serving and Locating WASM (Custom Assets Path)

By default, the library tries to fetch `heic-decoder.wasm` relative to the current module script path (`import.meta.url`).

If your bundler places files in a custom assets folder or CDN, you can configure the default decoder or inject a custom one:

```typescript
import { convertHeic, LibheifDecoder } from '@keeratita/heic-converter';

// Create decoder with custom asset paths
const decoder = new LibheifDecoder({
  locateFile: (path, prefix) => `https://cdn.example.com/assets/${path}`,
});

// Pass the custom decoder in options
const pngBlob = await convertHeic(heicBlob, {
  to: 'png',
  decoder: decoder,
});
```

Alternatively, if you prefer to load the WASM binary manually as an `ArrayBuffer` (e.g. from an API or local bundle):

```typescript
import { convertHeic, LibheifDecoder } from '@keeratita/heic-converter';

const wasmResponse = await fetch('/assets/heic-decoder.wasm');
const wasmBinary = await wasmResponse.arrayBuffer();

const decoder = new LibheifDecoder({ wasmBinary });

const jpegBlob = await convertHeic(heicBlob, {
  to: 'jpeg',
  decoder: decoder,
});
```

### 5. Node.js: Decoding Raw Pixel Data

Since Node.js lacks the native browser Canvas API, `convertHeic` (which relies on Canvas to encode raster formats) will throw an error on the backend.

However, you can use the `LibheifDecoder` in Node.js to retrieve the raw RGBA pixels and then encode them using libraries like `sharp` or `pngjs`:

```typescript
import fs from 'fs';
import { LibheifDecoder } from '@keeratita/heic-converter';
import sharp from 'sharp'; // external node image library

async function convertNode() {
  const heicData = new Uint8Array(fs.readFileSync('input.heic'));

  const decoder = new LibheifDecoder();
  await decoder.initialize();

  // Decodes to { width, height, data: Uint8ClampedArray (RGBA) }.
  // data is an independent copy — safe to use after decoder.free().
  const { width, height, data } = await decoder.decode(heicData);

  // Process raw pixels using sharp
  await sharp(Buffer.from(data), {
    raw: { width, height, channels: 4 },
  })
    .toFormat('jpeg')
    .toFile('output.jpg');

  // Clean up WASM memory
  decoder.free();
}
```

### 6. Progress Tracking (e.g. for Large Images)

For large images, you can pass an `onProgress` callback to track the conversion progress (0% to 100%):

```typescript
import { convertHeic } from '@keeratita/heic-converter';

const heicBlob = /* your file */;
const jpegBlob = await convertHeic(heicBlob, {
  to: 'jpeg',
  onProgress: (percent) => {
    console.log(`Conversion progress: ${Math.round(percent)}%`);
    // Update progress bar UI
  }
});
```

> [!TIP]
> Since the WebAssembly module runs on the main browser thread, the UI thread will be occupied during conversion. For maximum responsiveness when converting large images, it is highly recommended to run this library inside a standard JS **Web Worker** and communicate progress back to the main thread.

### 7. Resizing Images

Downscale to fit within maximum dimensions (aspect ratio is preserved, images smaller than the bounds are never upscaled):

```typescript
import { convertHeic } from '@keeratita/heic-converter';

const thumbnailBlob = await convertHeic(heicBlob, {
  to: 'jpeg',
  maxWidth: 800,
  maxHeight: 600,
});
```

Or apply a uniform scale factor (can also upscale):

```typescript
const halfSizeBlob = await convertHeic(heicBlob, {
  to: 'webp',
  scale: 0.5,
});
```

### 8. Batch Conversion

Convert many images at once with bounded concurrency (default `4`). Results are returned in input order; if any conversion fails, the promise rejects as soon as the failure is known with an error that identifies the failing item:

```typescript
import { convertMany } from '@keeratita/heic-converter';

const blobs = await convertMany(heicFiles, {
  to: 'png',
  concurrency: 3,
  onProgress: (index, percent) => {
    console.log(`Image ${index}: ${Math.round(percent)}%`);
  },
});
```

### 9. Web Worker Conversion

Run the conversion inside a Web Worker so the main thread stays responsive. Create a worker script that uses this library:

```js
// converter.worker.js
import { convertHeic } from '@keeratita/heic-converter';

self.onmessage = async (event) => {
  const { input, options } = event.data;
  try {
    const blob = await convertHeic(input, {
      ...options,
      onProgress: (percent) => self.postMessage({ type: 'progress', percent }),
    });
    self.postMessage({ type: 'result', ok: true, blob });
  } catch (error) {
    self.postMessage({ type: 'result', ok: false, error: error?.stack ?? error?.message ?? String(error) });
  }
};
```

Then convert from the main thread:

```typescript
import { convertHeicInWorker } from '@keeratita/heic-converter';

const jpegBlob = await convertHeicInWorker(heicBlob, {
  workerUrl: new URL('./converter.worker.js', import.meta.url),
  workerType: 'module',
  to: 'jpeg',
  quality: 0.9,
  onProgress: (percent) => console.log(`${Math.round(percent)}%`),
});
```

> [!NOTE]
> - Use `workerType: 'module'` when the worker script uses ES module imports (as in the example above). The default is `'classic'`, which requires the script to be pre-bundled (e.g. by Vite or webpack) — static ES imports are not supported in classic workers.
> - `workerUrl` should be a compile-time constant; the script runs with the page's privileges.
> - Only `progress` and `result` messages are understood; any other message type is ignored.
> - `decoder`, `onProgress`, and `workerUrl` are not structured-cloneable, so they are not sent to the worker. Progress is forwarded through `{ type: 'progress', percent }` messages instead.
> - `timeoutMs` (default `60000`) bounds how long the promise waits for a result; set `0` to disable.
> - This helper is **browser-only**: it rejects in Node.js, where there is no global `Worker`.

---

## 🔒 Content Security Policy (CSP)

To comply with strict CSP guidelines, ensure your server headers allow running WebAssembly:

```http
Content-Security-Policy: default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; img-src 'self' blob: data:;
```

> [!NOTE]
> `'wasm-unsafe-eval'` is a CSP Level 3 directive that allows compiling and executing WebAssembly modules without opening the security risks of general JavaScript `'unsafe-eval'`.

---

## 📖 API Reference

### `convertHeic(input, options?)`

Converts a HEIC image file to a standard web format.

- **`input`**: `Blob | File | ArrayBuffer | Uint8Array`
- **`options`**: (optional) `ConvertOptions`
  - `to`: `'jpeg' | 'jpg' | 'png' | 'webp' | 'svg'` (Default: `'jpeg'`)
  - `quality`: `number` (0.0 to 1.0, applicable to JPEG and WebP. Default: `0.92`)
  - `decoder`: `IHeicDecoder` (Inject custom decoder instance)
  - `onProgress`: `(percent: number) => void` (Optional callback, receives progress percentage from `0` to `100` during decoding)
  - `maxWidth`: `number` (Downscale to fit within this width, preserving aspect ratio. Never upscales)
  - `maxHeight`: `number` (Downscale to fit within this height, preserving aspect ratio. Never upscales)
  - `scale`: `number` (Uniform scale factor, e.g. `0.5` halves the image. Takes precedence over `maxWidth`/`maxHeight`)
- **Returns**: `Promise<Blob>`

### `convertMany(inputs, options?)`

Converts multiple HEIC images with bounded concurrency. Results are returned in input order; rejects as soon as a conversion fails, with an error identifying the failing item index.

- **`inputs`**: `Array<Blob | File | ArrayBuffer | Uint8Array>`
- **`options`**: (optional) `ConvertManyOptions` — same as `ConvertOptions`, except `onProgress` uses the batch signature below; plus:
  - `concurrency`: `number` (Maximum concurrent conversions. Default: `4`)
  - `onProgress`: `(index: number, percent: number) => void` (Per-item progress callback)
  - `decoder`: `IHeicDecoder` (Optional. When provided, the same instance is shared by all concurrent conversions and must be safe for concurrent `decode()` calls)
- **Returns**: `Promise<Blob[]>`

### `convertHeicInWorker(input, options)`

Converts a HEIC image inside a Web Worker. The worker script must implement the message protocol shown in [Usage section 9](#9-web-worker-conversion). Browser-only; rejects in Node.js.

- **`input`**: `Blob | File | ArrayBuffer | Uint8Array`
- **`options`**: `WorkerConvertOptions` — same as `ConvertOptions`, plus:
  - `workerUrl`: `string | URL` (URL of the worker script; should be a compile-time constant)
  - `workerType`: `'classic' | 'module'` (Worker script type. Default: `'classic'`; use `'module'` for scripts with ES imports)
  - `timeoutMs`: `number` (Maximum wait for the result in milliseconds. Default: `60000`; `0` disables)
- **Returns**: `Promise<Blob>`

### `LibheifDecoder(options?)`

The default WASM-based implementation of `IHeicDecoder`.

- **`options`**: (optional) `LibheifDecoderOptions`
  - `locateFile`: `(path: string, prefix: string) => string`
  - `wasmBinary`: `ArrayBuffer`
- **Methods**:
  - `initialize(): Promise<void>`: Loads and initializes the WASM wrapper. Safe to call concurrently; the module loads at most once per instance.
  - `decode(data: Uint8Array, onProgress?: (percent: number) => void): Promise<DecodedImage>`: Decodes the HEIC bytes to raw RGBA, with optional progress callback. Returns an independent copy of the pixel data — safe to use after `free()`.
  - `free(): void`: Releases allocated WebAssembly heap memory. Idempotent.

### `freeSharedDecoder()`

Kept for **API compatibility**. Decoders are now created and released per conversion, so there is no shared instance to release — calling this function is a no-op.

```typescript
import { freeSharedDecoder } from '@keeratita/heic-converter';

// After you finish converting all images
freeSharedDecoder();
```

---

## 🛠️ Development & Compiling

If you want to build or modify the WASM wrapper, you will need **Docker** installed.

### Build WebAssembly

To compile the underlying `libheif` and `libde265` libraries from source using Emscripten:

```bash
npm run build:wasm
```

### Build JS & TS Typings

To compile the TypeScript library code to ESM/CJS bundles under the `dist/` directory:

```bash
npm run build
```

### Run Unit Tests

```bash
npm run test
```

### Run Browser E2E Tests

Real browser conversions against the CSP sandbox and the GitHub Pages demo (`docs/`):

```bash
npx playwright install chromium   # one-time
npm run test:e2e
```

### Run Interactive CSP Sandbox

To test the converter in a local browser running under a strict Content Security Policy, start the sandbox server:

```bash
npm run sandbox
```

Then navigate to: `http://localhost:3000`

### Release / Versioning

To bump the package version (following SemVer) and push the release commits/tags to the git remote:

```bash
npm run release
```

Alternatively, you can pass the release type as an argument:

```bash
npm run release patch
npm run release minor
npm run release major
npm run release current
```

This script will automatically run the linter, build the TS library, run the unit tests. For `patch`, `minor`, and `major`, it bumps the version (updating `package.json`/`package-lock.json`), commits the changes with a Conventional Commit message (`chore(release): X.Y.Z`), tags the commit, and pushes both the commit and tag to the remote. For `current`, it simply tags the current commit with the existing version in `package.json` (e.g. `vX.Y.Z`) and pushes that tag to the remote without committing or altering files.

---

## 📄 License

MIT © Keerati Tansawatcharoen
