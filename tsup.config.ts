import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  clean: true,
  // Copies src/wasm/public/* (the decoder binary) into dist/ as a static
  // asset so it can be served next to the bundle.
  publicDir: 'src/wasm/public',
  minify: true,
  treeshake: true,
  // Emit the dynamically-imported Emscripten glue as a separate chunk so the
  // main entry stays small (~9 KB) and the glue is only fetched on first decode.
  splitting: true,
  // The WASM binary is referenced by URL at runtime (locateFile/wasmBinary),
  // never inlined into the JS bundle.
  external: ['heic-decoder.wasm'],
  // Separate-file sourcemaps; disabled to keep the published bundle minimal.
  sourcemap: false,
});
