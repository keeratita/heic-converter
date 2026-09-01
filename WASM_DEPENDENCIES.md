# WASM Dependencies

The WASM decoder is built from the following upstream libraries, cross-compiled to WebAssembly with Emscripten inside Docker (see `build-scripts/build-wasm.sh`):

| Library | Version | Repository |
| --- | --- | --- |
| libheif | 1.23.2 | https://github.com/strukturag/libheif |
| libde265 | 1.1.1 | https://github.com/strukturag/libde265 |

Both libraries are checked out as **git submodules** under `build-wasm/src/`, pinned to their release tags:

- `build-wasm/src/libheif` → `v1.23.2`
- `build-wasm/src/libde265` → `v1.1.1`

## Updating

1. Bump the `LIBHEIF_VERSION` / `LIBDE265_VERSION` variables in `build-scripts/build-wasm.sh`.
2. Check out the new tag in the submodule:

   ```bash
   cd build-wasm/src/libheif && git checkout vX.Y.Z
   cd build-wasm/src/libde265 && git checkout vX.Y.Z
   ```

3. Rebuild:

   ```bash
   npm run build:wasm
   ```

`build-wasm.sh` verifies the submodule checkout matches the pinned version and fails with a hint if they drift. The submodule commit itself is the version marker — there are no separate marker files.

## Cloning

Submodules are not fetched by a plain `git clone`. Use:

```bash
git clone --recurse-submodules <repo-url>
# or, for an existing checkout:
git submodule update --init --recursive
```

## Licenses

Both libraries are distributed under the terms of the GNU Lesser General Public License (LGPL).
