# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
