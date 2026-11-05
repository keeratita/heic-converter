# WASM Dependencies

The WASM decoder is built from the following upstream libraries, cross-compiled to WebAssembly with Emscripten inside Docker (see `build-scripts/build-wasm.sh`):

| Library | Version | Repository |
| --- | --- | --- |
| libheif | 1.23.7 | https://github.com/strukturag/libheif |
| libde265 | 1.1.3 | https://github.com/strukturag/libde265 |

Both libraries are checked out as **git submodules** under `build-wasm/src/`, pinned to their release tags:

- `build-wasm/src/libheif` → `v1.23.7`
- `build-wasm/src/libde265` → `v1.1.3`

## Updating

1. Bump the `LIBHEIF_VERSION` / `LIBDE265_VERSION` variables in `build-scripts/build-wasm.sh`.
2. Check out the new tag in the submodule:

   ```bash
   cd build-wasm/src/libheif && git checkout vX.Y.Z
   cd build-wasm/src/libde265 && git checkout vX.Y.Z
   ```

3. Rebuild, then re-pin the artifacts:

   ```bash
   npm run build:wasm
   npm run wasm:hashes   # regenerates build-scripts/wasm-artifacts.json — must be committed
   npm run build         # refresh dist/ before the goldens read it
   npm run wasm:goldens -- --write   # regenerates the MUTATION_GOLDENS block in test/unit/wasm-golden.test.ts
   ```

   The build replaces **both** generated files (`src/wasm/public/heic-decoder.wasm` and
   `src/wasm/wrapper/heic-decoder.js`) from one `emcc` invocation, so always commit the pair
   together. Without `wasm:hashes`, `npm run verify:wasm` — and therefore CI — fails on the
   hash mismatch.

`build-wasm.sh` verifies the submodule checkout matches the pinned version and fails with a hint if they drift. The submodule commit itself is the version marker — there are no separate marker files.

## Build-time patches

Every `npm run build:wasm` resets the libheif submodule (`git submodule update --force`) and applies three deterministic transformations before compiling — this is what makes the CI `wasm-provenance` from-scratch rebuild byte-match the committed hashes:

1. **Progress hooks** (`build-scripts/patch-libheif.py`) — adds start/on/end progress callbacks to libheif < 1.21; no-op on the pinned 1.23.7.
2. **Diagnostic neutralization** (`build-scripts/neutralize-libheif-diagnostics.py`) — stubs the debug-only printers (`dump` / `dump_children` / `dump_to_string` / `get_debug_info` / `get_debug_message` / `debug_dump*`) and drops the one live `std::cerr`. They are virtual (vtable-pinned) and their bodies are what pull libc++ iostream+locale into the module (~118 KB raw on 1.23.7); the decode path never calls them.
3. **`<sstream>` shim** (`build-scripts/libheif-no-streams.h`, `-include`d into every libheif TU) — replaces `std::(o|i)stringstream` with a non-logging fake. Error codes and control flow survive; streamed detail text becomes empty (already untrusted: `sanitizeDecoderDetail()` strips control chars and clamps it before `error.message`).

The guards fail **closed**: the neutralizer asserts a `box.cc` stub and a ≥100-stub floor (pinned by `test/unit/libheif-diagnostics.test.ts`), and `build-wasm.sh` aborts when the linker map shows libc++ stream members (`iostream`/`ostream`/`strstream`). Decoded output is pinned byte-exact by `test/unit/wasm-golden.test.ts` and the browser E2E.

## Cloning

Submodules are not fetched by a plain `git clone`. Use:

```bash
git clone --recurse-submodules <repo-url>
# or, for an existing checkout:
git submodule update --init --recursive
```

## Licenses

Both libraries are distributed under the terms of the GNU Lesser General Public License (LGPL).
