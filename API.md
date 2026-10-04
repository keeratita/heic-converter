# API Reference

Exhaustive reference for the public surface of `@keeratita/heic-converter` — every exported function, class, type, and constant, with signatures, option semantics, the worker message protocol, and the complete error-code catalogue.

For installation, bundler/CDN setup, CSP headers, and task-oriented walkthroughs, see the [README](README.md). This document is the reference half of that pair: it describes *what each API guarantees*, the README describes *how to get there*.

- [Entry points](#entry-points)
- [Functions](#functions)
  - [`convertHeic`](#convertheicinput-options)
  - [`convertMany`](#convertmanyinputs-options)
  - [`convertHeicInWorker`](#convertheicinworkerinput-options)
  - [`convertManyInWorker`](#convertmanyinworkerinputs-options)
  - [`freeSharedDecoder`](#freeshareddecoder)
- [Shared options](#shared-options)
- [Types](#types)
- [Decoders](#decoders)
- [Web Worker protocol](#web-worker-protocol)
- [Errors](#errors)
- [Environment support](#environment-support)

---

## Entry points

Everything below is exported from the package root by both the ESM (`dist/index.mjs`) and CJS (`dist/index.js`) builds; types ship in `dist/index.d.ts`.

```ts
import {
  convertHeic,
  convertMany,
  convertHeicInWorker,
  convertManyInWorker,
  freeSharedDecoder,
  LibheifDecoder,
  HeicConverterError,
  SUPPORTED_FORMATS,
  DEFAULT_QUALITY,
  type ConvertOptions,
  type ConvertManyOptions,
  type ConvertItemResult,
  type ConvertResult,
  type CropOptions,
  type DecodedImage,
  type HeicConverterErrorCode,
  type HeicInput,
  type IHeicDecoder,
  type ImageFormat,
  type LibheifDecoderOptions,
  type OutputShape,
  type ResizeOptions,
  type WorkerBatchOptions,
  type WorkerConvertOptions,
  type WorkerProgressMessage,
  type WorkerResultMessage,
} from '@keeratita/heic-converter';
```

| Kind | Export | Purpose |
| --- | --- | --- |
| Function | [`convertHeic`](#convertheicinput-options) | Convert one HEIC image in the current thread |
| Function | [`convertMany`](#convertmanyinputs-options) | Convert a batch with bounded concurrency |
| Function | [`convertHeicInWorker`](#convertheicinworkerinput-options) | Convert one image in a Web Worker (browser-only) |
| Function | [`convertManyInWorker`](#convertmanyinworkerinputs-options) | Convert a batch, one Web Worker per item (browser-only) |
| Function | [`freeSharedDecoder`](#freeshareddecoder) | API-compatibility no-op |
| Class | [`LibheifDecoder`](#libheifdecoder) | Default WASM decoder (`libheif` + `libde265`) |
| Class | [`HeicConverterError`](#heicconvertererror) | The error type every failure is reported as |
| Constant | [`SUPPORTED_FORMATS`](#supported_formats) | `readonly ImageFormat[]` accepted by `to` |
| Constant | [`DEFAULT_QUALITY`](#default_quality) | `0.92`, used when `quality` is omitted |
| Type | [`HeicInput`](#heicinput) | Accepted input forms |
| Type | [`ImageFormat`](#imageformat) | Output format union |
| Type | [`OutputShape`](#outputshape) / [`ConvertResult`](#convertresult) | Result representation and its mapped type |
| Type | [`ConvertOptions`](#convertoptions) / [`ConvertManyOptions`](#convertmanyoptions) | Option bags for the two in-process APIs |
| Type | [`WorkerConvertOptions`](#workerconvertoptions) / [`WorkerBatchOptions`](#workerbatchoptions) | Option bags for the two worker APIs |
| Type | [`ResizeOptions`](#resizeoptions) / [`CropOptions`](#cropoptions) | Geometry options |
| Type | [`ConvertItemResult`](#convertitemresult) | Per-item outcome of a `continueOnError` batch |
| Type | [`DecodedImage`](#decodedimage) / [`IHeicDecoder`](#iheicdecoder) | Raw decode result and the decoder contract |
| Type | [`LibheifDecoderOptions`](#libheifdecoderoptions) | `LibheifDecoder` constructor options |
| Type | [`WorkerProgressMessage`](#workerprogressmessage) / [`WorkerResultMessage`](#workerresultmessage) | Worker script message protocol |
| Type | [`HeicConverterErrorCode`](#heicconvertererrorcode) | Machine-readable error discriminator union |

There is one additional subpath export for the decoder binary itself, handy as a copy source when a bundler does not rewrite the asset URL:

```jsonc
// node_modules/@keeratita/heic-converter/package.json
{ "exports": { ".": …, "./wasm": "./dist/heic-decoder.wasm" } }
```

---

## Functions

### `convertHeic(input, options?)`

Converts a HEIC image to JPEG, PNG, WebP, AVIF, or SVG.

```ts
function convertHeic<S extends OutputShape = 'blob'>(
  input: HeicInput,
  options?: ConvertOptions & { output?: S }
): Promise<ConvertResult<S>>;
```

| Parameter | Type | Description |
| --- | --- | --- |
| `input` | [`HeicInput`](#heicinput) | The HEIC file. `Blob`, `File`, `ArrayBuffer`, or `Uint8Array` (other `ArrayBufferView`s and cross-realm Blob-likes are accepted at runtime) |
| `options` | `ConvertOptions` | Optional configuration — see [Shared options](#shared-options) |

**Returns** `Promise<Blob>` by default; `Promise<string>` with `output: 'dataUrl'` and `Promise<ArrayBuffer>` with `output: 'arrayBuffer'` (the generic parameter is inferred from `output`, so no cast is needed).

**Execution order** — what happens, and in what order, matters for error precedence and cost:

1. **Options are validated first**, before any I/O or decoding: `to`, `quality`, `applyOrientation`, `output`, `signal`, `crop`, `preserveExif`, and the resize bounds. A typo never costs a decode and always keeps its own error code.
2. The **environment is probed** (canvas APIs present, and for `avif` whether the canvas can encode it) so `unsupported_environment` / `format_unsupported` surface before the WASM payload is paid for.
3. Input bytes are resolved to a `Uint8Array`.
4. A decoder is chosen — your injected `options.decoder`, or a **fresh `LibheifDecoder` per call** so concurrent conversions never share mutable WASM state — then `initialize()` and `decode()`.
5. A library-owned decoder is freed **immediately after `decode()`** (decoded pixels are a standalone copy, so they survive it) and again in `finally`; an injected decoder is never freed.
6. Pixels are rendered to canvas, oriented/cropped/resized, encoded, and optionally given back their EXIF block.
7. The withheld `100%` progress event is emitted, then the result is shaped per `output`.

**Progress contract.** `onProgress` receives finite numbers clamped to `0`–`100`. `0` is emitted before decoding starts; intermediate values track libheif's tile progress; `100` is **withheld until the whole conversion succeeded** — a conversion that later fails never reports completion. A callback that throws does not corrupt the pipeline: it is recorded and the conversion rejects with `progress_callback_failed` naming your message.

**Cancellation.** `signal` is checked at every stage boundary (after input read, after decoder init, before and after decode, before encode, before emitting `100%`) and rejects with `aborted`. The synchronous WASM `decode()` cannot be preempted mid-call, so cancellation takes effect at the next boundary after it returns.

```ts
const jpeg = await convertHeic(file, { to: 'jpeg', quality: 0.85, maxWidth: 1600 });
```

### `convertMany(inputs, options?)`

Converts many images with bounded concurrency, preserving input order.

```ts
function convertMany<S extends OutputShape = 'blob'>(
  inputs: HeicInput[],
  options?: ConvertManyOptions & { output?: S; continueOnError?: false }
): Promise<ConvertResult<S>[]>;

function convertMany<S extends OutputShape = 'blob'>(
  inputs: HeicInput[],
  options: ConvertManyOptions & { output?: S; continueOnError: true }
): Promise<ConvertItemResult<ConvertResult<S>>[]>;
```

Each item is processed by the same pipeline as [`convertHeic`](#convertheicinput-options) — every per-item option behaves identically, including `output`, `crop`, `preserveExif`, and `signal`. Batch-specific behavior:

| Concern | Guarantee |
| --- | --- |
| Concurrency | At most `concurrency` items run at once (default `4`); items are claimed in input order |
| Ordering | Results always correspond 1:1 to `inputs` by position |
| Failure (default) | Rejects with `batch_item_failed` **as soon as the first failure is known** — the first failure *in time*, not the lowest index. In-flight items are allowed to finish so their decoders release their own memory |
| Failure fields | `itemIndex` (0-based first failing item), `itemTotal`, `failedCount`, and `cause` (the underlying error). The message names the failing item and, when several failed, summarizes the count plus up to two further failing messages |
| `continueOnError: true` | Never rejects for item failures; every item runs to completion and you get per-item [`ConvertItemResult`](#convertitemresult) entries |
| Abort | An aborted signal **wins over failure aggregation** — the batch rejects with `aborted` and no new items launch. With `continueOnError`, not-yet-started entries are filled with `aborted` errors instead |
| Up-front mistakes | Bad `to`/`quality`/`concurrency`/… still reject normally even with `continueOnError` — a typo is a caller bug, not an item failure |
| `onProgress` | Fires per item as `(index, percent)` and only for items that succeed |

```ts
const blobs = await convertMany(files, { to: 'webp', concurrency: 4, reuseDecoders: true });

const results = await convertMany(files, { to: 'webp', continueOnError: true });
const failures = results.filter((r) => !r.ok); // { index, ok: false, error }[]
```

### `convertHeicInWorker(input, options)`

Runs [`convertHeic`](#convertheicinput-options) inside a Web Worker so the main thread stays responsive. **Browser-only** — rejects with `worker_unsupported` where there is no global `Worker`.

```ts
function convertHeicInWorker<S extends OutputShape = 'blob'>(
  input: HeicInput,
  options: WorkerConvertOptions & { output?: S }
): Promise<ConvertResult<S>>;
```

| Parameter | Type | Description |
| --- | --- | --- |
| `input` | [`HeicInput`](#heicinput) | The HEIC file; structured-cloned into the worker |
| `options` | [`WorkerConvertOptions`](#workerconvertoptions) | Every `ConvertOptions` field **except `decoder`**, plus the worker knobs below. Required |

Additional options:

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `workerUrl` | `string \| URL` | — (**required**) | URL of the worker script that implements the [protocol](#web-worker-protocol). Keep it a compile-time constant (`new URL('./converter.worker.js', import.meta.url)`); the script runs with the page's privileges |
| `workerType` | `'classic' \| 'module'` | `'classic'` | `'module'` when the script uses ES imports; classic scripts must be pre-bundled |
| `timeoutMs` | `number` | `60000` | Per-call deadline, finite and `≥ 0` (`0` disables). **Includes time spent queued** for a free worker slot |
| `maxConcurrentWorkers` | `number` | `navigator.hardwareConcurrency` clamped to 1–8 (4 when unavailable) | Positive integer. Upper bound on simultaneously live workers per `workerUrl` + type; extra calls queue |

Notes that are easy to trip over:

- `decoder` cannot cross the structured-clone boundary. It is absent from `WorkerConvertOptions` at compile time and rejected with `invalid_input` at runtime; the worker creates its own decoder.
- Workers are pooled **per `workerUrl` + `workerType`**, so concurrent callers of the same script share one bounded set instead of spawning unbounded workers.
- Errors raised *inside* the worker come back **stringified** under `worker_failed` — the numeric `code` does not survive the boundary, so match on the message. Options are validated on the main thread instead, so a bad option keeps its own code.
- If the lazily imported worker chunk itself cannot be fetched, the rejection is `worker_load_failed` (original failure on `cause`) regardless of other option problems. Deploy `dist/` as a whole.
- `signal` aborts **immediately**: the worker is `terminate()`d, since it runs off the main thread.
- A `worker_timeout` message carries diagnostics — how many progress messages arrived, the last percent, and any unrecognised message type (the usual sign the script does not implement the protocol).

```ts
const jpeg = await convertHeicInWorker(file, {
  workerUrl: new URL('./converter.worker.js', import.meta.url),
  workerType: 'module',
  to: 'jpeg',
  onProgress: (percent) => (bar.style.width = `${percent}%`),
});
```

### `convertManyInWorker(inputs, options)`

Converts a batch with [`convertMany`](#convertmanyinputs-options) semantics, one Web Worker per item. **Browser-only.**

```ts
function convertManyInWorker<S extends OutputShape = 'blob'>(
  inputs: HeicInput[],
  options: WorkerBatchOptions & { output?: S; continueOnError?: false }
): Promise<ConvertResult<S>[]>;

function convertManyInWorker<S extends OutputShape = 'blob'>(
  inputs: HeicInput[],
  options: WorkerBatchOptions & { output?: S; continueOnError: true }
): Promise<ConvertItemResult<ConvertResult<S>>[]>;
```

Every option of [`convertHeicInWorker`](#convertheicinworkerinput-options) applies (`output`, `signal`, `crop`, `preserveExif`, `timeoutMs`, `maxConcurrentWorkers`, …); `onProgress` takes the batch signature `(index, percent)` and `continueOnError` behaves exactly as in `convertMany`. Real concurrency is `maxConcurrentWorkers` — each in-flight item holds one semaphore slot — and a mid-batch abort terminates the running workers.

```ts
const results = await convertManyInWorker(files, {
  workerUrl: new URL('./converter.worker.js', import.meta.url),
  workerType: 'module',
  to: 'avif',
  maxConcurrentWorkers: 3,
  continueOnError: true,
});
```

### `freeSharedDecoder()`

```ts
function freeSharedDecoder(): void;
```

Kept for **API compatibility only**; it is a no-op. Decoders are created and released per conversion, so there is no shared instance to free. Existing call sites are safe to leave in place.

---

## Shared options

These fields are shared by [`convertHeic`](#convertheicinput-options) and [`convertMany`](#convertmanyinputs-options) (and, minus `decoder`, by both worker APIs). All of them are optional; every one is validated up front on the calling thread.

| Option | Type | Default | Behavior | Rejects with |
| --- | --- | --- | --- | --- |
| `to` | [`ImageFormat`](#imageformat) | `'jpeg'` | Output container. `'jpg'` is an alias of `'jpeg'`; matching is case-insensitive. `avif` needs a canvas that can encode AVIF | `invalid_format` |
| `quality` | `number` | `DEFAULT_QUALITY` (`0.92`) | JPEG / WebP / AVIF encoder quality, `0.0`–`1.0` inclusive. **Validated for every format**, so `quality: 90` from a 0–100 scale fails even for `png` | `invalid_quality` |
| `maxWidth` | `number` | — | Downscale to fit within this width, preserving aspect ratio. Never upscales | `invalid_resize` |
| `maxHeight` | `number` | — | Downscale to fit within this height, preserving aspect ratio. Never upscales | `invalid_resize` |
| `scale` | `number` | — | Uniform factor applied to both dimensions (`0.5` halves). Takes precedence over `maxWidth`/`maxHeight`; may upscale | `invalid_resize` |
| `applyOrientation` | `boolean` | `true` | Rotate/flip the output to match the source's EXIF orientation. `false` keeps the exact stored-pixel geometry | `invalid_input` |
| `crop` | [`CropOptions`](#cropoptions) | — | Rectangle cut from the image **before** resize | `invalid_crop` |
| `preserveExif` | `boolean` | `false` | Re-inject the source EXIF block into JPEG (APP1) / PNG (`eXIf`) output | `invalid_input` |
| `output` | [`OutputShape`](#outputshape) | `'blob'` | Representation of the result; also selects the return type | `invalid_input` |
| `signal` | `AbortSignal` | — | Cooperative cancellation; rejects with `aborted` | `invalid_input` |
| `decoder` | [`IHeicDecoder`](#iheicdecoder) | fresh `LibheifDecoder` | Inject a custom decoder. The library never calls `free()` on an injected instance | — (worker APIs: `invalid_input`) |
| `onProgress` | `(percent: number) => void`<br>`(index: number, percent: number) => void` (batch) | — | Progress callback, `0`–`100` | `progress_callback_failed` when it throws |

`convertMany` replaces `onProgress`'s single-image signature with `(index, percent)` and adds three batch knobs:

| Option | Type | Default | Description | Rejects with |
| --- | --- | --- | --- | --- |
| `concurrency` | `number` | `4` | Maximum concurrent conversions; must be a positive integer | `invalid_concurrency` |
| `continueOnError` | `boolean` | `false` | Resolve with per-item results instead of rejecting on the first failure | `invalid_input` |
| `reuseDecoders` | `boolean` | `false` | Hand each batch runner one pooled library-owned `LibheifDecoder`, reused across items — amortizes the WASM module load for batches much larger than the concurrency. Ignored when `decoder` is injected | `invalid_input` |

### Resize, crop, and orientation compose in one pass

`scale` / `maxWidth` / `maxHeight` must be positive finite numbers, and the resulting target must not exceed **16384 px** on either side (the canvas ceiling shared with the decoder's own limits) — otherwise `invalid_resize`.

Crop coordinates are in **post-orientation display pixels**: the geometry the image is displayed in, which is what "top-left corner" means to a user. The order is *orientation → crop → resize*, so `maxWidth` downscales the crop rather than the whole image. With `applyOrientation: false`, crop coordinates address the **stored** pixels instead. A rectangle that exceeds the image rejects with `invalid_crop` naming the actual display size.

`irot`/`imir` HEIF display transforms are applied by the decoder itself (dimensions come back already swapped) and are never stacked with the EXIF rotation — Apple-style files cannot be double-rotated.

### Metadata (`preserveExif`)

Off by default because EXIF can carry GPS. When enabled, the source Exif item is copied into JPEG (as an APP1 segment after APP0) and PNG (as an `eXIf` chunk before the first IDAT); WebP and SVG ignore it. Because the rendered raster is already upright, tag 274 is rewritten to `1` first so consumers do not rotate a second time — with `applyOrientation: false` the tag stays verbatim.

Both injectors are **fail-safe**: unparsable encoder output, a malformed block, a payload beyond the 65,533-byte JPEG segment limit, or a missing `dist/exif-*.mjs` chunk all yield the image *without* metadata rather than a failed conversion (the chunk case logs a one-time `console.warn`, since a deployment problem should not look like a file that had no Exif item).

---

## Types

### `HeicInput`

```ts
type HeicInput = Blob | File | ArrayBuffer | Uint8Array;
```

The declared union covers the common cases; at runtime the resolver also accepts cross-realm `Blob`/`File` objects (duck-typed via `arrayBuffer()`) and other `ArrayBufferView`s such as `DataView` or `Uint16Array`. Anything else rejects with `invalid_input`.

### `ImageFormat`

```ts
type ImageFormat = 'jpeg' | 'jpg' | 'png' | 'svg' | 'webp' | 'avif';
```

### `SUPPORTED_FORMATS`

```ts
const SUPPORTED_FORMATS: readonly ImageFormat[]; // ['jpeg','jpg','png','svg','webp','avif']
```

### `DEFAULT_QUALITY`

```ts
const DEFAULT_QUALITY = 0.92;
```

### `OutputShape`

```ts
type OutputShape = 'blob' | 'dataUrl' | 'arrayBuffer';
```

| Value | Returns | Use for |
| --- | --- | --- |
| `'blob'` | `Blob` | Previews, `URL.createObjectURL`, downloads (default) |
| `'dataUrl'` | `string` (`data:image/…;base64,…`) | `<img src>`, inline previews |
| `'arrayBuffer'` | `ArrayBuffer` | Upload bodies, WebCodecs, custom pipelines |

### `ConvertResult`

```ts
type ConvertResult<S extends OutputShape> =
  S extends 'dataUrl' ? string
  : S extends 'arrayBuffer' ? ArrayBuffer
  : Blob;
```

The mapping is driven by the generic `output` option, so `await convertHeic(f, { output: 'dataUrl' })` is typed `string` with no cast.

### `ConvertOptions`

The option bag accepted by [`convertHeic`](#convertheicinput-options); see [Shared options](#shared-options) for the field-by-field table. Structurally it extends [`ResizeOptions`](#resizeoptions).

### `ConvertManyOptions`

Same as `ConvertOptions` with `onProgress` replaced by the batch signature, plus `concurrency`, `continueOnError`, and `reuseDecoders` — see [`convertMany`](#convertmanyinputs-options).

### `WorkerConvertOptions`

`Omit<ConvertOptions, 'decoder'>` plus `workerUrl`, `workerType`, `timeoutMs`, and `maxConcurrentWorkers` — see [`convertHeicInWorker`](#convertheicinworkerinput-options).

### `WorkerBatchOptions`

`Omit<WorkerConvertOptions, 'onProgress'>` plus the batch-signature `onProgress` and `continueOnError` — see [`convertManyInWorker`](#convertmanyinworkerinputs-options).

### `ResizeOptions`

```ts
interface ResizeOptions { maxWidth?: number; maxHeight?: number; scale?: number }
```

### `CropOptions`

```ts
interface CropOptions { x?: number; y?: number; width: number; height: number }
```

`x`/`y` default to `0` and must be non-negative integers; `width`/`height` are required positive integers. Units are post-orientation display pixels.

### `ConvertItemResult`

```ts
type ConvertItemResult<T = Blob> =
  | { index: number; ok: true; result: T }
  | { index: number; ok: false; error: Error };
```

The element type of a `continueOnError` batch. `error` is always an `Error` — a non-`Error` throw from a decoder is wrapped.

---

## Decoders

### `IHeicDecoder`

The contract behind `options.decoder`, implemented by [`LibheifDecoder`](#libheifdecoder). Supply your own to swap the decoding engine (a server-side decoder, a different codec, a mock in tests).

```ts
interface IHeicDecoder {
  initialize(): Promise<void>;
  decode(data: Uint8Array, onProgress?: (percent: number) => void): Promise<DecodedImage>;
  free(): void;
}
```

Lifecycle rules the library follows, which implementations may rely on:

- `initialize()` is called before every `decode()`; repeated/concurrent calls must be cheap (memoize the load).
- `decode()` is awaited before the library calls `free()`, so the returned `DecodedImage` must not reference decoder-owned memory that `free()` releases — copy pixels out.
- `free()` is called at most once per conversion, and **never** on a decoder you injected: you own its lifetime.
- With `convertMany`, one injected instance is shared by all concurrent conversions, so `decode()` must be safe to call concurrently (no shared mutable state across in-flight decodes).

### `DecodedImage`

```ts
interface DecodedImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
  exif?: Uint8Array;
  orientation?: number;
}
```

| Field | Notes |
| --- | --- |
| `width`, `height` | Size of the **stored** pixels. `irot`/`imir` files already come back with swapped dimensions because the decoder applied the transform |
| `data` | RGBA, interleaved, row-major, 4 bytes per pixel. Always JS-owned — never a view into the WASM heap — so it stays valid after `free()` and can go straight into `new ImageData(...)` / `putImageData` |
| `exif` | The source EXIF block normalized to the JPEG APP1 payload form (`"Exif\0\0"` + TIFF), present when the file carries an Exif item — reported independently of `orientation`. Pass it to your own encoder (e.g. `sharp`'s `.withMetadata({ exif })`) to keep metadata |
| `orientation` | EXIF tag 274 semantics, `1`–`8`, describing the **stored** pixels. Absent or `1` means nothing is pending. Only ever `> 1` when no `irot`/`imir` fourcc appears in the container, so the conservative worst case is "not rotated" rather than double-rotated. `convertHeic` applies it automatically; raw `decode()` consumers must apply it themselves |

### `LibheifDecoder`

Constructed as `new LibheifDecoder(options?)`. The default `IHeicDecoder`: `libheif` + `libde265` compiled to WebAssembly with Emscripten and `-s DYNAMIC_EXECUTION=0` (no `eval()` / `new Function()`, so no `'unsafe-eval'` in CSP).

```ts
class LibheifDecoder implements IHeicDecoder {
  constructor(options?: LibheifDecoderOptions);
  initialize(): Promise<void>;
  decode(data: Uint8Array, onProgress?: (percent: number) => void): Promise<DecodedImage>;
  free(): void;
}
```

| Method | Guarantees |
| --- | --- |
| `initialize()` | Loads the glue chunk and instantiates the module. The load promise is memoized, so concurrent calls load at most once per instance; a failed load is retryable. Rejects are surfaced by the callers as `decoder_init_failed` |
| `decode(data, onProgress?)` | Decodes to raw RGBA. Callable without a prior `initialize()` (it initializes on demand) and callable again after `free()` (it transparently re-initializes). Progress values are normalized to `0`–`100`, and a throwing callback is contained — it never unwinds through embind or aborts the module |
| `free()` | Releases the module and instance. Idempotent, safe while `initialize()` is in flight (the in-flight load is discarded), and clears the fault mark because a fresh module means a fresh heap |

If a decode traps inside the module (`WebAssembly.RuntimeError`, abort), the instance is marked faulted — its emmalloc arena is unusable afterwards — and the error is reported as a typed `decode_failed` with the original on `cause`. `convertMany({ reuseDecoders: true })` uses that mark to free a poisoned instance instead of leasing it to the next item.

### `LibheifDecoderOptions`

| Option | Type | Description |
| --- | --- | --- |
| `locateFile` | `(path: string, prefix: string) => string` | Map the WASM filename to a custom route or CDN. Note the origin must be in your CSP `connect-src` |
| `wasmBinary` | `ArrayBuffer \| ArrayBufferView` | Use these bytes instead of fetching. Accepts a Node `Buffer` (`fs.readFileSync`), which avoids relying on default path resolution in Node |
| `moduleOverrides` | `Record<string, unknown>` | Advanced: merged into the Emscripten module arguments (e.g. `instantiateWasm` for streaming compilation). Keys must not collide with the two above |

```ts
// Node.js: decode raw RGBA, encode externally
import fs from 'node:fs';
import sharp from 'sharp';
import { LibheifDecoder } from '@keeratita/heic-converter';

const decoder = new LibheifDecoder({
  wasmBinary: fs.readFileSync('node_modules/@keeratita/heic-converter/dist/heic-decoder.wasm'),
});
await decoder.initialize();
const { width, height, data, exif } = await decoder.decode(new Uint8Array(fs.readFileSync('in.heic')));
decoder.free(); // pixels and exif are JS-owned and survive this
// Note: `orientation` (when present and > 1) is a rotation you must apply
// yourself here — convertHeic does it for you, raw decode() does not.

let pipeline = sharp(Buffer.from(data), { raw: { width, height, channels: 4 } });
if (exif) pipeline = pipeline.withMetadata({ exif: Buffer.from(exif) });
await pipeline.toFormat('jpeg').toFile('out.jpg');
```

---

## Web Worker protocol

`convertHeicInWorker` / `convertManyInWorker` post one message to your script and wait for one terminal reply.

**Request** (main thread → worker):

```js
worker.postMessage({ input, options });
// input   — the HeicInput, structured-cloned
// options — the caller's options minus workerUrl, workerType, timeoutMs,
//           maxConcurrentWorkers, signal, onProgress, and decoder
```

**Replies** (worker → main thread) — only the two types below are understood; anything else is ignored, though the first unrecognised `type` is reported in the `worker_timeout` diagnostic:

### `WorkerProgressMessage`

```ts
interface WorkerProgressMessage {
  type: 'progress';
  percent: number;
}
```

Emitted any number of times before the result. `percent` is clamped to `0`–`100` on arrival, and a `100` from the worker is ignored: the library emits `100` itself, and only on success.

### `WorkerResultMessage`

```ts
interface WorkerResultMessage {
  type: 'result';
  ok: boolean;
  /** Exactly what convertHeic returned inside the worker for the chosen `output`. */
  blob?: Blob | string | ArrayBuffer;
  /** Human-readable failure text when `ok` is false. */
  error?: string;
}
```

Must be posted at most once per request: the first `result` settles the promise and the worker is terminated. The `blob` field name is kept for protocol compatibility even though it carries a string for `output: 'dataUrl'` and an `ArrayBuffer` for `output: 'arrayBuffer'`; a `result` with `ok: true` but no payload settles as a failure (`worker_failed`).

Reference implementation (mirrors `docs/worker.js`, which imports the built ESM entry directly):

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
    self.postMessage({ type: 'result', ok: true, blob }, blob instanceof ArrayBuffer ? [blob] : []);
  } catch (error) {
    self.postMessage({ type: 'result', ok: false, error: error?.stack ?? error?.message ?? String(error) });
  }
};
```

Requirements and gotchas:

- The script must be reachable at `workerUrl` and served as `text/javascript`. A blocked or mis-typed script surfaces as `worker_failed` / `worker_create_failed`.
- Use `workerType: 'module'` for scripts with ES imports; `'classic'` scripts must be pre-bundled.
- The WASM binary is fetched inside the worker, so `wasm-unsafe-eval` and the `connect-src` entry for the binary's origin apply to the worker too.
- Progress values are clamped to `0`–`100` on arrival, and a `100` from the worker is ignored: the library emits `100` itself only on success.

---

## Errors

### `HeicConverterError`

```ts
class HeicConverterError extends Error {
  readonly code: HeicConverterErrorCode;
  readonly itemIndex?: number;   // batch_item_failed only
  readonly itemTotal?: number;   // batch_item_failed only
  readonly failedCount?: number; // batch_item_failed only
}
```

Every failure the library raises is a `HeicConverterError` (`name` = `'HeicConverterError'`, `extends Error`, so `instanceof Error` and message-based handling keep working). `cause` carries the underlying error where there is one. Codes are part of the public API: additive-only and never repurposed, so branch on `error.code` rather than message text.

### `HeicConverterErrorCode`

```ts
type HeicConverterErrorCode =
  | 'invalid_input' | 'invalid_quality' | 'invalid_resize' | 'invalid_format'
  | 'invalid_crop' | 'invalid_concurrency' | 'decoder_init_failed' | 'decode_failed'
  | 'progress_callback_failed' | 'render_encode_failed' | 'unsupported_environment'
  | 'format_unsupported' | 'aborted' | 'worker_unsupported' | 'worker_load_failed'
  | 'worker_create_failed' | 'worker_post_failed' | 'worker_failed' | 'worker_timeout'
  | 'batch_item_failed';
```

| `code` | Thrown by | Meaning |
| --- | --- | --- |
| `invalid_input` | all conversion APIs | Unsupported input type; non-boolean `applyOrientation`/`continueOnError`/`reuseDecoders`/`preserveExif`, unknown `output`, malformed `signal`; or a worker helper called with a `decoder` |
| `invalid_quality` | all conversion APIs | `quality` outside `0.0`–`1.0` or not a finite number |
| `invalid_resize` | all conversion APIs | `scale`/`maxWidth`/`maxHeight` not positive finite numbers, or target size exceeds 16384 px |
| `invalid_format` | all conversion APIs | Unknown `to` value |
| `invalid_crop` | all conversion APIs | `crop` with non-integer/non-positive dimensions, negative offsets, or a rectangle beyond the image's display size |
| `invalid_concurrency` | all conversion APIs | `concurrency` (batch) or `maxConcurrentWorkers` (worker APIs) not a positive integer |
| `decoder_init_failed` | `convertHeic`, `convertMany` | WASM module could not be loaded (missing asset, CSP block) |
| `decode_failed` | `convertHeic`, `convertMany` | Invalid/corrupt HEIC bytes, or a fault inside the WASM module |
| `unsupported_environment` | `convertHeic`, `convertMany` | No canvas APIs (e.g. Node.js); the worker APIs reject with `worker_unsupported` there instead. Decode raw RGBA via `LibheifDecoder` |
| `render_encode_failed` | `convertHeic`, `convertMany` | Canvas render/encode failure (bad dimensions, `toBlob` returned null) |
| `format_unsupported` | `convertHeic`, `convertMany` | The canvas cannot encode the requested format (e.g. `avif` on Safari) |
| `aborted` | all conversion APIs | The `AbortSignal` was aborted before the work completed |
| `progress_callback_failed` | all conversion APIs | The host `onProgress` callback threw; the message attributes the failure |
| `worker_unsupported` | `convertHeicInWorker`, `convertManyInWorker` | No global `Worker` (e.g. Node.js) |
| `worker_create_failed` | `convertHeicInWorker`, `convertManyInWorker` | `new Worker(...)` threw (wrong URL, MIME type) |
| `worker_post_failed` | `convertHeicInWorker`, `convertManyInWorker` | `postMessage` threw (non-cloneable option) |
| `worker_timeout` | `convertHeicInWorker`, `convertManyInWorker` | No result within `timeoutMs`; the message includes progress/protocol diagnostics |
| `worker_failed` | `convertHeicInWorker`, `convertManyInWorker` | Worker reported `{ type: 'result', ok: false, error }` |
| `worker_load_failed` | `convertHeicInWorker`, `convertManyInWorker` | The lazily imported worker chunk (`dist/worker-*.mjs`) could not be fetched — deploy every file in `dist/` together, check your bundler emitted the chunk, inspect `error.cause`; use `convertHeic` to convert in the current thread |
| `batch_item_failed` | `convertMany`, `convertManyInWorker` | One or more items failed; see `itemIndex`/`itemTotal`/`failedCount`/`cause` |

**Precedence rules worth knowing.** Option validation for all four conversion APIs runs on the calling thread before a worker is created, so a bad option keeps its own code. Two exceptions to that: when the worker chunk itself cannot be fetched, the rejection is `worker_load_failed` regardless of other option problems; and errors raised *inside* a worker (decode, render, unsupported format) come back stringified under `worker_failed`, because the numeric `code` does not survive the boundary — match those on the message. For a batch, an aborted signal wins over item-failure aggregation, while a batch that finished before the abort wins over the late abort.

```ts
import { convertHeic, type HeicConverterErrorCode } from '@keeratita/heic-converter';

try {
  await convertHeic(input, { to: 'png' });
} catch (error) {
  const code: HeicConverterErrorCode | undefined =
    error && typeof error === 'object' && 'code' in error
      ? (error as { code?: HeicConverterErrorCode }).code
      : undefined;
  if (code === 'unsupported_environment') {
    // Node.js: decode raw RGBA with LibheifDecoder and encode externally
  }
}
```

---

## Environment support

| Environment | `convertHeic` / `convertMany` | `convertHeicInWorker` / `convertManyInWorker` | `LibheifDecoder` |
| --- | --- | --- | --- |
| Browser (page) | ✔ Full conversion (Canvas encode) | ✔ — this is their intended context | ✔ |
| Browser (dedicated worker) | ✔ Full conversion where `OffscreenCanvas` is available | ✘ `worker_unsupported` — a dedicated worker has no `Worker` constructor | ✔ |
| Node.js ≥ 20 | ✘ `unsupported_environment` — no Canvas API | ✘ `worker_unsupported` | ✔ raw RGBA decode + `exif`; encode externally (`sharp`, `pngjs`, …) |

Canvas encoding prefers `OffscreenCanvas` and falls back to `HTMLCanvasElement`; with neither available, conversion fails with `unsupported_environment` rather than a late, cryptic error. AVIF availability is probed once per environment and only a definitive refusal denies it, so an engine that cannot encode AVIF gets `format_unsupported` instead of silently receiving a PNG.
