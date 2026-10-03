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
- 🧭 **EXIF-Orientation Aware**: Images stored rotated with an EXIF orientation flag come out upright, matching what viewers display. Opt out with `applyOrientation: false`.
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
const input = document.querySelector<HTMLInputElement>('#fileInput')!.files!.item(0)!;
const jpegBlob = await convertHeic(input, {
  to: 'jpeg',
  quality: 0.9,
});

// Create preview URL
const preview = document.querySelector('img');
if (preview) {
  preview.src = URL.createObjectURL(jpegBlob);
}
```

### 2. Browser: WebP Output

WebP offers excellent compression with quality configuration:

```typescript
import { convertHeic } from '@keeratita/heic-converter';

declare const heicBlob: Blob; // your HEIC file/blob

const webpBlob = await convertHeic(heicBlob, {
  to: 'webp',
  quality: 0.8,
});
```

### 3. Browser: SVG Output

SVG wraps the raster image as an embedded lossless PNG inside an SVG container:

```typescript
import { convertHeic } from '@keeratita/heic-converter';

declare const heicBlob: Blob; // your HEIC file/blob

const svgBlob = await convertHeic(heicBlob, {
  to: 'svg',
});
```

### 4. Browser: Serving and Locating WASM (Custom Assets Path)

By default, the library tries to fetch `heic-decoder.wasm` relative to the current module script path (`import.meta.url`).

If your bundler places files in a custom assets folder or CDN, you can configure the default decoder or inject a custom one:

```typescript
import { convertHeic, LibheifDecoder } from '@keeratita/heic-converter';

declare const heicBlob: Blob; // your HEIC file/blob

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

declare const heicBlob: Blob; // your HEIC file/blob

const wasmResponse = await fetch('/assets/heic-decoder.wasm');
const wasmBinary = await wasmResponse.arrayBuffer();

const decoder = new LibheifDecoder({ wasmBinary });

const jpegBlob = await convertHeic(heicBlob, {
  to: 'jpeg',
  decoder: decoder,
});
```

#### Using a bundler (Vite, webpack, Rollup, esbuild)

The main entry is a small lazy loader: the Emscripten glue ships as a dynamic-import chunk and the `.wasm` binary is **not** inlined — you must make sure `dist/heic-decoder.wasm` is served and resolvable at runtime. Bundlers that rewrite asset URLs usually handle this automatically because the glue resolves the binary relative to its own chunk. If yours doesn't, copy the binary into your assets (the `@keeratita/heic-converter/wasm` subpath export resolves to the file itself, handy as a copy source) and point the decoder at it:

```typescript
import { convertHeic, LibheifDecoder } from '@keeratita/heic-converter';

declare const heicBlob: Blob;

// Serve a copy of @keeratita/heic-converter/dist/heic-decoder.wasm there.
const blob = await convertHeic(heicBlob, {
  decoder: new LibheifDecoder({ locateFile: () => '/assets/heic-decoder.wasm' }),
});
```

Fetching a `.gz`/`.br` variant URL directly will not work — see the compression note below.

#### Reducing the download size

The WASM binary (~1.2 MB) dominates the payload. Everything else is small and lazy: the Emscripten glue (~65 KB) is a separate chunk fetched only on the first decode, and the main entry is ~9 KB.

`npm run build` also emits pre-compressed copies — `dist/heic-decoder.wasm.gz` (~397 KB) and `dist/heic-decoder.wasm.br` (~294 KB). Most static hosts and CDNs (GitHub Pages, Netlify, Vercel, Cloudflare) already compress `application/wasm` automatically when the browser sends `Accept-Encoding`; verify with:

```bash
curl -sI -H 'Accept-Encoding: br' https://your-site/heic-decoder.wasm | grep -i content-encoding
```

If your server does not compress automatically, serve the pre-compressed files with the matching `Content-Encoding` header (nginx: `gzip_static on;` / `brotli_static on;`). Do **not** point `locateFile` at a `.br`/`.gz` URL — the browser only decompresses responses tagged with `Content-Encoding`.

For long-lived caching, serve the WASM with `Cache-Control: public, max-age=31536000, immutable` and rename it per release (e.g. `heic-decoder-1.2.3.wasm` via `locateFile`) so clients pick up upgrades. GitHub Pages caps asset cache lifetime at 600s; put a CDN in front if that matters.

### 5. Node.js: Decoding Raw Pixel Data

Since Node.js lacks the native browser Canvas API, `convertHeic` (which relies on Canvas to encode raster formats) will throw an error on the backend.

However, you can use the `LibheifDecoder` in Node.js to retrieve the raw RGBA pixels and then encode them using libraries like `sharp` or `pngjs`:

```typescript
import fs from 'fs';
import { LibheifDecoder } from '@keeratita/heic-converter';
import sharp from 'sharp'; // external node image library

async function convertNode() {
  const heicData = new Uint8Array(fs.readFileSync('input.heic'));

  // Passing wasmBinary explicitly avoids relying on default path resolution
  // inside the package; fs.readFileSync returns a Buffer, which the option
  // accepts (it takes ArrayBuffer or any ArrayBufferView).
  const decoder = new LibheifDecoder({
    wasmBinary: fs.readFileSync(
      'node_modules/@keeratita/heic-converter/dist/heic-decoder.wasm',
    ),
  });
  await decoder.initialize();

  // Decodes to { width, height, data: Uint8ClampedArray (RGBA), orientation? }.
  // data is an independent copy — safe to use after decoder.free().
  // orientation 2-8 means the stored pixels need a rotation for display
  // (convertHeic applies it automatically; raw-decode consumers must do it
  // themselves, e.g. by rotating the buffer or passing it to sharp).
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

declare const heicBlob: Blob; // your HEIC file/blob

const jpegBlob = await convertHeic(heicBlob, {
  to: 'jpeg',
  onProgress: (percent) => {
    console.log(`Conversion progress: ${Math.round(percent)}%`);
    // Update progress bar UI
  }
});
```

> [!NOTE]
> The callback contract is enforced by the library: `percent` is always a finite number clamped to `0`–`100` (first call `0`, last call `100`). If your callback throws, the conversion rejects with a `progress_callback_failed` error naming your message — the failure is attributed to the callback instead of crashing the WASM module.

> [!TIP]
> Since the WebAssembly module runs on the main browser thread, the UI thread will be occupied during conversion. For maximum responsiveness when converting large images, it is highly recommended to run this library inside a standard JS **Web Worker** and communicate progress back to the main thread.

### 7. Resizing Images

Downscale to fit within maximum dimensions (aspect ratio is preserved, images smaller than the bounds are never upscaled):

```typescript
import { convertHeic } from '@keeratita/heic-converter';

declare const heicBlob: Blob; // your HEIC file/blob

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

> [!NOTE]
> Target dimensions are validated before any decoding work: `scale`, `maxWidth`, and `maxHeight` must be positive finite numbers (otherwise an `invalid_resize` error is thrown), and the resulting target size must not exceed **16384 px** on either side — the canvas/WASM ceiling shared with the decoder's own security limits.

### 8. Orientation (EXIF) Handling

Some HEIC files are stored rotated, with the intended display rotation recorded in the EXIF orientation tag (274). Browsers, Photos, and most image viewers apply that rotation when displaying — so `convertHeic` uprights the output for you during rendering:

```typescript
import { convertHeic } from '@keeratita/heic-converter';

// Upright according to the source's EXIF orientation (default: applyOrientation: true)
const jpeg = await convertHeic(heicFile);

// Keep the exact stored-pixel geometry instead (the pre-0.5 behavior):
const unrotated = await convertHeic(heicFile, { applyOrientation: false });
```

How it works:

- HEIF's native display-transform boxes (`irot`/`imir`) are applied by the decoder itself during `decode()` — `convertHeic` never stacks a second rotation on top, so Apple-style files are never double-rotated.
- When a file carries only the EXIF tag (the class written by tools that just rewrite metadata), `convertHeic` applies the rotation/flip via a canvas transform.
- `LibheifDecoder.decode()` returns the raw **stored** pixels and reports a pending rotation via the optional `orientation` field (EXIF semantics `1`–`8`; absent or `1` means nothing is pending). If you encode the pixels yourself (e.g. Node.js + `sharp`), apply the rotation yourself.
- A non-boolean `applyOrientation` value is rejected up front with an `invalid_input` error.

### 9. Batch Conversion

Convert many images at once with bounded concurrency (default `4`). Results are returned in input order; if any conversion fails, the promise rejects as soon as the failure is known with an error that identifies the failing item:

```typescript
import { convertMany } from '@keeratita/heic-converter';

declare const heicFiles: File[]; // your HEIC files/blobs

const blobs = await convertMany(heicFiles, {
  to: 'png',
  concurrency: 3,
  onProgress: (index, percent) => {
    console.log(`Image ${index}: ${Math.round(percent)}%`);
  },
});
```

Batch semantics worth knowing:

- The promise rejects with the **first failure in time** (not the lowest index). All items are still allowed to finish; decoders of in-flight items are released when they settle.
- The rejection is a `batch_item_failed` error carrying structured fields: `itemIndex` (0-based index of the first failing item), `itemTotal`, `failedCount` (total items that failed), and `cause` (the underlying error). The message names the failing item and, when several items failed, summarizes the count and the other errors.
- `onProgress` only fires for items that succeed; a failing item never reports 100%.
- `concurrency` must be a positive integer; the default is `4`.

### 10. Web Worker Conversion

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

declare const heicBlob: Blob; // your HEIC file/blob

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
> - Only `progress` and `result` messages are understood; any other message type is ignored — but ignored messages are counted and surfaced in timeout diagnostics (see below).
> - `decoder` cannot cross the worker boundary: passing it rejects immediately with an `invalid_input` error (it is also absent from `WorkerConvertOptions` at compile time). `onProgress` and `workerUrl` are stripped from the posted message; progress is forwarded through `{ type: 'progress', percent }` messages instead.
> - Concurrent calls are bounded per worker script: calls beyond `maxConcurrentWorkers` queue and start as slots free. Default: `navigator.hardwareConcurrency` clamped to 1–8 (4 when unavailable).
> - `timeoutMs` (default `60000`) bounds how long the promise waits for a result; set `0` to disable. A timeout rejects with a `worker_timeout` error whose message includes diagnostics — how many progress messages arrived, the last percent, and any unrecognized message type (the usual sign the worker script doesn't implement the protocol).
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
  - `applyOrientation`: `boolean` (Rotate/flip the output to match the source's EXIF orientation. `irot`/`imir` transforms are already applied by the decoder and never stacked. Default: `true`)
- **Returns**: `Promise<Blob>`

### `convertMany(inputs, options?)`

Converts multiple HEIC images with bounded concurrency. Results are returned in input order; rejects with the first failure in time — a `batch_item_failed` error whose `message` names the failing item and whose fields describe the batch (`itemIndex` 0-based, `itemTotal`, `failedCount`, `cause`).

- **`inputs`**: `Array<Blob | File | ArrayBuffer | Uint8Array>`
- **`options`**: (optional) `ConvertManyOptions` — same as `ConvertOptions`, except `onProgress` uses the batch signature below; plus:
  - `concurrency`: `number` (Maximum concurrent conversions. Default: `4`)
  - `onProgress`: `(index: number, percent: number) => void` (Per-item progress callback; fires only for successful items)
  - `decoder`: `IHeicDecoder` (Optional. When provided, the same instance is shared by all concurrent conversions and must be safe for concurrent `decode()` calls; the library never frees an injected decoder)
- **Returns**: `Promise<Blob[]>`

### `convertHeicInWorker(input, options)`

Converts a HEIC image inside a Web Worker. The worker script must implement the message protocol shown in [Usage section 10](#10-web-worker-conversion). Browser-only; rejects in Node.js.

- **`input`**: `Blob | File | ArrayBuffer | Uint8Array`
- **`options`**: `WorkerConvertOptions` — same as `ConvertOptions` but without `decoder` (cannot be structured-cloned; passing one rejects with `invalid_input`), plus:
  - `workerUrl`: `string | URL` (URL of the worker script; should be a compile-time constant)
  - `workerType`: `'classic' | 'module'` (Worker script type. Default: `'classic'`; use `'module'` for scripts with ES imports)
  - `timeoutMs`: `number` (Maximum wait for the result in milliseconds. Default: `60000`; `0` disables)
  - `maxConcurrentWorkers`: `number` (Concurrent workers per `workerUrl` + type; extra calls queue. Default: `navigator.hardwareConcurrency` clamped to 1–8)
- **Returns**: `Promise<Blob>`

### `LibheifDecoder(options?)`

The default WASM-based implementation of `IHeicDecoder`.

- **`options`**: (optional) `LibheifDecoderOptions`
  - `locateFile`: `(path: string, prefix: string) => string`
  - `wasmBinary`: `ArrayBuffer | ArrayBufferView` (e.g. a Node.js `Buffer` from `fs.readFileSync`)
  - `moduleOverrides`: `Record<string, unknown>` (Advanced: merged into the Emscripten module arguments, e.g. `instantiateWasm`)
- **Methods**:
  - `initialize(): Promise<void>`: Loads and initializes the WASM wrapper. Safe to call concurrently; the module loads at most once per instance.
  - `decode(data: Uint8Array, onProgress?: (percent: number) => void): Promise<DecodedImage>`: Decodes the HEIC bytes to raw RGBA, with optional progress callback (normalized to finite `0`–`100`). Returns JS-owned pixel data — safe to use after `free()`. The result carries an optional `orientation` field (`2`–`8`, EXIF semantics) when the stored pixels need a rotation for display that the decoder did not itself apply (EXIF-tag-only files); absent or `1` means the pixels are upright. Safe to call after `free()`: the instance transparently re-initializes.
  - `free(): void`: Releases the WASM module and decoder instance. Idempotent, and safe to call while `initialize()` is in flight (the in-flight load is discarded).

### Error handling

All errors thrown by this library are `HeicConverterError` instances (`extends Error`) with a machine-readable `code`, and — where relevant — a `cause` and batch fields:

| `code` | Thrown by | Meaning |
| --- | --- | --- |
| `invalid_input` | `convertHeic`, `convertMany`, `convertHeicInWorker` | Unsupported input type; non-boolean `applyOrientation`; or worker helper called with a `decoder` |
| `invalid_quality` | `convertHeic`, `convertMany` | `quality` outside `0.0`–`1.0` or not a finite number |
| `invalid_resize` | `convertHeic`, `convertMany` | `scale`/`maxWidth`/`maxHeight` not positive finite numbers, or target size exceeds 16384 px |
| `invalid_format` | `convertHeic`, `convertMany` | Unknown `to` value |
| `invalid_concurrency` | `convertMany` | `concurrency` not a positive integer |
| `decoder_init_failed` | `convertHeic`, `convertMany` | WASM module could not be loaded (missing asset, CSP block) |
| `decode_failed` | `convertHeic`, `convertMany` | Invalid/corrupt HEIC bytes |
| `unsupported_environment` | `convertHeic`, `convertMany`, `convertHeicInWorker` | No canvas APIs (e.g. Node.js) or no `Worker` global; decode raw RGBA via `LibheifDecoder` instead |
| `render_encode_failed` | `convertHeic`, `convertMany` | Canvas render/encode failure (bad dimensions, `toBlob` returned null) |
| `progress_callback_failed` | all conversion APIs | The host `onProgress` callback threw; message attributes the failure |
| `worker_unsupported` | `convertHeicInWorker` | No global `Worker` (e.g. Node.js) |
| `worker_create_failed` | `convertHeicInWorker` | `new Worker(...)` threw (wrong URL, MIME type) |
| `worker_post_failed` | `convertHeicInWorker` | `postMessage` threw (non-cloneable option) |
| `worker_timeout` | `convertHeicInWorker` | No result within `timeoutMs`; message includes progress/protocol diagnostics |
| `worker_failed` | `convertHeicInWorker` | Worker reported `{ type: 'result', ok: false, error }` |
| `batch_item_failed` | `convertMany` | One or more items failed; see `itemIndex`/`itemTotal`/`failedCount`/`cause` |

```typescript
import { convertHeic, type HeicConverterErrorCode } from '@keeratita/heic-converter';

try {
  await convertHeic(input, { to: 'png' });
} catch (error) {
  const code: HeicConverterErrorCode | undefined =
    error && typeof error === 'object' && 'code' in error
      ? (error as { code?: HeicConverterErrorCode }).code
      : undefined;
  if (code === 'unsupported_environment') {
    // e.g. Node.js: decode raw RGBA with LibheifDecoder and encode externally
  }
}
```

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

To compile the underlying [`libheif`](https://github.com/strukturag/libheif) and [`libde265`](https://github.com/strukturag/libde265) libraries from source using Emscripten:

```bash
npm run build:wasm
```

See [WASM_DEPENDENCIES.md](WASM_DEPENDENCIES.md) for the pinned upstream library versions.

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
