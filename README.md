# @keeratita/heic-converter

A modern, lightweight TypeScript library to convert `.heic` and `.heif` images to standard web formats (JPEG, PNG, WebP, AVIF, SVG) client-side in the browser or on the backend in Node.js.

Designed specifically for environments with strict **Content Security Policy (CSP)** rules, it is built with WebAssembly compiled **without** dynamic code execution (`eval()` or `new Function()`).

---

## ✨ Features

- 🔒 **CSP Compliant**: Emscripten glue code is compiled with `-s DYNAMIC_EXECUTION=0`. Safe to run without `'unsafe-eval'`.
- 🧩 **Dependency Injection Architecture**: Swap the decoder module easily by implementing a simple `IHeicDecoder` interface.
- ⚡ **Optimized Performance**: A fresh decoder instance is created and released per conversion — memory is reclaimed promptly and concurrent conversions never share mutable WASM state. `convertMany({ reuseDecoders: true })` amortizes WASM init across batch items.
- 🌐 **Isomorphic / Universal**: Runs in Node.js (decoding) and browser (decoding & canvas-based encoding).
- 📦 **No Bloat**: Zero external production dependencies. Small footprint.
- 🎨 **Format Support**: Convert to `jpeg` (with quality configuration), `png`, `webp`, `avif`, and `svg` (the encoded raster wrapped in an SVG document). AVIF degrades gracefully with a clear `format_unsupported` error where the canvas cannot encode it.
- 📐 **Resize & Crop**: Downscale with `maxWidth`/`maxHeight` or apply a uniform `scale` factor; cut any region with `crop` (in display pixels, composed with orientation).
- 🧭 **EXIF-Orientation Aware**: Images stored rotated with an EXIF orientation flag come out upright, matching what viewers display. Opt out with `applyOrientation: false`.
- 🗂 **Metadata Preservation**: `preserveExif: true` keeps the source EXIF block in JPEG (APP1) and PNG (`eXIf`) output; raw-decode consumers get the block via `DecodedImage.exif`.
- 📚 **Batch Conversion**: Convert many images at once with bounded concurrency via `convertMany` — with per-item results (`continueOnError`) and pooled decoders (`reuseDecoders`) for large batches.
- 🧵 **Web Worker Helpers**: Offload single conversions (`convertHeicInWorker`) or whole batches (`convertManyInWorker`) to Web Workers to keep the UI thread responsive.
- 🎛 **Output Shapes & Cancellation**: Return Blobs, base64 data URLs, or ArrayBuffers (`output`), and cancel in-flight work with an `AbortSignal` (`signal`) — worker conversions terminate immediately.

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

The WASM binary (~1.3 MB) dominates the payload. Everything else is small and lazy: the Emscripten glue (~67 KB) is a separate chunk fetched only on the first decode, the Web Worker implementation (~5 KB) and the opt-in EXIF injectors (~2.7 KB) are separate chunks fetched only when you first call `convertHeicInWorker`/`convertManyInWorker` or pass `preserveExif: true`, and the code every consumer pays for up front is ~19.5 KB (~7.2 KB gzipped).

`npm run build` also emits pre-compressed copies — `dist/heic-decoder.wasm.gz` (~421 KB) and `dist/heic-decoder.wasm.br` (~312 KB). Most static hosts and CDNs (GitHub Pages, Netlify, Vercel, Cloudflare) already compress `application/wasm` automatically when the browser sends `Accept-Encoding`; verify with:

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

  // Decodes to { width, height, data: Uint8ClampedArray (RGBA), orientation?, exif? }.
  // data is an independent copy — safe to use after decoder.free().
  // orientation 2-8 means the stored pixels need a rotation/flip for display
  // (convertHeic applies it automatically; raw-decode consumers must do it
  // themselves — rotate the buffer, or set the orientation tag in `exif`
  // before handing it to sharp so viewers apply it).
  // exif is the source EXIF block ("Exif\0\0" + TIFF) when the file carries
  // one — pass it to sharp.withMetadata({ exif }) to keep camera metadata.
  const { width, height, data, exif } = await decoder.decode(heicData);

  // Process raw pixels using sharp
  let pipeline = sharp(Buffer.from(data), {
    raw: { width, height, channels: 4 },
  });
  if (exif) {
    pipeline = pipeline.withMetadata({ exif: Buffer.from(exif) });
  }
  await pipeline.toFormat('jpeg').toFile('output.jpg');

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

### 9. Cropping

Cut a rectangle out of the image during conversion. Crop coordinates are in **post-orientation display pixels** — the geometry the image is shown in (after any EXIF/irot correction), which is what "top-left corner" means to a user. The crop is applied before `scale`/`maxWidth`/`maxHeight`, which then downscale the cropped region:

```typescript
import { convertHeic } from '@keeratita/heic-converter';

declare const heicBlob: Blob; // your HEIC file/blob

const thumbnail = await convertHeic(heicBlob, {
  to: 'jpeg',
  crop: { x: 200, y: 100, width: 640, height: 480 }, // x/y default to 0
  maxWidth: 320, // downscale the crop, not the whole image
});
```

Cropping semantics:

- `width`/`height` are required positive integers; `x`/`y` are optional non-negative integers. Malformed values reject with `invalid_crop` **before** any decoding; a rectangle that exceeds the image rejects with `invalid_crop` naming the actual display size.
- Crop, orientation, and resize compose into a single canvas transform — no intermediate copies.
- With `applyOrientation: false`, crop coordinates address the **stored** pixels instead (geometry as decoded).

### 10. Output Shapes (Blob, data URL, ArrayBuffer)

By default conversions return a `Blob`. Choose another representation with `output` — the return type follows the option:

```typescript
const dataUrl = await convertHeic(heicBlob, { to: 'png', output: 'dataUrl' });
// string: "data:image/png;base64,…" — ready for <img src>

const bytes = await convertHeic(heicBlob, { to: 'webp', output: 'arrayBuffer' });
// ArrayBuffer — for uploads (fetch body), WebCodecs, custom pipelines

const blob = await convertHeic(heicBlob, { to: 'jpeg' }); // default Blob
```

`output` applies to `convertMany` and `convertManyInWorker` too (in the worker case the chosen representation travels back through the worker protocol — `arrayBuffer` results arrive as a structured-clone copy, never a base64 round-trip; a custom worker script can additionally transfer the buffer with `postMessage(msg, [msg.blob])`). Invalid values reject with `invalid_input`.

### 11. Canceling a Conversion (AbortSignal)

Pass an `AbortSignal` to cancel pending work. Cancellation is checked at stage boundaries (after input read, before/after decode, before encode), so a queued or in-flight conversion stops promptly and rejects with the `aborted` code:

```typescript
import { convertHeic, convertHeicInWorker } from '@keeratita/heic-converter';

const controller = new AbortController();
setTimeout(() => controller.abort(), 2000); // give up after 2s

await convertHeic(heicBlob, { signal: controller.signal }); // rejects with code 'aborted'
await convertMany(files, { signal: controller.signal }); // aborts remaining items
await convertHeicInWorker(heicBlob, { workerUrl, signal: controller.signal }); // terminates the worker
```

> [!NOTE]
> - Worker-based conversions abort **immediately**: the worker is terminated, since it runs off the main thread.
> - The synchronous WASM `decode()` on the main thread cannot be preempted mid-call — cancellation takes effect at the next boundary after it finishes.
> - In `convertMany`, an aborted batch rejects with `aborted` (cancellation is the outcome you asked for, and it wins over item-failure aggregation). With `continueOnError`, already-started items record `aborted` errors per item.

### 12. Batch Conversion

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

**Keeping going after failures** — with `continueOnError: true` the batch never rejects for item failures. Every item runs, and you get a result entry per item in input order:

```typescript
const results = await convertMany(files, { to: 'png', continueOnError: true });
// Array<{ index: number; ok: true; result: Blob } | { index: number; ok: false; error: Error }>

const failures = results.filter((r) => !r.ok);
if (failures.length > 0) {
  console.warn(`${failures.length} file(s) failed`, failures.map((f) => f.index));
}
```

Up-front validation mistakes (bad format, bad `concurrency`, …) still reject normally — a typo is a caller bug, not an item failure.

**Pooling decoders for big batches** — by default each item gets its own decoder instance (created, WASM-initialized, freed per item). For batches much larger than the concurrency, `reuseDecoders: true` hands each batch runner one pooled instance that is reused across items — the WASM module load is amortized while the exclusive-use invariant holds (an instance never decodes two things at once):

```typescript
const blobs = await convertMany(thousandFiles, {
  to: 'webp',
  concurrency: 4,
  reuseDecoders: true, // one LibheifDecoder per runner instead of one per item
});
```

Ignored when you inject your own `decoder` (yours is used for all items, per the injection contract).

### 13. Web Worker Conversion

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
    // With output: 'arrayBuffer' the payload is zero-copy via a transfer list.
    self.postMessage(
      { type: 'result', ok: true, blob },
      blob instanceof ArrayBuffer ? [blob] : []
    );
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
> - Concurrent calls are bounded per worker script: calls beyond `maxConcurrentWorkers` queue and start as slots free. Must be a positive integer (`invalid_concurrency` otherwise). Default: `navigator.hardwareConcurrency` clamped to 1–8 (4 when unavailable).
> - `timeoutMs` (default `60000`) bounds how long the promise waits for a result; must be a finite number ≥ 0, `0` disables. The deadline starts when the call is made, so time spent queued behind `maxConcurrentWorkers` counts toward it — raise `timeoutMs` or `maxConcurrentWorkers` for very large batches. A timeout rejects with a `worker_timeout` error whose message includes diagnostics — how many progress messages arrived, the last percent, and any unrecognized message type (the usual sign the worker script doesn't implement the protocol).
> - This helper is **browser-only**: it rejects in Node.js, where there is no global `Worker`.

**Batch inside workers** — `convertManyInWorker` mirrors `convertMany` (input order, `batch_item_failed` aggregation or `continueOnError` per-item results) while each item runs in a worker; real concurrency is bounded by `maxConcurrentWorkers`:

```typescript
import { convertManyInWorker } from '@keeratita/heic-converter';

const blobs = await convertManyInWorker(files, {
  workerUrl: new URL('./converter.worker.js', import.meta.url),
  workerType: 'module',
  to: 'webp',
  maxConcurrentWorkers: 3,
  onProgress: (index, percent) => console.log(`Image ${index}: ${Math.round(percent)}%`),
});
```

Every option of `convertHeicInWorker` applies (`output`, `signal`, `crop`, `preserveExif`, `timeoutMs`, …); `onProgress` receives the item `index` in addition to the percent, and a mid-batch abort terminates the running workers.

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
  - `to`: `'jpeg' | 'jpg' | 'png' | 'webp' | 'avif' | 'svg'` (Default: `'jpeg'`; `avif` rejects with `format_unsupported` where the canvas cannot encode it)
  - `quality`: `number` (0.0 to 1.0, applicable to JPEG, WebP, and AVIF. Default: `0.92`)
  - `decoder`: `IHeicDecoder` (Inject custom decoder instance)
  - `onProgress`: `(percent: number) => void` (Optional callback, receives progress percentage from `0` to `100` during decoding)
  - `maxWidth`: `number` (Downscale to fit within this width, preserving aspect ratio. Never upscales)
  - `maxHeight`: `number` (Downscale to fit within this height, preserving aspect ratio. Never upscales)
  - `scale`: `number` (Uniform scale factor, e.g. `0.5` halves the image. Takes precedence over `maxWidth`/`maxHeight`)
  - `applyOrientation`: `boolean` (Rotate/flip the output to match the source's EXIF orientation. `irot`/`imir` transforms are already applied by the decoder and never stacked. Default: `true`)
  - `crop`: `{ x?, y?, width, height }` (Cut a rectangle in post-orientation display pixels before resize. Default: none)
  - `preserveExif`: `boolean` (Re-inject the source EXIF block into JPEG (APP1) / PNG (`eXIf`) output. Metadata may contain GPS — opt-in. Default: `false`)
  - `output`: `'blob' | 'dataUrl' | 'arrayBuffer'` (Result representation. Default: `'blob'`; see [Usage section 10](#10-output-shapes-blob-data-url-arraybuffer))
  - `signal`: `AbortSignal` (Cancel pending work; rejects with `aborted`. Default: none)
- **Returns**: `Promise<Blob>` — or `Promise<string>` / `Promise<ArrayBuffer>` with the typed `output` overloads

### `convertMany(inputs, options?)`

Converts multiple HEIC images with bounded concurrency. Results are returned in input order; rejects with the first failure in time — a `batch_item_failed` error whose `message` names the failing item and whose fields describe the batch (`itemIndex` 0-based, `itemTotal`, `failedCount`, `cause`). With `continueOnError` the promise fulfills with per-item results instead.

- **`inputs`**: `Array<Blob | File | ArrayBuffer | Uint8Array>`
- **`options`**: (optional) `ConvertManyOptions` — same as `ConvertOptions`, except `onProgress` uses the batch signature below; plus:
  - `concurrency`: `number` (Maximum concurrent conversions. Default: `4`)
  - `onProgress`: `(index: number, percent: number) => void` (Per-item progress callback; fires only for successful items)
  - `decoder`: `IHeicDecoder` (Optional. When provided, the same instance is shared by all concurrent conversions and must be safe for concurrent `decode()` calls; the library never frees an injected decoder; `reuseDecoders` is ignored)
  - `continueOnError`: `boolean` (Return per-item `{ index, ok, result | error }` entries instead of rejecting on the first failure. Default: `false`)
  - `reuseDecoders`: `boolean` (Hand each batch runner one pooled `LibheifDecoder` reused across items — amortizes WASM init for large batches while keeping exclusive use. Default: `false`)
- **Returns**: `Promise<Blob[]>` — or `Promise<string[]>` / `Promise<ArrayBuffer[]>` with the typed `output` overloads; `Promise<ConvertItemResult[]>` with `continueOnError` (also typed by `output`)

### `convertHeicInWorker(input, options)`

Converts a HEIC image inside a Web Worker. The worker script must implement the message protocol shown in [Usage section 13](#13-web-worker-conversion). Browser-only; rejects in Node.js.

- **`input`**: `Blob | File | ArrayBuffer | Uint8Array`
- **`options`**: `WorkerConvertOptions` — same as `ConvertOptions` but without `decoder` (cannot be structured-cloned; passing one rejects with `invalid_input`), plus:
  - `workerUrl`: `string | URL` (URL of the worker script; should be a compile-time constant)
  - `workerType`: `'classic' | 'module'` (Worker script type. Default: `'classic'`; use `'module'` for scripts with ES imports)
  - `timeoutMs`: `number` (Maximum wait for the result in milliseconds, including time spent queued. Finite, ≥ 0; `0` disables. Default: `60000`)
  - `maxConcurrentWorkers`: `number` (Positive integer. Concurrent workers per `workerUrl` + type; extra calls queue. Default: `navigator.hardwareConcurrency` clamped to 1–8)
- **Returns**: `Promise<Blob>` — or `Promise<string>` / `Promise<ArrayBuffer>` with the typed `output` overloads. Aborting via `signal` terminates the worker immediately.

### `convertManyInWorker(inputs, options)`

Converts multiple HEIC images, each inside a Web Worker, with `convertMany` semantics (input order, `batch_item_failed` aggregation, `continueOnError` per-item results). Browser-only; rejects in Node.js.

- **`inputs`**: `Array<Blob | File | ArrayBuffer | Uint8Array>`
- **`options`**: `WorkerBatchOptions` — same as `convertHeicInWorker`'s `WorkerConvertOptions` (including `output`, `crop`, `preserveExif`, `signal`), except `onProgress` uses the batch signature below; plus:
  - `onProgress`: `(index: number, percent: number) => void` (Per-item progress callback)
  - `maxConcurrentWorkers`: `number` (Positive integer. Real concurrency — each in-flight item occupies one semaphore slot. Default: `navigator.hardwareConcurrency` clamped to 1–8)
  - `continueOnError`: `boolean` (Per-item `{ index, ok, result | error }` entries instead of rejecting on the first failure. Default: `false`)
- **Returns**: `Promise<Blob[]>` — typed overloads mirror `convertMany` (`output` / `continueOnError` combinations)

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
| `invalid_input` | all conversion APIs | Unsupported input type; non-boolean `applyOrientation`/`continueOnError`/`reuseDecoders`/`preserveExif`, unknown `output`, malformed `signal`; or worker helper called with a `decoder` |
| `invalid_quality` | all conversion APIs | `quality` outside `0.0`–`1.0` or not a finite number |
| `invalid_resize` | all conversion APIs | `scale`/`maxWidth`/`maxHeight` not positive finite numbers, or target size exceeds 16384 px |
| `invalid_format` | all conversion APIs | Unknown `to` value |
| `invalid_crop` | all conversion APIs | `crop` with non-integer/non-positive dimensions, negative offsets, or a rectangle beyond the image's display size |
| `invalid_concurrency` | all conversion APIs | `concurrency` (batch) or `maxConcurrentWorkers` (worker APIs) not a positive integer |
| `decoder_init_failed` | `convertHeic`, `convertMany` | WASM module could not be loaded (missing asset, CSP block) |
| `decode_failed` | `convertHeic`, `convertMany` | Invalid/corrupt HEIC bytes |
| `unsupported_environment` | `convertHeic`, `convertMany` | No canvas APIs (e.g. Node.js); the worker APIs reject with `worker_unsupported` there instead. Decode raw RGBA via `LibheifDecoder` |
| `render_encode_failed` | `convertHeic`, `convertMany` | Canvas render/encode failure (bad dimensions, `toBlob` returned null) |
| `format_unsupported` | `convertHeic`, `convertMany` | The canvas cannot encode the requested format (e.g. `avif` on Safari) |
| `aborted` | all conversion APIs | The `AbortSignal` was aborted before the work completed |
| `progress_callback_failed` | all conversion APIs | The host `onProgress` callback threw; message attributes the failure |
| `worker_unsupported` | `convertHeicInWorker`, `convertManyInWorker` | No global `Worker` (e.g. Node.js) |
| `worker_create_failed` | `convertHeicInWorker`, `convertManyInWorker` | `new Worker(...)` threw (wrong URL, MIME type) |
| `worker_post_failed` | `convertHeicInWorker`, `convertManyInWorker` | `postMessage` threw (non-cloneable option) |
| `worker_timeout` | `convertHeicInWorker`, `convertManyInWorker` | No result within `timeoutMs`; message includes progress/protocol diagnostics |
| `worker_failed` | `convertHeicInWorker`, `convertManyInWorker` | Worker reported `{ type: 'result', ok: false, error }` |

Option validation for **all four** conversion APIs runs on the main thread before any worker is created, so a bad option always keeps its own code. Stage errors raised *inside* a worker (decode, render, unsupported format) come back stringified under `worker_failed` — the numeric `code` does not survive the worker boundary; match on the message instead.
| `batch_item_failed` | `convertMany`, `convertManyInWorker` | One or more items failed; see `itemIndex`/`itemTotal`/`failedCount`/`cause` |

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

Real browser conversions against the CSP sandbox and the GitHub Pages demo (`docs/`). Build first — both servers serve `dist/`:

```bash
npm run build
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
