# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.1] - 2026-10-04

### Changed

- **Smaller initial bundle, no API change**: the JavaScript a consumer loads before converting anything is now ~20.4 KB minified (~7.6 KB gzipped), down from 0.5.0's single ~26 KB entry (~24% smaller raw, ~18% smaller gzipped). Two modules that every consumer used to pay for regardless of how they use the library are now emitted as separate chunks fetched only when their path is first entered: the Web Worker implementation — worker transport, per-URL semaphore, and worker diagnostics (~4.9 KB) — loads on the first `convertHeicInWorker`/`convertManyInWorker` call, and the JPEG/PNG EXIF injectors (~2.7 KB) load only when `preserveExif: true` is passed. The worker entry points keep their names, signatures, overloads, and Promise-reject error semantics; the first call resolves one extra chunk before running. `import()` is used for both, so bundlers (Vite, webpack, Rollup) rewrite the chunk URLs automatically and no new configuration is required.
- **Build cache no longer ignores WASM flag changes**: `build-scripts/build-wasm.sh` gates its cached libde265/libheif archives on a stamp that includes a hash of the script itself, not just the pinned version. Previously a change to the compile flags was silently ignored — the archives were reused as built with the old flags, so the committed artifacts could look unchanged while no longer matching the script. Any flag edit now forces a clean rebuild of both libraries.
- **WASM decoder is 29% smaller over the wire, no API change**: the first-decode payload a browser pays — eagerly-loaded entry + shared chunk, the Emscripten glue chunk, and `heic-decoder.wasm` — goes from 443,427 to **314,678 bytes gzipped** (-128,749, -29.0%) and from 332,838 to **253,450 brotli** (-23.9%). Three build-flag changes, all in `build-scripts/build-wasm.sh`:
  - **libde265 and libheif compile at `-Oz` while the emcc *link* stays at `-O3`** — the large one: 1,294,646 → **829,227 bytes raw**, 413,850 → **300,609 gzipped**. This is deliberately *not* the same thing as asking emcc to size-optimize the link, which stays forbidden (below): the optimizer level of an archive cannot alter the import/export contract, so the generated glue comes out byte-identical and the module simply carries less code.
  - **`-s FILESYSTEM=0`** at link: the module is byte-for-byte unchanged, but Emscripten stops emitting the MEMFS runtime into the glue, taking it from 68,600 → 36,141 bytes raw (22,413 → 12,472 gzipped). Decoding is memory-only — `heif_context_read_from_memory_without_copy` in, embind RGBA out — and no reachable libheif path opens a file, so the filesystem machinery was pure payload.
  - **`-DLIBHEIF_BOX_EMSCRIPTEN_H`** compiles out libheif's own `EMSCRIPTEN_BINDINGS(libheif)` block (`libheif/api/libheif/heif_emscripten.h`, which `heif.cc` includes unconditionally) even though this package exposes its own embind class from `build-wasm/wrapper/main.cpp`: -5,451 bytes gzipped on top of `-Oz`, and the glue drops further to **33,902 raw / 11,874 gzipped**.
  The shipped binary goes 1,307,940 (0.5.0) → **812,945 bytes raw**, 420,608 → **295,158 gzipped**, 312,187 → **235,967 brotli** — the exact `dist/heic-decoder.wasm.gz`/`.br` bytes the package ships (gzip level 9, brotli quality 11). Both generated artifacts change, so `npm run wasm:hashes` re-pins `build-scripts/wasm-artifacts.json` and `npm run verify:wasm` checks the new pair.
  **How this was validated** (size was never the acceptance criterion): `test/unit/wasm-golden.test.ts` pins the exact decoded RGBA hash, dimensions, pending orientation and EXIF length of every fixture, plus the outcome of 66 deterministic truncations and single-bit flips — decoded-pixel hash or error code each. The `-Oz` build reproduces the `-O3` build's output byte-for-byte on all of them, malformed input still comes back as a typed `HeicConverterError` rather than a module abort, the full unit suite and the browser E2E suite (CSP sandbox + Pages demo) pass against the rebuilt pair.
- **`-s MALLOC=emmalloc` and a post-link `wasm-opt -O3 --zero-filled-memory` pass** remain in the link as earlier in this release: together -13 KB raw / -7.5 KB gzipped / -5.8 KB brotli, and the post-link pass leaves the glue byte-identical. What was *not* taken, and why: asking **emcc** to size-optimize the link (`-O2`, `-Os`, `-Oz`, `-flto`) builds a smaller module that **fails at `WebAssembly.instantiate()`** under the pinned emsdk 3.1.56 (`function import requires a callable`), because those link-time passes desynchronize the minified import names from the generated glue; the same goes for post-link `--minify-imports*`, while post-link `-Oz` and `--strip-target-features` shrink the raw file but measurably *increase* its compressed size. (An earlier draft of this entry listed `-s FILESYSTEM=0` among the rejected flags; that was inferred from builds which also used link-level `-Oz`/`-flto`, the actual cause of failure, and is wrong.)
- **libheif's codec options are now spelled correctly, and the build verifies them**: `-DWITH_AOM=OFF`, `-DWITH_JPEG=OFF` and `-DWITH_OPENJPEG=OFF` are not options libheif 1.23.5 declares — CMake accepted them as `UNINITIALIZED` cache entries and ignored them, so the real knobs (`WITH_AOM_DECODER`/`WITH_AOM_ENCODER`, `WITH_JPEG_DECODER`/`WITH_JPEG_ENCODER`, `WITH_OpenJPEG_DECODER`/`WITH_OpenJPEG_ENCODER`, `WITH_X264`, `WITH_OpenH264_DECODER`/`WITH_OpenH264_ENCODER`) kept their `ON` defaults and those codecs stayed out of the binary only incidentally, because their `find_package` calls fail inside the emsdk image. The script now passes the names libheif actually declares, and fails the build outright if `CMakeCache.txt` shows a third-party codec resolving (libde265 excepted, as the one intended dependency).
- **Error strings tree-shake per consumer**: the centralized message dictionary is split into `src/messages/core.ts` (`Messages`, main-thread) and `src/messages/worker.ts` (`WorkerMessages`). An object literal cannot be tree-shaken per property, so keeping worker-only diagnostics in a module the worker alone imports is what keeps their text inside the lazy worker chunk instead of the eager bundle. Message wording is unchanged.
- **Terser minification**: the tsup build now minifies with Terser (`minify: 'terser'`, `compress.passes: 3`) instead of esbuild's minifier, trimming a further ~6% off the gzipped JS — including the lazily-loaded Emscripten glue chunk, from ~70 KB to ~67 KB raw (~23.9 KB → ~22.4 KB gzipped, before the glue-shrinking flags above take it to 33,902 raw / 11,874 gzipped). Terser is a dev dependency only; the package still has zero runtime dependencies.
- **AVIF support is no longer denied on an indeterminate probe**: the 1×1 capability probe now distinguishes three outcomes. Previously a `toBlob()` whose callback was starved (backgrounded tab, memory pressure) resolved `false`, and because that answer is cached per environment, every later AVIF conversion in the page — including callers that never raced the timeout — was rejected with `format_unsupported` on a browser that encodes AVIF fine. A starved probe (or a `createCanvas` failure) now yields "unknown": nothing is cached, the next call re-probes, and only a definitive `false` (wrong blob type, empty blob, refused encode) may reject up front. Indeterminate cases fall through to the existing encode-time `blob.type` check, which sees what the real encoder produced.
- **A decoder whose WebAssembly module faulted is discarded, not reused**: a trap inside the module (bad heap write, OOM abort, `unreachable`) leaves emmalloc's arena unusable, but nothing marked the instance as broken — with `convertMany({ reuseDecoders: true })` the next batch item could be handed the corrupted heap. Such an instance is now recorded in a module-private registry, freed instead of parked by the pool, and its slot returned, so a fully faulted pool cannot park waiters forever. `free()` clears the mark, since it drops the whole module.
- **Decoder error text is sanitized before it reaches `Error.message`**: libheif builds some of its error strings from raw container bytes (fourccs, mime types, item names), so `HEIC decoding failed: <detail>` embedded attacker-controlled control characters into a string consumers routinely log — and that the demo page writes into the DOM. Control characters are now stripped and the detail clamped to 200 characters.
- **The supply-chain gates read more than names**: `npm run check:scripts` pins each allowlisted package by name **and** version, so a new release of an already-reviewed dependency can no longer run unreviewed code at install time without a red CI run; it also flags non-registry dependencies (`file:`/`link:`/git URLs) and no longer follows symlinks, which a self-referential link could turn into a stack overflow instead of a verdict. `npm run verify:provenance` now fetches the registry's attestation document and checks the SLSA predicate itself — DSSE payload, in-toto subject `pkg:npm/<name>@<version>`, GitHub-Actions build type — rather than accepting the presence of an `attestations` field. Checked against the live registry: 0.5.0 passes, 0.1.0 through 0.4.2 correctly fail.
- **The publish workflow no longer holds the OIDC token while installing dependencies**: `npm ci` executes dev-dependency install scripts, and `id-token: write` exports `ACTIONS_ID_TOKEN_REQUEST_TOKEN` to every step of the job that has it, so a compromised dev dependency could have minted an npm token while it ran. Verification (`npm ci`, gates, build, coverage) now runs in a token-less job that uploads `dist/`, and `publish` downloads those exact bytes, refuses a tag that is not an ancestor of `main`, and pins `--registry https://registry.npmjs.org` on the command line so a repointed `publishConfig.registry` cannot redirect the release — or the gate that confirms it.

### Added

- **Bundle-boundary test** (`test/unit/bundle.test.ts`): asserts the Emscripten glue, the Web Worker implementation, and the EXIF injectors remain behind dynamic `import()` — each deferred chunk must still carry its own code, so silently hoisting one back into the eagerly-loaded shared chunk fails — plus a 22 KB budget on the eagerly loaded JS. Extended in this release to cover **both published formats** (ESM and CJS are separate tsup passes and can regress independently), to require that every chunk a built file references actually exists in `dist/`, that `dist/heic-decoder.wasm` is byte-identical to `src/wasm/public/heic-decoder.wasm`, and to enforce ceilings on the glue chunk, the WASM, and the whole first-decode payload so none of the size flags below can be dropped without a red test. The suite skips when `dist/` is absent, so a bare `npm test` on a fresh checkout is unaffected; CI builds before testing, so the guard runs there.
- **WASM output goldens** (`test/unit/wasm-golden.test.ts`): pins the exact decoded RGBA hash, dimensions, pending orientation and EXIF length of every fixture, and the outcome (decoded-pixel hash or error code) of 66 deterministic truncations, empties, garbage inputs and single-bit flips. Its job is to catch a size or codegen change that yields a *decodable but wrong* image — which "does it decode?" assertions cannot catch — and to keep malformed input coming back as a typed `HeicConverterError` instead of an Emscripten abort. Also sweeps 41 truncation offsets across the container header and file, requiring that each either decodes with sane dimensions or throws a typed error, and that a freshly created decoder still decodes a good file after the whole sweep (so no malformed input can leave a faulted module that the next decode inherits). Like the other real-WASM suites it skips without artifacts outside CI and fails hard inside CI.
- **Deferred-entry-point pass-through tests** (`test/unit/worker-entry.test.ts`): the public `convertHeicInWorker`/`convertManyInWorker` wrappers are what callers run, and `worker.test.ts` drives the worker module directly, so until now their success path had no coverage at all. They now assert arguments are forwarded by identity, the resolved value passes through untouched for every `OutputShape`, and an error raised *by the worker implementation* keeps its identity and `code` — the counterpart to `worker_load_failed` below, which must only ever apply to a failed chunk fetch.
- **EXIF fail-safe matrix** (`test/unit/exif-inject.test.ts`): the refusal paths that make "metadata loss, never corruption" true were largely unexercised — now covered for a header shorter than marker+TIFF, a marker with no TIFF, a non-TIFF byte-order mark, a wrong magic, a JPEG segment header cut off mid-field, `0xFF` fill bytes between markers (must be walked past, not treated as a desynchronized stream), a PNG whose first chunk is not a 13-byte IHDR, and an orientation tag that is not the first IFD0 entry (a `break` where the `continue` belongs would ship images that consumers rotate twice).
- **`worker_load_failed` error code**: `HeicConverterErrorCode` gains this additive code, thrown by `convertHeicInWorker`/`convertManyInWorker` when the lazily imported worker chunk cannot be fetched. Codes remain additive-only.
- **Precompressed WASM is now round-tripped at build time**: `build-scripts/compress-wasm.mjs` decompresses the `heic-decoder.wasm.gz` and `.br` it just wrote and fails the build unless they reproduce the binary exactly, so a corrupt sidecar cannot be served by a CDN configured with `gzip_static`/`brotli_static`. The check is exported (`verifySidecars`) and covered by `test/unit/compress-wasm.test.ts`, including the case that matters — a well-formed compression of *different* bytes, which decompresses cleanly and only a comparison against the source can catch.
- **The test tree is typechecked**: `npm run typecheck` runs `tsc` over `src/` **and** `test/` via `tsconfig.test.json` (`@types/node` is now a dev dependency), wired into CI and the `pre-commit` hook. Tests were excluded from `tsconfig.json` outright, so a test file could be broken without anything noticing until it ran. On its first run it found tests passing options that do not exist — `format: 'webp'` for `to`, `output: 'arraybuffer'` for `'arrayBuffer'` — which those tests had been silently exercising as defaults, and a `TIFF is not defined` that only surfaced at runtime.
- **README error table is checked against the code** (`test/unit/readme.test.ts`): every `HeicConverterErrorCode` must have exactly one row in the README table and every row must name a real code, so a code can no longer be added without being documented (`worker_load_failed` shipped undocumented) and the table cannot silently lose its shape — one row had drifted below an intervening paragraph and rendered as literal pipe characters.

### Fixed

- **A module fault no longer escapes untyped.** `LibheifDecoder.decode()` propagated a raw `WebAssembly.RuntimeError` when the decoder trapped internally, while SECURITY.md promises malformed input comes back as a typed `HeicConverterError`. Faults (bad heap write, OOM abort, `unreachable`) are now wrapped as `HeicConverterError('decode_failed')` with the original on `cause`, and the instance is marked unusable (see _Changed_). The golden suite already asserted "never a raw `RuntimeError`" — the assertion held because no fixture happened to trap; now the code guarantees it.
- **A missing EXIF injector chunk no longer looks like "the file had no Exif item".** `preserveExif` treats a failure to fetch the lazy `dist/exif-*.mjs` chunk as fail-safe and converts without metadata, which made a bad deployment (partial upload, wrong MIME type) indistinguishable from ordinary input — the equivalent worker failure has its own `worker_load_failed` code. The first occurrence now logs a one-time `console.warn` naming `dist/exif-*.mjs`; conversions still succeed.

- **Worker entry points can no longer reject with a non-`HeicConverterError`.** Since 0.5.1 defers the worker implementation, a deployment missing `dist/worker-*.mjs` (or a bundler that did not emit it) made `convertHeicInWorker`/`convertManyInWorker` reject with a raw `ERR_MODULE_NOT_FOUND`/`TypeError` — breaking the documented contract that these APIs reject only with a `HeicConverterError` carrying a machine-readable `code`. Such failures now surface as `HeicConverterError('worker_load_failed')` with the original error on `cause`.
- **`preserveExif` no longer fails the conversion when the EXIF chunk is unavailable.** The opt-in JPEG/PNG injectors are a lazy chunk; if it could not be fetched, the whole conversion rejected. The documented fail-safe policy now holds for that case too: the encoder's bytes are returned unchanged and the image converts without metadata, as it already did for unparsable encoder output and malformed EXIF blocks.
- **The real-WASM decoder suite can no longer skip green on CI.** `test/unit/decoder.test.ts` marked each test `it.skipIf(!hasArtifacts)` and only warned when artifacts were missing — and because vitest skips `beforeAll` entirely when every test in a suite is skipped, CI reported success with all 35 real-decode tests absent (verified: `CI=true` with `dist/heic-decoder.wasm` hidden exited 0). It now skips the whole suite only outside CI, matching `integration.test.ts`, and `.github/workflows/ci.yml` checks every fixture the suites require instead of only `example.heic`.

## [0.5.0] - 2026-10-04

### Added

- **Structured error codes**: every thrown error is now a `HeicConverterError` (exported, with the `HeicConverterErrorCode` type) carrying a machine-readable `code` (`invalid_input`, `invalid_quality`, `invalid_resize`, `invalid_format`, `invalid_crop`, `invalid_concurrency`, `decoder_init_failed`, `decode_failed`, `unsupported_environment`, `render_encode_failed`, `format_unsupported`, `aborted`, `progress_callback_failed`, `worker_unsupported`, `worker_create_failed`, `worker_post_failed`, `worker_timeout`, `worker_failed`, `batch_item_failed`), a `cause` where an underlying error exists, and — for `convertMany` — `itemIndex`/`itemTotal`/`failedCount` fields. Error messages gained context (input byte length on decode failures, worker URL on worker failures, progress/protocol diagnostics on timeouts).
- **`convertHeicInWorker` concurrency control**: concurrent conversions are now bounded per worker script via a new `maxConcurrentWorkers` option (default: `navigator.hardwareConcurrency` clamped to 1–8); calls beyond the cap queue and start as slots free. Passing the (non-cloneable) `decoder` option now rejects immediately with `invalid_input` instead of being silently stripped; `WorkerConvertOptions` omits `decoder` at the type level.
- **Early environment & option checks**: `convertHeic`/`convertMany` now validate the format, options, and canvas availability *before* loading the WASM module or decoding, so Node.js users get `unsupported_environment` immediately instead of a wrapped decode-stage failure.
- **WASM artifact verification**: new `npm run verify:wasm` (`build-scripts/verify-wasm-artifacts.mjs`) checks the committed glue/binary against pinned SHA-256 hashes (`build-scripts/wasm-artifacts.json`, regenerated with `npm run wasm:hashes`) and scans the Emscripten glue for `eval`/`new Function` — wired into CI. Dependabot now bumps GitHub Actions and npm dependencies.
- **EXIF orientation support**: `convertHeic`/`convertMany` upright images whose intended display rotation lives only in the EXIF orientation tag (274), matching how browsers, Photos, and other viewers display such files. Controlled by the new `applyOrientation` option (default `true`; non-boolean values reject with `invalid_input`). `LibheifDecoder.decode()` exposes the pending rotation to raw-decode consumers via the optional `DecodedImage.orientation` field (`2`–`8`, absent when nothing is pending). HEIF `irot`/`imir` transforms remain applied by libheif at decode and are never stacked with the EXIF tag: files carrying those boxes report no pending orientation, so Apple-style files are never double-rotated. The C++ wrapper reads the tag from the Exif item's IFD0 with a bounds-checked TIFF parser (conservative: any parse anomaly falls back to "upright"; oversized metadata blocks are skipped).
- **AVIF output**: `to: 'avif'` (quality applies). Because canvas `toBlob()` silently falls back to PNG for unsupported types, the library probes AVIF encoding once per environment and rejects with the dedicated `format_unsupported` code where the canvas cannot produce AVIF (e.g. Safari) instead of mislabeling a PNG — browsers outside the probe simply never pay for the conversion: `convertHeic`/`convertMany` run the gate up front, before the WASM load and decode. The probe races a 5-second deadline so a wedged `toBlob()` can neither hang every later AVIF conversion nor poison the cache with a false negative (indeterminate results are re-probed).
- **Output shapes**: `output: 'blob' | 'dataUrl' | 'arrayBuffer'` (default `'blob'`) on `convertHeic`/`convertMany`/`convertManyInWorker`, with typed overloads — `'dataUrl'` returns a `data:image/…;base64,…` string (previews, `<img src>`), `'arrayBuffer'` the raw bytes (uploads, custom pipelines). Invalid values reject with `invalid_input`.
- **Batch continue-on-error**: `convertMany`/`convertManyInWorker` with `continueOnError: true` fulfill with per-item `{ index, ok: true, result }` / `{ index, ok: false, error }` entries (`ConvertItemResult`) in input order instead of rejecting the whole batch on the first failure; all items run to completion. Up-front option validation still rejects immediately (a typo is not an item failure). With `continueOnError`, a mid-batch abort stops launching new items and completes the not-yet-started entries with `aborted` errors (started items still settle normally). A `continueOnError` flag widened to `boolean` (e.g. from app state) is fully typed: the return type covers both batch shapes instead of silently lying.
- **Cropping**: `crop: { x?, y?, width, height }` cuts a rectangle from the image in **post-orientation display pixels** (what the user sees), applied before `scale`/`maxWidth`/`maxHeight`, which then downscale the cropped region. Crop and orientation compose into a single canvas transform. Shape errors (`invalid_crop`, e.g. non-integer or non-positive values) fail before decoding; out-of-bounds rectangles reject with `invalid_crop` naming the actual display size.
- **EXIF preservation**: `preserveExif: true` re-injects the source HEIC's EXIF block into JPEG output (as an APP1 segment after the JFIF APP0) and PNG output (as an `eXIf` chunk before the first IDAT), so converted files keep camera metadata (GPS, timestamps, color info). The orientation tag (274) in the injected block is normalized to `1` whenever the intended rotation was baked into the output raster (applied at render, or already applied by libheif for `irot`/`imir` files) — otherwise EXIF-respecting consumers would rotate the image a second time; with `applyOrientation: false` the stored geometry is kept and the tag stays verbatim. Opt-in — metadata can contain private data like GPS. The C++ wrapper normalizes the Exif item to the `"Exif\0\0" + TIFF` APP1 payload and exposes it as `DecodedImage.exif` (owned copy; available for `irot`/`imir` files too, so raw Node pipelines can pass it to e.g. `sharp.withMetadata({ exif })`). Injectors are fail-safe: unparsable encoder output, malformed blocks, or EXIF payloads beyond the 64 KB JPEG segment limit leave the output untouched (metadata loss, never corruption).
- **Cooperative cancellation**: `signal: AbortSignal` (optionally with `options.output`/`crop`/etc.) on `convertHeic`, `convertMany`, and the worker APIs. Cancellation is checked at stage boundaries (input read, before decode, after decode, before encode); `convertHeicInWorker`/`convertManyInWorker` aborts terminate the worker(s) immediately. An aborted signal rejects with the dedicated `aborted` code; a mid-batch abort supersedes item-failure aggregation.
- **`convertManyInWorker(inputs, options)`**: batch conversion inside Web Workers mirroring `convertMany` semantics (input order, `continueOnError`, per-item `onProgress(index, percent)`), with real concurrency bounded by `maxConcurrentWorkers` via the worker semaphore.
- **Decoder reuse for batches**: `convertMany({ reuseDecoders: true })` amortizes the WASM module load by handing each batch runner one pooled `LibheifDecoder` (acquire/release, never shared while in use) instead of creating an instance per item — large batches skip the ~2.5 ms/instance init/free cost (measured) without weakening the exclusive-use invariant. Opt-in; the default per-conversion lifecycle is unchanged.

### Changed

- **Decoder wrapper hardening** (`src/wasm/wrapper.ts`, `build-wasm/wrapper/main.cpp` — C++ changes take effect on the next `npm run build:wasm`): `free()` during `initialize()` no longer races (generation counter); `decode()` after `free()` transparently re-initializes; pixel and EXIF buffers are only shared (not defensively re-copied) when provably JS-owned; a new zero-copy input fast path (`decodeFromPointer` + `_malloc`/`_free`) avoids the `std::string` round-trip when the glue exposes it; progress values are normalized/clamped at the wrapper boundary; the C++ wrapper enforces libheif security limits (64 MP / 16384 px per side), validates planes/strides, uses uint64 pixel math, and guards host progress callbacks so a throwing callback can never unwind through a WASM frame.
- **`build-wasm.sh`** now compiles the tracked `build-wasm/wrapper/main.cpp` (previously an inline heredoc copy could drift), stamps cached library builds with their versions, and adds the flags the hardened wrapper needs (`-fexceptions -fcxx-exceptions`, `_malloc`/`_free` exports, `HEAPU8` runtime method).
- **Shared batch/validation plumbing**: `convertMany` and `convertManyInWorker` now run through one bounded-concurrency runner (`src/batch.ts`), and option validators live in `src/validate.ts` — all four entry points report identical codes for identical mistakes: the worker APIs now validate the full option matrix on the main thread before creating any worker (including `maxConcurrentWorkers`, which must be a positive integer, and `timeoutMs`, a finite number ≥ 0 — previously both were silently coerced), so a typo surfaces its own code instead of coming back stringified as `worker_failed`. The render layer's pure validators (`validateFormat`/`validateResize`/`validateCrop`) moved there too (canvas re-exports them), and the batch runner's summary strings are centralized in `src/messages.ts`. Errors raised inside the render stage (e.g. `invalid_crop`, `format_unsupported`) now propagate with their original code instead of being re-wrapped as `render_encode_failed`.
- **Memory**: encoded canvases release their backing store (`close()`/`width = 0`) before base64/SVG assembly; the full-resolution source canvas of a resize is released before the encode step; SVG output assembles its Blob from parts instead of concatenating the full base64 string.
- **Worker timeouts** surface actionable diagnostics (progress count, last percent, unrecognized message types, worker URL) in the `worker_timeout` message.
- `wasmBinary` now accepts any `ArrayBufferView` (e.g. a Node.js `Buffer` from `fs.readFileSync`), not just `ArrayBuffer`.
- Release automation moved to `build-scripts/release.mjs` (ESM): branch detection failures are fatal and push failures print recovery hints instead of exiting silently.

### Fixed

- **GitHub Pages demo worker mode**: the Pages workflow copied only `index.html`, `demo.js`, and `dist/` into the site artifact — never `docs/worker.js` — so the deployed 0.4.x demo's Web Worker option failed with a 404 on the worker script. The workflow now copies `worker.js` and fails the build when it is missing.
- **Sideways output for EXIF-rotated HEIC**: files whose pixels are stored rotated with only an EXIF orientation tag (no `irot`/`imir` boxes — written by tools that just rewrite metadata) previously converted to rotated output; they now come out upright like every viewer shows them (see the `applyOrientation` option and the Orientation section in the README).
- `convertHeic` no longer rejects with a misleading decode error in environments without canvas APIs, and `onProgress: null`/non-function values are treated as absent instead of throwing mid-decode.
- `convertMany` frees decoders of in-flight items when the batch rejects early, summarizes the failed-item count in the rejection (with up to two additional failure messages), and attributes `null` rejections with the item index.
- **Worker semaphore over-admission**: cancelling a `convertHeicInWorker`/`convertManyInWorker` call while it was still queued behind `maxConcurrentWorkers` handed its place in line to the next queued caller, admitting more live workers than the configured cap; a cancelled waiter now simply leaves the queue.
- **Aborted conversions no longer report completion**: `convertHeic` checked cancellation after releasing the withheld 100% progress, so a conversion that aborted during encoding could emit `onProgress(100)` before rejecting with `aborted`.
- A failed `FileReader` during dataUrl/SVG base64 assembly rejected with a raw `DOMException`; it now surfaces as `render_encode_failed` with the underlying error as `cause`.
- `decoder_init_failed` messages now point at the two usual culprits (unserved `heic-decoder.wasm` asset, missing `'wasm-unsafe-eval'` CSP allowance) instead of only echoing the module loader's error.

### Testing

- Unit tests share a mock harness (`test/unit/helpers/convert-mocks.ts`), pin the new error codes/fields, exercise the wrapper fast path and buffer-ownership logic, cover worker queueing/timeout diagnostics, and no longer mutate globals without restoring them. The real-WASM suites fail hard on CI when artifacts are missing instead of silently skipping.
- New 0.5.0 coverage: crop transform composition (crop alone, +resize, +orientation, +orientation+resize, display-space bounds), the AVIF capability probe (PNG-fallback rejection, null/throwing probe, caching, defensive final re-check), output shapes, abort boundaries (per-stage, progress withholding, validation-over-abort ordering), `continueOnError` entry shapes/order, `reuseDecoders` pooling (instance-per-runner, frees at batch end, injected-decoder bypass), `convertManyInWorker` queueing/progress/aggregation/abort, and the JPEG/PNG EXIF injectors — including CRC cross-checks against an independent bitwise CRC-32 and fail-safe returns for malformed containers.
- Pre-release review round coverage: EXIF orientation-tag normalization (little/big-endian blocks, already-normal and missing tags, malformed and truncated TIFFs, non-mutation of the decoded block, `applyOrientation: false` passthrough, real-fixture end-to-end against the shipped WASM), the AVIF probe deadline/re-probe behavior and the up-front `assertEncodeCapability` gate, the worker entry-point validation matrix (option typos, `maxConcurrentWorkers`, `timeoutMs`), strict semaphore cap under queued cancellation, `continueOnError` mid-batch abort fill and widened-boolean fulfillment, pooled-item payload fidelity, and the `assertEncodeEnvironment`/`FileReader` error wrappings.
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
