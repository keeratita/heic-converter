# Security Policy

## Supported versions

| Version | Supported          |
| ------- | ------------------ |
| 0.5.x   | :white_check_mark: |
| < 0.5   | :x:                |

The package is pre-1.0, so only the latest minor release receives patches. Patch releases are published as soon as a fix is validated.

## Reporting a vulnerability

**Please do not open a public issue.** Use one of:

- **GitHub private vulnerability reporting** — _Security_ tab → _Report a vulnerability_ on [github.com/keeratita/heic-converter](https://github.com/keeratita/heic-converter).
- **Email** — keerati.tansawatcharoen@gmail.com (encrypt with the GitHub-linked key if you prefer).

You should get an acknowledgement within 3 business days and a fix timeline within 7. We will credit reporters unless you prefer not to be named.

## What counts as a vulnerability here

The decoder parses **attacker-supplied `.heic`/`.heif` files**, so anything that lets a crafted image do more than return an error is in scope:

- Memory-safety or control-flow issues reachable through the WASM build of **libheif 1.23.5** / **libde265 1.1.3** (a malformed container, tile grid, property box, or EXIF block causing an out-of-bounds read/write, unbounded allocation, or module abort).
- A `WebAssembly.RuntimeError` / `Aborted(...)` escaping as an uncaught error instead of a typed `HeicConverterError`, or bad input leaving a decoder instance usable again afterwards — each conversion gets its own instance, and one whose module faulted is discarded rather than returned to the pool.
- Unvalidated options reaching the canvas/encoder path (`resize`, `crop`, `quality`) in a way that blocks the event loop or exhausts memory beyond the documented limits.
- EXIF re-injection (`preserveExif`) writing bytes outside the segment/chunk it claims to insert, or leaking a block into a format that should not carry it.
- Any path that reintroduces `eval()` / `new Function()` and therefore breaks the CSP guarantee the package exists to provide.

## Out of scope

- Reports that a scanner labels the package for the **generated Emscripten glue** loading `heic-decoder.wasm` over the network, for the SVG XML namespace literal, or for minified output. These are the three signals documented under _Scanner signals you will see_ in the [README](README.md#scanner-signals-you-will-see); if you think one of them is actually exploitable rather than just noisy, tell us what the attack is.
- Vulnerabilities in a consumer's own code, bundler, or CDN configuration.
- Extraction of metadata that the caller explicitly asked for with `preserveExif: true`. Note that EXIF is **off by default** precisely because it can carry GPS coordinates.

## Hardening already in place

| Control | Where |
| ------- | ----- |
| No `eval` / `new Function` in the decoder (`-s DYNAMIC_EXECUTION=0`) | `build-scripts/build-wasm.sh`, enforced by `npm run verify:wasm` |
| Committed glue + WASM pinned to SHA-256, and scanned for dynamic execution | `build-scripts/wasm-artifacts.json` |
| Zero runtime dependencies | `package.json` (no `dependencies`) |
| Dev-tree install scripts allowlisted (`esbuild` links its platform binary; `fsevents` is a macOS-only native addon) | `npm run check:scripts`, `build-scripts/install-scripts.json` |
| Malformed input returns typed errors, never a module abort (truncated, emptied and corrupted bitstream cases in `test/unit/decoder.test.ts` and `integration.test.ts`) | `test/unit/` |
| SLSA provenance from OIDC trusted publishing, verified after publish | `.github/workflows/publish.yml`, `npm run verify:provenance` |
| Real-browser conversion tests under a strict CSP header | `test/browser/`, `npm run test:e2e` |
