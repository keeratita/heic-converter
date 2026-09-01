# WASM Dependencies

The WASM decoder is built from the following upstream libraries, cross-compiled to WebAssembly with Emscripten inside Docker (see `build-scripts/build-wasm.sh`):

| Library | Version | Repository |
| --- | --- | --- |
| libheif | 1.23.2 | https://github.com/strukturag/libheif |
| libde265 | 1.1.1 | https://github.com/strukturag/libde265 |

## Updating

Versions are pinned in `build-scripts/build-wasm.sh` via the `LIBHEIF_VERSION` and `LIBDE265_VERSION` variables. Bumping them re-downloads the sources and rebuilds automatically (version markers are stored in `build-wasm/src/<lib>/.version`).

After a bump, rebuild with:

```bash
npm run build:wasm
```

## Licenses

Both libraries are distributed under the terms of the GNU Lesser General Public License (LGPL).
