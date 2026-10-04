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
| `npm run check:scripts` | Fail if any dev dependency declares `preinstall`/`install`/`postinstall` beyond the allowlist in `build-scripts/install-scripts.json` (`-- --write` regenerates it after review) |
| `npm run verify:provenance` | Assert the published tarball carries a SLSA attestation, `gitHead`, and sha512 integrity (runs after `npm publish` in CI) |
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
  worker.ts                 # convertHeicInWorker / convertManyInWorker + worker semaphore
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
  check-install-scripts.mjs # Dev-tree install-script allowlist gate (npm run check:scripts)
  install-scripts.json      # Reviewed set of packages allowed to run install scripts
  verify-npm-provenance.mjs # Post-publish SLSA attestation / gitHead / integrity check
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
- **WASM wrapper** (`build-wasm/wrapper/main.cpp`): uses embind to expose `HeicDecoder.decode(string, progressCb)`, returning `{ width, height, data, orientation?, exif? }` where `data` is a `Uint8Array` (RGBA, interleaved) and `exif` (when present) is the normalized `"Exif\0\0" + TIFF` APP1 payload from the file's Exif item. Errors are returned as strings. In `src/wasm/wrapper.ts`, `LibheifDecoder.decode()` returns an **owned `Uint8ClampedArray` that is never a WASM-heap view** (copied unless the glue proves the buffer is JS-owned) — likewise `exif` is returned as an owned copy so it stays valid after `free()` — so results survive `free()` and concurrent decodes can never corrupt each other's output; `initialize()` memoizes its module-loading promise so concurrent calls load the module once. The Emscripten glue is loaded via dynamic `import()` inside `initialize()` (with tsup `splitting: true`) so it ships as a lazy chunk and the main entry stays ~26 KB.
- **Orientation policy**: libheif applies `irot`/`imir` display transforms natively at decode (dimensions come back swapped), so those files must never be rotated further. The C++ wrapper reports EXIF tag 274 (`DecodedImage.orientation`, IFD0 only, bounds-checked TIFF parse with 4 MB block / 64-block caps) **only when no `irot`/`imir` fourcc appears anywhere in the container** — conservative by design: the worst case is "not rotated" (pre-0.5 behavior), never double-rotation. `convertHeic` renders the pending orientation as one composed `setTransform` matrix; resize sizing operates on display dimensions (axes swapped for 5–8). `applyOrientation: false` keeps stored geometry. Regression fixtures: `test/fixtures/exif-orientation-6.heic` (EXIF-only, stored 1600×1200 landscape — must decode `orientation: 6` and convert portrait 1200×1600) and `test/fixtures/irot-orientation-6.heic` (both signals — must decode upright with **no** pending orientation).
- **Progress callbacks**: For libheif < 1.21, `build-scripts/patch-libheif.py` patches `context.cc` with start/on/end progress hooks around tile decoding. libheif ≥ 1.21 ships these natively in `image-items/grid.cc` (grid decoding moved there), which the patch script detects and skips. `build-wasm.sh` pins 1.23.5, so the patch normally no-ops.
- **EXIF preservation policy** (`preserveExif`, default `false`): the C++ wrapper extracts the file's Exif item and normalizes it to `"Exif\0\0" + TIFF` (`DecodedImage.exif`), read **unguarded** by the `irot`/`imir` fourcc check — unlike `orientation`, which stays guarded (preserving metadata is orthogonal to display transforms). `convertHeic` re-injects the block only for JPEG (APP1 segment after APP0; payloads beyond the 65,533-byte segment limit are skipped) and PNG (`eXIf` chunk before the first IDAT, CRC32 computed in `src/render/exif.ts`); WebP/SVG ignore it. Because the rendered raster is already upright whenever the rotation was baked in (applied at render or by libheif for `irot`/`imir`), `normalizeOrientationTag` rewrites TIFF tag 274 to `1` (bounds-checked in-place copy) before injection — otherwise consumers would rotate a second time; with `applyOrientation: false` the stored geometry is kept and the tag stays verbatim. Both injectors are **fail-safe**: unparsable encoder output, malformed EXIF blocks, or size overflows return the original bytes untouched (metadata loss, never corruption). Default-off is a privacy decision — EXIF can carry GPS.
- **AVIF capability probe**: `render/canvas.ts` probes canvas AVIF encoding once per environment (1×1 `toBlob`, module-cached promise; test hook `__resetAvifProbe`) and rejects with `format_unsupported` where unsupported (e.g. Safari). `convertHeic`/`convertMany` call `assertEncodeCapability(format)` **before** paying for a decode; `renderAndEncode` keeps a defensive re-check (worker realms, engines that ignore unknown types) plus a `blob.type` re-check at encode. A wedged `toBlob()` is bounded by a 5-second deadline — indeterminate results are *not* cached (next call re-probes).
- **Batch/worker plumbing**: `convertMany` and `convertManyInWorker` share one bounded-concurrency runner (`src/batch.ts` `runBoundedBatch`). Abort semantics there: an aborted signal **wins over item-failure aggregation** (the batch rejects with `aborted`), while a batch that completed before the abort **wins over the late abort** (results are returned); with `continueOnError` an abort instead stops launching new items and fills not-yet-started entries with `aborted` errors. Worker-side abort terminates workers immediately; the per-URL semaphore never over-admits (a waiter cancelled while queued leaves the queue without granting its place to the next caller). Option validation is consolidated in `src/validate.ts` (`validateConvertOptions`/`validateBatchOptions`) and runs on the main thread in **all four** entry points — the worker APIs additionally validate `maxConcurrentWorkers` (positive integer) and `timeoutMs` (finite number ≥ 0) up front; `timeoutMs` is a per-call deadline that includes queue wait. The worker result message's `blob` field is widened to `Blob | string | ArrayBuffer` (field name kept for protocol compatibility; settled via `!== undefined`).
- **WASM build**: `build-wasm.sh` pins `libde265 1.1.3`, `libheif 1.23.5`, and the `emscripten/emsdk:3.1.56` Docker image. libde265 ≥ 1.1.0 is CMake-only (no autotools), so it is built with `emcmake cmake`. Sources come from git submodules (`build-wasm/src/`), verified against the pinned tags before building. Artifacts are copied into `src/wasm/`. Build flags that must be preserved: `-s DYNAMIC_EXECUTION=0`, `-s ALLOW_MEMORY_GROWTH=1`, `-s EXPORT_ES6=1`, `-s MODULARIZE=1`, `-s ENVIRONMENT="web,worker,node"`, `--bind`, `-O3`.
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
- Keep the library environment-agnostic at import time: no top-level browser-only references (e.g. `document`, `Blob` usage is guarded).
- **Never disguise a string to silence a scanner.** Scanners report three signals on this package and all three are correct-but-harmless: `Network access` (the generated Emscripten glue `fetch()`es `heic-decoder.wasm`), `URL strings` (the `http://www.w3.org/2000/svg` XML namespace in SVG output), and `Minified code` (Terser output on purpose). Concatenating a literal into fragments, hex-encoding it, or renaming it to dodge a heuristic is how malware behaves and how a maintainer loses trust — document it in the README's _Supply chain & trust_ table instead, and change the code only when the signal describes something actually wrong.
- **Dev-tree install scripts are the only code-execution surface here** (the package has no runtime dependencies). `npm ci --ignore-scripts` is not usable because esbuild's postinstall links its platform binary, so the set of packages declaring `preinstall`/`install`/`postinstall` is pinned in `build-scripts/install-scripts.json` and CI fails on drift. When a legitimate dependency is added: read its script, then `npm run check:scripts -- --write` and commit the diff.
