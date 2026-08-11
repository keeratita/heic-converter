# AGENTS.md

Guidance for AI agents and contributors working in this repository.

## Project Overview

`@keeratita/heic-converter` is a TypeScript library that converts `.heic`/`.heif` images to standard web formats (**JPEG, PNG, WebP, SVG**) in the browser or Node.js.

Key design constraints:

- **CSP-compliant**: The libheif C++ code is compiled to WebAssembly with Emscripten using `-s DYNAMIC_EXECUTION=0` — no `eval()` or `new Function()` is ever generated. Do not remove this flag from the WASM build.
- **Zero runtime dependencies**: The package has no production dependencies. Do not add any.
- **Isomorphic**: Runs in both browsers (full conversion via Canvas) and Node.js (raw RGBA decoding only — Canvas encoding is unavailable and `convertHeic` throws on the backend).
- **libheif-based**: HEIC decoding is done by `libheif` (with `libde265`), cross-compiled to WASM via Emscripten inside Docker.

## Commands

| Command | Description |
| --- | --- |
| `npm run build` | Build the TS library to `dist/` (CJS + ESM + `.d.ts`) via tsup |
| `npm run build:wasm` | Rebuild the WASM decoder (`build-scripts/build-wasm.sh`) — **requires Docker** |
| `npm test` / `npm run test` | Run unit tests (Vitest, Node environment) |
| `npm run test:watch` | Run unit tests in watch mode |
| `npm run test:browser` | Run tests in a real browser via `@vitest/browser` + Playwright |
| `npm run test:coverage` | Run tests with coverage; thresholds are enforced in `vitest.config.ts` (80% lines/functions/statements, 70% branches) |
| `npm run sandbox` | Start the interactive CSP sandbox server at `http://localhost:3000` (`test/browser/server.mjs`) |
| `npm run lint` | ESLint over the whole repo (also runs via the `pre-commit` husky hook) |
| `npm run sonar` | Run SonarQube scanner (`sonar-project.properties`) |
| `npm run release [patch\|minor\|major\|current]` | Lint → build → test, then bump version, commit (`chore(release): X.Y.Z`), tag (`vX.Y.Z`), and push. Requires a clean working tree |

Node `>=20` is required (see `engines`).

## Repository Layout

```
src/
  index.ts                  # Public API: convertHeic(), freeSharedDecoder()
  types.ts                  # IHeicDecoder, DecodedImage, ConvertOptions, ImageFormat
  render/canvas.ts          # Render RGBA to canvas + encode (JPEG/PNG/WebP/SVG); base64 helpers
  wasm/
    wrapper.ts              # LibheifDecoder — wraps the Emscripten glue module
    wrapper/heic-decoder.js # GENERATED Emscripten glue — do not edit
    public/heic-decoder.wasm # GENERATED WASM binary — do not edit
build-wasm/
  src/libheif/ src/libde265/ # Vendored C++ sources (downloaded by build-wasm.sh)
  wrapper/main.cpp           # C++ wrapper: embind class HeicDecoder exposing decode()
build-scripts/
  build-wasm.sh             # Docker + Emscripten build pipeline
  patch-libheif.py          # Patches libheif context.cc to emit progress callbacks
  release.js                # SemVer release automation
test/
  unit/                     # Vitest unit tests (integration tests use the real WASM)
  browser/                  # CSP sandbox + Playwright browser tests
  fixtures/                 # Test HEIC images
```

## Architecture & Key Facts

- **Conversion flow** (`convertHeic` in `src/index.ts`): normalize input → validate `quality` (0.0–1.0) → pick decoder (user-injected `options.decoder` or a fresh `LibheifDecoder`) → `initialize()` → `decode()` → `renderAndEncode()` → **always free the decoder in `finally` — but only if the library created it** (never free a user-injected decoder).
- **Decoder instance lifecycle**: A fresh `LibheifDecoder` is created *per conversion* so concurrent calls never share mutable WASM state. `freeSharedDecoder()` is a **no-op kept for API compatibility** — do not reintroduce a shared instance without discussion.
- **WASM wrapper** (`build-wasm/wrapper/main.cpp`): uses embind to expose `HeicDecoder.decode(string, progressCb)`, returning `{ width, height, data }` where `data` is a `Uint8Array` (RGBA, interleaved). Errors are returned as strings.
- **Progress callbacks**: Requires the `build-scripts/patch-libheif.py` patch against `libheif`'s `context.cc` (start/on/end progress hooks around tile decoding). If you bump `LIBHEIF_VERSION` in `build-wasm.sh`, verify the patch targets still match.
- **WASM build**: `build-wasm.sh` pins `libde265 1.0.15`, `libheif 1.18.2`, and the `emscripten/emsdk:3.1.56` Docker image. Artifacts are copied into `src/wasm/`. Build flags that must be preserved: `-s DYNAMIC_EXECUTION=0`, `-s ALLOW_MEMORY_GROWTH=1`, `-s EXPORT_ES6=1`, `-s MODULARIZE=1`, `-s ENVIRONMENT="web,worker,node"`, `--bind`, `-O3`.
- **Env detection**: `render/canvas.ts` supports `OffscreenCanvas` first, then `HTMLCanvasElement`, and throws a clear error in environments with neither. Node users decode raw RGBA via `LibheifDecoder` and encode externally (e.g. `sharp`).

## Conventions

- **Commit messages must follow Conventional Commits** (`feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert`, optional scope). Enforced by the husky `commit-msg` hook; `pre-commit` runs the linter. Example: `feat(wasm): add progress callback support`.
- TypeScript, strict-ish typed code; keep public API surface small and backwards compatible (e.g. `freeSharedDecoder` kept as a no-op).
- Unit tests live in `test/unit/**/*.test.ts` and run in a Node environment with Vitest. Coverage thresholds are configured in `vitest.config.ts`.
- CI (`.github/workflows/ci.yml`) runs `npm ci` → `npm run build` → `npm run test` on pushes/PRs to `main`. The GitHub Pages demo (`.github/workflows/demo-pages.yml`) builds `docs/` + `dist/` into a site artifact and deploys it from `main`.

## Gotchas

- **Never edit generated files**: `src/wasm/wrapper/heic-decoder.js`, `src/wasm/public/heic-decoder.wasm`, or anything in `dist/` / `build-wasm/src/` (vendored C++). Regenerate via `npm run build:wasm` instead.
- **`npm run build:wasm` requires Docker and network access** (downloads libheif/libde265 tarballs). It takes a long time; only run it when changing `main.cpp`, the build script, or lib versions.
- **Two separate "builds"**: `build` (TS → `dist/`) and `build:wasm` (C++ → WASM). Most frontend work only needs `npm run build`.
- `.wasm` is externalized from the main bundle (`tsup.config.ts` `external`) and served separately; changing how it's located/loaded must stay compatible with `locateFile` and `wasmBinary` options.
- Tests that decode real HEIC files require the built WASM artifact — run `npm run build:wasm` (or ensure `src/wasm/public/heic-decoder.wasm` exists) before running integration tests.
- Keep the library environment-agnostic at import time: no top-level browser-only references (e.g. `document`, `Blob` usage is guarded).
