# @keeratita/heic-converter

A modern, lightweight TypeScript library to convert `.heic` and `.heif` images to standard web formats (JPEG, PNG, SVG) client-side in the browser or on the backend in Node.js.

Designed specifically for environments with strict **Content Security Policy (CSP)** rules, it is built with WebAssembly compiled **without** dynamic code execution (`eval()` or `new Function()`).

---

## ✨ Features

- 🔒 **CSP Compliant**: Emscripten glue code is compiled with `-s DYNAMIC_EXECUTION=0`. Safe to run without `'unsafe-eval'`.
- 🧩 **Dependency Injection Architecture**: Swap the decoder module easily by implementing a simple `IHeicDecoder` interface.
- ⚡ **Optimized Performance**: Reuses a single shared WASM instance across calls by default. Decodes an image in milliseconds.
- 🌐 **Isomorphic / Universal**: Runs in Node.js (decoding) and browser (decoding & canvas-based encoding).
- 📦 **No Bloat**: Zero external production dependencies. Small footprint.
- 🎨 **Format Support**: Convert to `jpeg` (with quality configuration), `png`, and `svg` (embedded lossless vector).

---

## 📦 Installation

```bash
npm install @keeratita/heic-converter
```

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

### 2. Browser: Serving and Locating WASM (Custom Assets Path)

By default, the library tries to fetch `heic-decoder.wasm` relative to the current module script path (`import.meta.url`). 

If your bundler places files in a custom assets folder or CDN, you can configure the default decoder or inject a custom one:

```typescript
import { convertHeic, LibheifDecoder } from '@keeratita/heic-converter';

// Create decoder with custom asset paths
const decoder = new LibheifDecoder({
  locateFile: (path, prefix) => `https://cdn.example.com/assets/${path}`
});

// Pass the custom decoder in options
const pngBlob = await convertHeic(heicBlob, {
  to: 'png',
  decoder: decoder
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
  decoder: decoder
});
```

### 3. Node.js: Decoding Raw Pixel Data

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
  
  // Decodes to { width, height, data: Uint8ClampedArray (RGBA) }
  const { width, height, data } = await decoder.decode(heicData);
  
  // Process raw pixels using sharp
  await sharp(Buffer.from(data.buffer), {
    raw: { width, height, channels: 4 }
  })
  .toFormat('jpeg')
  .toFile('output.jpg');
  
  // Clean up WASM memory
  decoder.free();
}
```

### 4. Progress Tracking (e.g. for Large Images)

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
  - `to`: `'jpeg' | 'jpg' | 'png' | 'svg'` (Default: `'jpeg'`)
  - `quality`: `number` (0.0 to 1.0, only applicable to JPEG. Default: `0.92`)
  - `decoder`: `IHeicDecoder` (Inject custom decoder instance)
  - `onProgress`: `(percent: number) => void` (Optional callback, receives progress percentage from `0` to `100` during decoding)
- **Returns**: `Promise<Blob>`

### `LibheifDecoder(options?)`

The default WASM-based implementation of `IHeicDecoder`.

- **`options`**: (optional) `LibheifDecoderOptions`
  - `locateFile`: `(path: string, prefix: string) => string`
  - `wasmBinary`: `ArrayBuffer`
- **Methods**:
  - `initialize(): Promise<void>`: Loads and initializes the WASM wrapper.
  - `decode(data: Uint8Array, onProgress?: (percent: number) => void): Promise<DecodedImage>`: Decodes the HEIC bytes to raw RGBA, with optional progress callback.
  - `free(): void`: Releases allocated WebAssembly heap memory.

### `freeSharedDecoder()`

The library keeps a shared instance of `LibheifDecoder` to speed up subsequent calls. Call `freeSharedDecoder()` when your application is done converting images to release memory.

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

