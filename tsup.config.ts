import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  clean: true,
  // Copies src/wasm/public/* (the decoder binary) into dist/ as a static
  // asset so it can be served next to the bundle.
  publicDir: 'src/wasm/public',
  // Terser (rather than the esbuild default) gets a few percent further off the
  // minified JS — most visibly on the Emscripten glue chunk, which dominates
  // the lazy-loaded side of the bundle.
  minify: 'terser',
  terserOptions: { compress: { passes: 3 }, mangle: { eval: false } },
  treeshake: true,
  // Emit the lazily-imported modules (Emscripten glue, Web Worker
  // implementation, EXIF injectors) as separate chunks so the entry plus its
  // eagerly-loaded shared chunk stay small (~19.5 KB raw / ~7.2 KB gzipped) and
  // each deferred module is fetched only when its path is first used. See
  // test/unit/bundle.test.ts for the boundary this must preserve.
  splitting: true,
  // The WASM binary is referenced by URL at runtime (locateFile/wasmBinary),
  // never inlined into the JS bundle.
  external: ['heic-decoder.wasm'],
  // Separate-file sourcemaps; disabled to keep the published bundle minimal.
  sourcemap: false,
});
