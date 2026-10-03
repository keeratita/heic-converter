# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

_(nothing yet)_

## [0.5.0] - 2026-10-03

### Added

- **Structured error codes**: every thrown error is now a `HeicConverterError` (exported, with the `HeicConverterErrorCode` type) carrying a machine-readable `code` (`invalid_input`, `invalid_quality`, `invalid_resize`, `invalid_format`, `invalid_crop`, `invalid_concurrency`, `decoder_init_failed`, `decode_failed`, `unsupported_environment`, `render_encode_failed`, `format_unsupported`, `aborted`, `progress_callback_failed`, `worker_unsupported`, `worker_create_failed`, `worker_post_failed`, `worker_timeout`, `worker_failed`, `batch_item_failed`), a `cause` where an underlying error exists, and — for `convertMany` — `itemIndex`/`itemTotal`/`failedCount` fields. Error messages gained context (input byte length on decode failures, worker URL on worker failures, progress/protocol diagnostics on timeouts).
- **`convertHeicInWorker` concurrency control**: concurrent conversions are now bounded per worker script via a new `maxConcurrentWorkers` option (default: `navigator.hardwareConcurrency` clamped to 1–8); calls beyond the cap queue and start as slots free. Passing the (non-cloneable) `decoder` option now rejects immediately with `invalid_input` instead of being silently stripped; `WorkerConvertOptions` omits `decoder` at the type level.
- **Early environment & option checks**: `convertHeic`/`convertMany` now validate the format, options, and canvas availability *before* loading the WASM module or decoding, so Node.js users get `unsupported_environment` immediately instead of a wrapped decode-stage failure.
- **WASM artifact verification**: new `npm run verify:wasm` (`build-scripts/verify-wasm-artifacts.mjs`) checks the committed glue/binary against pinned SHA-256 hashes (`build-scripts/wasm-artifacts.json`, regenerated with `npm run wasm:hashes`) and scans the Emscripten glue for `eval`/`new Function` — wired into CI. Dependabot now bumps GitHub Actions and npm dependencies.
- **EXIF orientation support**: `convertHeic`/`convertMany` upright images whose intended display rotation lives only in the EXIF orientation tag (274), matching how browsers, Photos, and other viewers display such files. Controlled by the new `applyOrientation` option (default `true`; non-boolean values reject with `invalid_input`). `LibheifDecoder.decode()` exposes the pending rotation to raw-decode consumers via the optional `DecodedImage.orientation` field (`2`–`8`, absent when nothing is pending). HEIF `irot`/`imir` transforms remain applied by libheif at decode and are never stacked with the EXIF tag: files carrying those boxes report no pending orientation, so Apple-style files are never double-rotated. The C++ wrapper reads the tag from the Exif item's IFD0 with a bounds-checked TIFF parser (conservative: any parse anomaly falls back to "upright"; oversized metadata blocks are skipped).
- **AVIF output**: `to: 'avif'` (quality applies). Because canvas `toBlob()` silently falls back to PNG for unsupported types, the library probes AVIF encoding once per environment and rejects with the dedicated `format_unsupported` code where the canvas cannot produce AVIF (e.g. Safari) instead of mislabeling a PNG — browsers outside the probe simply never pay for the conversion.
- **Output shapes**: `output: 'blob' | 'dataUrl' | 'arrayBuffer'` (default `'blob'`) on `convertHeic`/`convertMany`/`convertManyInWorker`, with typed overloads — `'dataUrl'` returns a `data:image/…;base64,…` string (previews, `<img src>`), `'arrayBuffer'` the raw bytes (uploads, custom pipelines). Invalid values reject with `invalid_input`.
- **Batch continue-on-error**: `convertMany`/`convertManyInWorker` with `continueOnError: true` fulfill with per-item `{ index, ok: true, result }` / `{ index, ok: false, error }` entries (`ConvertItemResult`) in input order instead of rejecting the whole batch on the first failure; all items run to completion. Up-front option validation still rejects immediately (a typo is not an item failure).
- **Cropping**: `crop: { x?, y?, width, height }` cuts a rectangle from the image in **post-orientation display pixels** (what the user sees), applied before `scale`/`maxWidth`/`maxHeight`, which then downscale the cropped region. Crop and orientation compose into a single canvas transform. Shape errors (`invalid_crop`, e.g. non-integer or non-positive values) fail before decoding; out-of-bounds rectangles reject with `invalid_crop` naming the actual display size.
- **EXIF preservation**: `preserveExif: true` re-injects the source HEIC's EXIF block into JPEG output (as an APP1 segment after the JFIF APP0) and PNG output (as an `eXIf` chunk before the first IDAT), so converted files keep camera metadata (orientation, GPS, timestamps). Opt-in — metadata can contain private data like GPS. The C++ wrapper normalizes the Exif item to the `"Exif\0\0" + TIFF` APP1 payload and exposes it as `DecodedImage.exif` (owned copy; available for `irot`/`imir` files too, so raw Node pipelines can pass it to e.g. `sharp.withMetadata({ exif })`). Injectors are fail-safe: unparsable encoder output, malformed blocks, or EXIF payloads beyond the 64 KB JPEG segment limit leave the output untouched (metadata loss, never corruption).
- **Cooperative cancellation**: `signal: AbortSignal` (optionally with `options.output`/`crop`/etc.) on `convertHeic`, `convertMany`, and the worker APIs. Cancellation is checked at stage boundaries (input read, before decode, after decode, before encode); `convertHeicInWorker`/`convertManyInWorker` aborts terminate the worker(s) immediately. An aborted signal rejects with the dedicated `aborted` code; a mid-batch abort supersedes item-failure aggregation.
- **`convertManyInWorker(inputs, options)`**: batch conversion inside Web Workers mirroring `convertMany` semantics (input order, `continueOnError`, per-item `onProgress(index, percent)`), with real concurrency bounded by `maxConcurrentWorkers` via the worker semaphore.
- **Decoder reuse for batches**: `convertMany({ reuseDecoders: true })` amortizes the WASM module load by handing each batch runner one pooled `LibheifDecoder` (acquire/release, never shared while in use) instead of creating an instance per item — large batches skip the ~2.5 ms/instance init/free cost (measured) without weakening the exclusive-use invariant. Opt-in; the default per-conversion lifecycle is unchanged.

### Changed

- **Decoder wrapper hardening** (`src/wasm/wrapper.ts`, `build-wasm/wrapper/main.cpp` — C++ changes take effect on the next `npm run build:wasm`): `free()` during `initialize()` no longer races (generation counter); `decode()` after `free()` transparently re-initializes; pixel buffers are only shared (not defensively re-copied) when provably JS-owned; a new zero-copy input fast path (`decodeFromPointer` + `_malloc`/`_free`) avoids the `std::string` round-trip when the glue exposes it; progress values are normalized/clamped at the wrapper boundary; the C++ wrapper enforces libheif security limits (64 MP / 16384 px per side), validates planes/strides, uses uint64 pixel math, and guards host progress callbacks so a throwing callback can never unwind through a WASM frame.
- **`build-wasm.sh`** now compiles the tracked `build-wasm/wrapper/main.cpp` (previously an inline heredoc copy could drift), stamps cached library builds with their versions, and adds the flags the hardened wrapper needs (`-fexceptions -fcxx-exceptions`, `_malloc`/`_free` exports, `HEAPU8` runtime method).
- **Shared batch/validation plumbing**: `convertMany` and `convertManyInWorker` now run through one bounded-concurrency runner (`src/batch.ts`), and option validators live in `src/validate.ts` — all entry points report identical codes for identical mistakes. Errors raised inside the render stage (e.g. `invalid_crop`, `format_unsupported`) now propagate with their original code instead of being re-wrapped as `render_encode_failed`.
- **Memory**: encoded canvases release their backing store (`close()`/`width = 0`) before base64/SVG assembly; the full-resolution source canvas of a resize is released before the encode step; SVG output assembles its Blob from parts instead of concatenating the full base64 string.
- **Worker timeouts** surface actionable diagnostics (progress count, last percent, unrecognized message types, worker URL) in the `worker_timeout` message.
- `wasmBinary` now accepts any `ArrayBufferView` (e.g. a Node.js `Buffer` from `fs.readFileSync`), not just `ArrayBuffer`.
- Release automation moved to `build-scripts/release.mjs` (ESM): branch detection failures are fatal and push failures print recovery hints instead of exiting silently.

### Fixed

- **GitHub Pages demo worker mode**: the Pages workflow copied only `index.html`, `demo.js`, and `dist/` into the site artifact — never `docs/worker.js` — so the deployed 0.4.x demo's Web Worker option failed with a 404 on the worker script. The workflow now copies `worker.js` and fails the build when it is missing.
- **Sideways output for EXIF-rotated HEIC**: files whose pixels are stored rotated with only an EXIF orientation tag (no `irot`/`imir` boxes — written by tools that just rewrite metadata) previously converted to rotated output; they now come out upright like every viewer shows them (see the `applyOrientation` option and the Orientation section in the README).
- `convertHeic` no longer rejects with a misleading decode error in environments without canvas APIs, and `onProgress: null`/non-function values are treated as absent instead of throwing mid-decode.
- `convertMany` frees decoders of in-flight items when the batch rejects early, reports every failed item (not just the first) in the summary, and attributes `null` rejections with the item index.

### Testing

- Unit tests share a mock harness (`test/unit/helpers/convert-mocks.ts`), pin the new error codes/fields, exercise the wrapper fast path and buffer-ownership logic, cover worker queueing/timeout diagnostics, and no longer mutate globals without restoring them. The real-WASM suites fail hard on CI when artifacts are missing instead of silently skipping.
- New 0.5.0 coverage: crop transform composition (crop alone, +resize, +orientation, +orientation+resize, display-space bounds), the AVIF capability probe (PNG-fallback rejection, null/throwing probe, caching, defensive final re-check), output shapes, abort boundaries (per-stage, progress withholding, validation-over-abort ordering), `continueOnError` entry shapes/order, `reuseDecoders` pooling (instance-per-runner, frees at batch end, injected-decoder bypass), `convertManyInWorker` queueing/progress/aggregation/abort, and the JPEG/PNG EXIF injectors — including CRC cross-checks against an independent bitwise CRC-32 and fail-safe returns for malformed containers.
- The real-WASM integration suite asserts `DecodedImage.exif` end to end (normalized `"Exif\0\0"+TIFF` from the fixtures, presence on `irot` files where orientation stays unset, absence for Exif-less files, validity after `free()`).
- Browser E2E: the sandbox API suite now additionally exercises AVIF (support or graceful `format_unsupported`), dataUrl/arrayBuffer outputs, `continueOnError` with a corrupt item, pre-aborted conversion, real crop geometry (40×32 from a 64×64 fixture), EXIF APP1 injection with default-drop verification, `convertManyInWorker` with per-item progress, and pooled batches; the demo page gained an AVIF format option.
- Browser E2E (`npm run test:e2e`): server lifecycle is failure-safe (always torn down, failure screenshot captured), the demo suite covers the Web Worker path, cancel/recovery, and content sniffing, and the sandbox server streams with `stream.pipeline`.

### Documentation

- README: valid TypeScript snippets throughout, a bundler/`./wasm` asset-handling section, a Node.js `wasmBinary` recipe, an error-code reference table, and expanded batch/worker semantics.
- Demo (`docs/`): converts in a Web Worker by default, adds a Cancel button, disables form controls during a run, validates the HEIF `ftyp` header before converting, and marks the download link `aria-disabled` until a result exists.

### Build / CI

- GitHub Actions are pinned to commit SHAs; `publish.yml` requires a protected `npm-publish` environment, dropped `workflow_dispatch`, and verifies WASM artifacts before publishing; `demo-pages.yml` ships `docs/worker.js`; generated build outputs are gitignored and the stale duplicate WASM copy removed.

## [0.4.2]

### Changed

- **Lazy-loaded Emscripten glue**: `LibheifDecoder` now dynamically imports the Emscripten glue on first decode instead of bundling it into the main entry. The main bundle shrinks from ~76 KB to ~9 KB, and the ~65 KB glue chunk is fetched only when a conversion actually runs (previously it loaded even when only `convertHeicInWorker` was used).

### Security

- Upgraded `libheif` from 1.23.2 to 1.23.5 — three security releases fixing a critical heap-buffer-overflow in the uncompressed (unci) mixed-interleave decoder, an unenforced `max_items` limit (quadratic-time parse DoS), and memory exhaustion via an ispe/bitstream size mismatch.
- Upgraded `libde265` from 1.1.1 to 1.1.3 — 1.1.2 is a security release; 1.1.3 repairs cross-component prediction for 4:4:4 Range Extensions streams.

### Build

- `npm run build` now also emits pre-compressed WASM artifacts — `dist/heic-decoder.wasm.gz` (~397 KB) and `dist/heic-decoder.wasm.br` (~294 KB) — via `build-scripts/compress-wasm.mjs` (Node built-in zlib, zero dependencies).
- The CSP sandbox server (`test/browser/server.mjs`) now serves compressible assets with `Content-Encoding` (gzip/brotli) based on `Accept-Encoding`, preferring the pre-compressed files.
- Rebuilt WASM artifacts against the upgraded libraries (binary grows ~44 KB from the new parser security limits).

### Documentation

- README: added a "Reducing the download size" section covering pre-compressed artifacts, `Content-Encoding` server configuration, and long-lived caching guidance.

## [0.4.1]

### Build

- Upgraded `libheif` from 1.23.1 to 1.23.2 in the WASM build (rebuilt WASM artifacts).
- Vendored `libheif` and `libde265` sources as git submodules pinned to release tags (`v1.23.2` / `v1.1.1`), replacing tarball downloads. `build-wasm.sh` now verifies the submodule checkouts match the pinned versions.
- Added `WASM_DEPENDENCIES.md` documenting the pinned upstream versions and the update workflow.
- CI now checks out submodules (`submodules: recursive`).

## [0.4.0]

### Added

- **Resize options**: `maxWidth`, `maxHeight`, and `scale` in `ConvertOptions` to downscale (or uniformly scale) images during conversion. Aspect ratio is preserved; `maxWidth`/`maxHeight` never upscale; target dimensions are capped at 16384px per side.
- **Batch conversion**: `convertMany(inputs, options?)` converts multiple HEIC images with bounded concurrency (default `4`), returns results in input order, and rejects as soon as a conversion fails with an error identifying the failing item index.
- **Web Worker helper**: `convertHeicInWorker(input, options)` runs conversions inside a user-provided Web Worker script, keeping the main thread responsive. Progress is forwarded via `{ type: 'progress', percent }` messages; a configurable `timeoutMs` (default 60s) bounds the wait for a result; `workerType: 'module'` supports ES-module worker scripts.
- **Browser E2E coverage**: new API test page (`test/browser/api-test.html`) exercises resize, batch conversion, and the worker protocol against a real browser.
- **`HeicInput` type**: exported type alias for `Blob | File | ArrayBuffer | Uint8Array`, used by `convertHeic`, `convertMany`, and `convertHeicInWorker`.

### Changed

- `renderAndEncode` accepts an optional `ResizeOptions` argument (backwards compatible).
- `convertMany` rejects with an error that includes the failing item index (e.g. `Conversion of item 2 of 3 failed: ...`), with the original error preserved as `cause`.
- `convertHeicInWorker` only treats `result` messages as terminal (other message types are ignored), handles `messageerror` events, and clamps progress percentages to 0–100.

## [0.3.0]

### Added

- WebP output format support (`to: 'webp'` with quality configuration).
- WebP examples in the demo pages.

### Changed

- Concurrent conversions are now safe: a fresh decoder instance is created and released per conversion, and decoded pixel data is copied out of the WASM heap so results stay valid after `free()`.
- Improved type safety and restructured tests.

### Fixed

- Prevented stack overflow when converting large images (chunked base64 encoding).

### Build

- Upgraded `libde265` and `libheif` dependencies in the WASM build.
- Enforced coverage thresholds and hardened browser E2E tests in CI.
- Added `AGENTS.md` with contributor guidance.

## [0.2.0]

### Added

- Interactive demo pages and UI for HEIC conversion (GitHub Pages).
- Comprehensive unit and integration tests for `convertHeic` with various input scenarios.
- Automated release script (`npm run release`) for versioning and tagging.

### Changed

- Upgraded `vitest` and `@vitest/browser` to version 4.1.8.
- Updated GitHub Sponsors username.

## [0.1.0]

### Added

- Initial release: `convertHeic()` converting HEIC/HEIF to JPEG, PNG, and SVG in the browser.
- CSP-compliant WASM decoder built from `libheif` + `libde265` via Emscripten (`-s DYNAMIC_EXECUTION=0`).
- `LibheifDecoder` for raw RGBA decoding in Node.js.
- Dependency injection via the `IHeicDecoder` interface.
- Progress callback support (`onProgress`).
- `freeSharedDecoder()` compatibility helper.
