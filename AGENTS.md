# AGENTS.md

Guidance for AI agents and contributors working in this repository.

## Project Overview

`@keeratita/heic-converter` is a TypeScript library that converts `.heic`/`.heif` images to standard web formats (**JPEG, PNG, WebP, AVIF, SVG**) in the browser or Node.js.

Key design constraints:

- **CSP-compliant**: The libheif C++ code is compiled to WebAssembly with Emscripten using `-s DYNAMIC_EXECUTION=0` — no `eval()` or `new Function()` is ever generated. Do not remove this flag from the WASM build.
- **Zero runtime dependencies**: The package has no production dependencies. Do not add any.
- **Isomorphic**: Runs in both browsers (full conversion via Canvas) and Node.js (raw RGBA decoding only — Canvas encoding is unavailable and `convertHeic` throws on the backend).
- **libheif-based**: HEIC decoding is done by `libheif` (with `libde265`), cross-compiled to WASM via Emscripten inside Docker.

## Commands

| Command | Description |
| --- | --- |
| `npm run build` | Build the TS library to `dist/` (CJS + ESM + `.d.ts`) via tsup, then gzip/brotli-compress the WASM (`build-scripts/compress-wasm.mjs`) |
| `npm run build:wasm` | Rebuild the WASM decoder (`build-scripts/build-wasm.sh`) — **requires Docker** |
| `npm run verify:wasm` | Verify the committed Emscripten glue + WASM binary against the pinned SHA-256 hashes in `build-scripts/wasm-artifacts.json` and scan the glue for `eval`/`new Function` (runs in CI) |
| `npm run wasm:hashes` | Regenerate `build-scripts/wasm-artifacts.json` — **must be run and committed after every `npm run build:wasm`**, or CI verification fails |
| `npm test` / `npm run test` | Run unit tests (Vitest, Node environment) |
| `npm run test:watch` | Run unit tests in watch mode |
| `npm run test:e2e` | Run browser E2E tests (real conversions in the CSP sandbox + GitHub Pages demo) via Playwright — requires `npx playwright install chromium` once |
| `npm run test:coverage` | Run tests with coverage; thresholds are enforced in `vitest.config.ts` (80% lines/functions/statements, 70% branches) |
| `npm run sandbox` | Start the interactive CSP sandbox server at `http://localhost:3000` (`test/browser/server.mjs`) |
| `npm run lint` | ESLint over the whole repo (also runs via the `pre-commit` husky hook) |
| `npm run sonar` | Run SonarQube scanner (`sonar-project.properties`) |
| `npm run release [patch\|minor\|major\|current]` | Lint → build → test, then bump version, commit (`chore(release): X.Y.Z`), tag (`vX.Y.Z`), and push (`build-scripts/release.mjs`). Requires a clean working tree |

Node `>=20` is required (see `engines`).

## Repository Layout

```
src/
  index.ts                  # Public API: convertHeic(), convertMany(), freeSharedDecoder()
  types.ts                  # IHeicDecoder, DecodedImage, ConvertOptions, ImageFormat, OutputShape
  batch.ts                  # Shared bounded-concurrency runner (convertMany + convertManyInWorker)
  validate.ts               # Shared strict option validators — aggregate validateConvertOptions/validateBatchOptions used by all four entry points, plus the pure format/resize/crop validators (canvas.ts re-exports them)
  errors.ts                 # HeicConverterError + HeicConverterErrorCode
  messages/
    core.ts                 # Messages — error strings the main-thread path throws (one object literal: anything only the worker throws must NOT live here)
    worker.ts               # WorkerMessages — worker-only error strings, so they stay inside the lazy worker chunk
  worker.ts                 # convertHeicInWorker / convertManyInWorker + worker semaphore (lazily imported by index.ts)
  render/canvas.ts          # Render RGBA to canvas + encode (JPEG/PNG/WebP/AVIF/SVG); avif probe + up-front assertEncodeCapability; base64 helpers
  render/exif.ts            # Fail-safe EXIF injectors: JPEG APP1 + PNG eXIf chunk (CRC32); orientation-tag (274) normalizer
  wasm/
    wrapper.ts              # LibheifDecoder — wraps the Emscripten glue module
    wrapper/heic-decoder.js # GENERATED Emscripten glue — do not edit
    public/heic-decoder.wasm # GENERATED WASM binary — do not edit
build-wasm/
  src/libheif/ src/libde265/ # Git submodules (pinned to release tags) — do not edit
  wrapper/main.cpp           # C++ wrapper: embind class HeicDecoder exposing decode()
build-scripts/
  build-wasm.sh             # Docker + Emscripten build pipeline
  patch-libheif.py          # Patches libheif context.cc to emit progress callbacks
  compress-wasm.mjs         # Emits dist/heic-decoder.wasm.gz/.br after the tsup build
  verify-wasm-artifacts.mjs # Checks committed glue/WASM against pinned SHA-256 + eval scan (npm run verify:wasm)
  wasm-artifacts.json       # Pinned artifact hashes — regenerate with npm run wasm:hashes
  release.mjs               # SemVer release automation
test/
  unit/                     # Vitest unit tests (integration tests use the real WASM)
  browser/                  # CSP sandbox + Playwright browser tests
  fixtures/                 # Test HEIC images
```

## Architecture & Key Facts

- **Conversion flow** (`convertHeic` in `src/index.ts`): normalize input → validate `quality` (0.0–1.0) → pick decoder (user-injected `options.decoder` or a fresh `LibheifDecoder`) → `initialize()` → `decode()` → **free a library-owned decoder immediately (before `renderAndEncode`, since decoded pixels are a standalone copy) and again in `finally` as a safety net** — `free()` is idempotent and never called on a user-injected decoder.
- **Decoder instance lifecycle**: A fresh `LibheifDecoder` is created *per conversion* (default for every entry point) so concurrent calls never share mutable WASM state. `freeSharedDecoder()` is a **no-op kept for API compatibility** — do not reintroduce a *globally shared* instance without discussion. **Sanctioned exception**: `convertMany({ reuseDecoders: true })` uses the internal `DecoderPool` (lease/return per batch runner via `acquire()`/`release()`) — each leased instance is used by exactly one item at a time and is never concurrently shared, preserving the exclusive-use invariant; the pool is module-private, opt-in, and bypassed when the caller injects `decoder`.
- **WASM wrapper** (`build-wasm/wrapper/main.cpp`): uses embind to expose `HeicDecoder.decode(string, progressCb)`, returning `{ width, height, data, orientation?, exif? }` where `data` is a `Uint8Array` (RGBA, interleaved) and `exif` (when present) is the normalized `"Exif\0\0" + TIFF` APP1 payload from the file's Exif item. Errors are returned as strings. In `src/wasm/wrapper.ts`, `LibheifDecoder.decode()` returns an **owned `Uint8ClampedArray` that is never a WASM-heap view** (copied unless the glue proves the buffer is JS-owned) — likewise `exif` is returned as an owned copy so it stays valid after `free()` — so results survive `free()` and concurrent decodes can never corrupt each other's output; `initialize()` memoizes its module-loading promise so concurrent calls load the module once. The Emscripten glue is loaded via dynamic `import()` inside `initialize()` (with tsup `splitting: true`) so it ships as a lazy chunk and stays out of the eagerly loaded bundle.
- **Orientation policy**: libheif applies `irot`/`imir` display transforms natively at decode (dimensions come back swapped), so those files must never be rotated further. The C++ wrapper reports EXIF tag 274 (`DecodedImage.orientation`, IFD0 only, bounds-checked TIFF parse with 4 MB block / 64-block caps) **only when no `irot`/`imir` fourcc appears anywhere in the container** — conservative by design: the worst case is "not rotated" (pre-0.5 behavior), never double-rotation. `convertHeic` renders the pending orientation as one composed `setTransform` matrix; resize sizing operates on display dimensions (axes swapped for 5–8). `applyOrientation: false` keeps stored geometry. Regression fixtures: `test/fixtures/exif-orientation-6.heic` (EXIF-only, stored 1600×1200 landscape — must decode `orientation: 6` and convert portrait 1200×1600) and `test/fixtures/irot-orientation-6.heic` (both signals — must decode upright with **no** pending orientation).
- **Progress callbacks**: For libheif < 1.21, `build-scripts/patch-libheif.py` patches `context.cc` with start/on/end progress hooks around tile decoding. libheif ≥ 1.21 ships these natively in `image-items/grid.cc` (grid decoding moved there), which the patch script detects and skips. `build-wasm.sh` pins 1.23.5, so the patch normally no-ops.
- **EXIF preservation policy** (`preserveExif`, default `false`): the C++ wrapper extracts the file's Exif item and normalizes it to `"Exif\0\0" + TIFF` (`DecodedImage.exif`), read **unguarded** by the `irot`/`imir` fourcc check — unlike `orientation`, which stays guarded (preserving metadata is orthogonal to display transforms). `convertHeic` re-injects the block only for JPEG (APP1 segment after APP0; payloads beyond the 65,533-byte segment limit are skipped) and PNG (`eXIf` chunk before the first IDAT, CRC32 computed in `src/render/exif.ts`); WebP/SVG ignore it. Because the rendered raster is already upright whenever the rotation was baked in (applied at render or by libheif for `irot`/`imir`), `normalizeOrientationTag` rewrites TIFF tag 274 to `1` (bounds-checked in-place copy) before injection — otherwise consumers would rotate a second time; with `applyOrientation: false` the stored geometry is kept and the tag stays verbatim. Both injectors are **fail-safe**: unparsable encoder output, malformed EXIF blocks, or size overflows return the original bytes untouched (metadata loss, never corruption). Default-off is a privacy decision — EXIF can carry GPS.
- **AVIF capability probe**: `render/canvas.ts` probes canvas AVIF encoding once per environment (1×1 `toBlob`, module-cached promise; test hook `__resetAvifProbe`) and rejects with `format_unsupported` where unsupported (e.g. Safari). `convertHeic`/`convertMany` call `assertEncodeCapability(format)` **before** paying for a decode; `renderAndEncode` keeps a defensive re-check (worker realms, engines that ignore unknown types) plus a `blob.type` re-check at encode. A wedged `toBlob()` is bounded by a 5-second deadline — indeterminate results are *not* cached (next call re-probes).
- **Batch/worker plumbing**: `convertMany` and `convertManyInWorker` share one bounded-concurrency runner (`src/batch.ts` `runBoundedBatch`). Abort semantics there: an aborted signal **wins over item-failure aggregation** (the batch rejects with `aborted`), while a batch that completed before the abort **wins over the late abort** (results are returned); with `continueOnError` an abort instead stops launching new items and fills not-yet-started entries with `aborted` errors. Worker-side abort terminates workers immediately; the per-URL semaphore never over-admits (a waiter cancelled while queued leaves the queue without granting its place to the next caller). Option validation is consolidated in `src/validate.ts` (`validateConvertOptions`/`validateBatchOptions`) and runs on the main thread in **all four** entry points — the worker APIs additionally validate `maxConcurrentWorkers` (positive integer) and `timeoutMs` (finite number ≥ 0) up front; `timeoutMs` is a per-call deadline that includes queue wait. The worker result message's `blob` field is widened to `Blob | string | ArrayBuffer` (field name kept for protocol compatibility; settled via `!== undefined`).
- **Bundle composition / lazy chunks**: only the main-thread in-process path is eagerly loaded — the entry plus its eagerly imported shared chunk total ~19.5 KB minified (~7.2 KB gzipped). Minification uses Terser (`tsup.config.ts` `minify: 'terser'`, `compress.passes: 3`), ~6% smaller gzipped than the esbuild default; `terser` is a dev dependency, so the package keeps zero runtime dependencies. Three modules sit behind dynamic `import()` and each ships as its own chunk: the Emscripten glue (`src/wasm/wrapper.ts` → `import('./wrapper/heic-decoder.js')`, ~67 KB, first decode), the Web Worker implementation (`src/index.ts` → `import('./worker')`, ~4.9 KB, first `convertHeicInWorker`/`convertManyInWorker` call — the entry keeps thin same-named wrappers so the public API and the Promise-reject error semantics are unchanged), and the EXIF injectors (`src/render/canvas.ts` → `import('./exif')` inside `withExif` *after* its `preserveExif` early return, ~2.7 KB). Because `Messages` is a single object literal that esbuild cannot tree-shake per property, worker-only message text lives in `src/messages/worker.ts` (`WorkerMessages`) rather than `src/messages/core.ts` (`Messages`) — adding a worker-only string to `Messages` moves it back into the eager chunk. `test/unit/bundle.test.ts` guards all of this (dynamic-edge presence, a size floor per deferred chunk so a hoist-into-shared-chunk fails, and a 22 KB eager budget); it skips when `dist/` is absent and therefore runs in CI, which builds first. Do not undo these boundaries by adding a static `import` of `./worker` or `./exif` to the entry or the render stage.
- **WASM build**: `build-wasm.sh` pins `libde265 1.1.3`, `libheif 1.23.5`, and the `emscripten/emsdk:3.1.56` Docker image. libde265 ≥ 1.1.0 is CMake-only (no autotools), so it is built with `emcmake cmake`. Sources come from git submodules (`build-wasm/src/`), verified against the pinned tags before building. Artifacts are copied into `src/wasm/`. Build flags that must be preserved: `-s DYNAMIC_EXECUTION=0`, `-s ALLOW_MEMORY_GROWTH=1`, `-s EXPORT_ES6=1`, `-s MODULARIZE=1`, `-s ENVIRONMENT="web,worker,node"`, `--bind`, `-O3`. Cache stamps include a hash of `build-wasm.sh` itself, so editing *any* build flag forces both libraries to rebuild — a version-only stamp silently reuses archives built with the old flags.
- **WASM size (tuned in 0.5.1)**: two levers are shipped, and both are runtime-validated by the real-decode integration tests + browser E2E: `-s MALLOC=emmalloc` at link, and a **post-link** `wasm-opt -O3 --zero-filled-memory` pass over the emitted module. Together: 1,307,940 → **1,294,646 B raw** (−13 KB), 420,608 → **413,850 B gz** (−6.8 KB, −1.6%), 312,187 → **306,416 B brotli** (−5.8 KB) — the gz/br numbers are the packaged `dist/heic-decoder.wasm.gz`/`.br` exactly as `compress-wasm.mjs` emits them (gzip level 9, brotli quality 11). The post-link pass leaves the glue **byte-identical**, so only the `.wasm` hash in `wasm-artifacts.json` moves. Do NOT try these (all measured on 0.5.1): asking *emcc* to size-optimize the link (`-O2`, `-Os`, `-Oz`, `-flto`) produces a smaller module that **fails to instantiate** — it imports a function the generated glue no longer provides (`function import requires a callable`) under `--bind` + MODULARIZE + EXPORT_ES6; `-s FILESYSTEM=0` is unusable for the same reason (module byte-identical, but it genuinely imports the MEMFS syscalls whose stubs the slimmed glue drops); post-link `--minify-imports*` would rename imports the glue already references; post-link `-Oz` and `--strip-target-features` shrink the *raw* file but measurably **increase** gz/brotli, and chaining `-Oz` with `--zero-filled-memory` cancels the zero-fill win. libheif's own knobs are already at their optimal defaults (`WITH_UNCOMPRESSED_CODEC`/`WITH_WEBCODECS`/`WITH_HEADER_COMPRESSION` OFF, `WITH_REDUCED_VISIBILITY` ON) and the archive cannot be trimmed per-object because `box.cc`'s box registry references nearly every translation unit. Re-measure everything against a newer emsdk before chasing more.
- **Env detection**: `render/canvas.ts` supports `OffscreenCanvas` first, then `HTMLCanvasElement`, and throws a clear error in environments with neither. Node users decode raw RGBA via `LibheifDecoder` and encode externally (e.g. `sharp`).

## Conventions

- **Commit messages must follow Conventional Commits** (`feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert`, optional scope). Enforced by the husky `commit-msg` hook; `pre-commit` runs the linter. Example: `feat(wasm): add progress callback support`.
- TypeScript, strict-ish typed code; keep public API surface small and backwards compatible (e.g. `freeSharedDecoder` kept as a no-op).
- Unit tests live in `test/unit/**/*.test.ts` and run in a Node environment with Vitest. Coverage thresholds are configured in `vitest.config.ts`.
- CI (`.github/workflows/ci.yml`) runs `npm ci` → `npm run build` → `npm run test:coverage` (thresholds enforced) → `npx playwright install chromium` → `node test/browser/test-playwright.mjs` (browser E2E: real conversions against the CSP sandbox and the GitHub Pages demo) on pushes/PRs to `main`. The GitHub Pages demo (`.github/workflows/demo-pages.yml`) builds `docs/` + `dist/` into a site artifact and deploys it from `main`.

## Gotchas

- **Never edit generated files**: `src/wasm/wrapper/heic-decoder.js`, `src/wasm/public/heic-decoder.wasm`, or anything in `dist/` / `build-wasm/src/` (submodule C++). Regenerate via `npm run build:wasm` instead.
- **Submodule drift**: `build-wasm.sh` verifies the `build-wasm/src/` submodules are checked out at the pinned tags and fails with a hint if they drift. Bump `LIBDE265_VERSION`/`LIBHEIF_VERSION` **and** `git checkout` the new tag in the submodule; if the `src/wasm` artifacts look unchanged after a bump, check the submodule commit.
- **`npm run build:wasm` requires Docker and network access** (fetches submodules on first checkout). It takes a long time; only run it when changing `main.cpp`, the build script, or lib versions.
- **Two separate "builds"**: `build` (TS → `dist/`) and `build:wasm` (C++ → WASM). Most frontend work only needs `npm run build`.
- `.wasm` is externalized from the main bundle (`tsup.config.ts` `external`) and served separately; changing how it's located/loaded must stay compatible with `locateFile` and `wasmBinary` options.
- Tests that decode real HEIC files require the built WASM artifact — run `npm run build:wasm` (or ensure `src/wasm/public/heic-decoder.wasm` exists) before running integration tests.
- **WASM build changes must be executed, not just measured.** Every size flag rejected in 0.5.1 built cleanly and produced a *smaller* `heic-decoder.wasm`; they only failed at `WebAssembly.instantiate()` in `test/unit/integration.test.ts`. Compare artifact sizes all you like, but adopt nothing until the real-decode integration tests and the browser E2E suite pass against the rebuilt pair (`src/wasm/public/heic-decoder.wasm` + `src/wasm/wrapper/heic-decoder.js` come from one `emcc` invocation — always replace them together, then `npm run wasm:hashes`).
- **Never put a double quote inside the `bash -c "..."` block in `build-wasm.sh`.** The whole container script is one double-quoted string, so an unescaped `"` (even in a comment) truncates it — `docker` still exits 0, `bash -n` still passes, and the build silently stops before the link. The script now requires a `Build complete!` sentinel in the container output, so a truncated run fails loudly. Use single quotes inside that block.
- Keep the library environment-agnostic at import time: no top-level browser-only references (e.g. `document`, `Blob` usage is guarded).
