# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

_(nothing yet)_

## [0.5.0] - 2026-10-03

### Added

- **Structured error codes**: every thrown error is now a `HeicConverterError` (exported, with the `HeicConverterErrorCode` type) carrying a machine-readable `code` (`invalid_input`, `invalid_quality`, `invalid_resize`, `invalid_format`, `decoder_init_failed`, `decode_failed`, `unsupported_environment`, `render_encode_failed`, `progress_callback_failed`, `worker_create_failed`, `worker_post_failed`, `worker_timeout`, `worker_failed`, `batch_item_failed`), a `cause` where an underlying error exists, and — for `convertMany` — `itemIndex`/`itemTotal`/`failedCount` fields. Error messages gained context (input byte length on decode failures, worker URL on worker failures, progress/protocol diagnostics on timeouts).
- **`convertHeicInWorker` concurrency control**: concurrent conversions are now bounded per worker script via a new `maxConcurrentWorkers` option (default: `navigator.hardwareConcurrency` clamped to 1–8); calls beyond the cap queue and start as slots free. Passing the (non-cloneable) `decoder` option now rejects immediately with `invalid_input` instead of being silently stripped; `WorkerConvertOptions` omits `decoder` at the type level.
- **Early environment & option checks**: `convertHeic`/`convertMany` now validate the format, options, and canvas availability *before* loading the WASM module or decoding, so Node.js users get `unsupported_environment` immediately instead of a wrapped decode-stage failure.
- **WASM artifact verification**: new `npm run verify:wasm` (`build-scripts/verify-wasm-artifacts.mjs`) checks the committed glue/binary against pinned SHA-256 hashes (`build-scripts/wasm-artifacts.json`, regenerated with `npm run wasm:hashes`) and scans the Emscripten glue for `eval`/`new Function` — wired into CI. Dependabot now bumps GitHub Actions and npm dependencies.

### Changed

- **Decoder wrapper hardening** (`src/wasm/wrapper.ts`, `build-wasm/wrapper/main.cpp` — C++ changes take effect on the next `npm run build:wasm`): `free()` during `initialize()` no longer races (generation counter); `decode()` after `free()` transparently re-initializes; pixel buffers are only shared (not defensively re-copied) when provably JS-owned; a new zero-copy input fast path (`decodeFromPointer` + `_malloc`/`_free`) avoids the `std::string` round-trip when the glue exposes it; progress values are normalized/clamped at the wrapper boundary; the C++ wrapper enforces libheif security limits (64 MP / 16384 px per side), validates planes/strides, uses uint64 pixel math, and guards host progress callbacks so a throwing callback can never unwind through a WASM frame.
- **`build-wasm.sh`** now compiles the tracked `build-wasm/wrapper/main.cpp` (previously an inline heredoc copy could drift), stamps cached library builds with their versions, and adds the flags the hardened wrapper needs (`-fexceptions -fcxx-exceptions`, `_malloc`/`_free` exports, `HEAPU8` runtime method).
- **Memory**: encoded canvases release their backing store (`close()`/`width = 0`) before base64/SVG assembly; the full-resolution source canvas of a resize is released before the encode step; SVG output assembles its Blob from parts instead of concatenating the full base64 string.
- **Worker timeouts** surface actionable diagnostics (progress count, last percent, unrecognized message types, worker URL) in the `worker_timeout` message.
- `wasmBinary` now accepts any `ArrayBufferView` (e.g. a Node.js `Buffer` from `fs.readFileSync`), not just `ArrayBuffer`.
- Release automation moved to `build-scripts/release.mjs` (ESM): branch detection failures are fatal and push failures print recovery hints instead of exiting silently.

### Fixed

- `convertHeic` no longer rejects with a misleading decode error in environments without canvas APIs, and `onProgress: null`/non-function values are treated as absent instead of throwing mid-decode.
- `convertMany` frees decoders of in-flight items when the batch rejects early, reports every failed item (not just the first) in the summary, and attributes `null` rejections with the item index.

### Testing

- Unit tests share a mock harness (`test/unit/helpers/convert-mocks.ts`), pin the new error codes/fields, exercise the wrapper fast path and buffer-ownership logic, cover worker queueing/timeout diagnostics, and no longer mutate globals without restoring them. The real-WASM suites fail hard on CI when artifacts are missing instead of silently skipping.
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
