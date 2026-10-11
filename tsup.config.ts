import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs', 'esm'],
  // Declarations come from `tsc --emitDeclarationOnly` (see the build script),
  // not tsup's bundled rollup-plugin-dts: tsup 8.5.1 hard-codes
  // `baseUrl: compilerOptions.baseUrl || '.'` into the DTS program
  // (dist/rollup.js), which TS 6 rejects as a hard TS5101 deprecation error,
  // and the option is unremovable through tsup's config surface. The repo's
  // own tsconfigs use no deprecated options, so emitting from tsc is
  // deprecation-free without any `ignoreDeprecations` silencing. Revisit if
  // tsup ever drops the injected baseUrl.
  dts: false,
  clean: true,
  // Copies src/wasm/public/* (the decoder binary) into dist/ as a static
  // asset so it can be served next to the bundle.
  publicDir: 'src/wasm/public',
  // Terser (rather than the esbuild default) gets a few percent further off the
  // minified JS — most visibly on the Emscripten glue chunk, which dominates
  // the lazy-loaded side of the bundle. `mangle.eval` is terser's switch for
  // mangling names in the outermost function scope, unrelated to `eval()` (the
  // CSP guarantee comes from `-s DYNAMIC_EXECUTION=0` in the WASM build); it is
  // pinned off explicitly so nobody flips it believing the two are connected.
  minify: 'terser',
  terserOptions: { compress: { passes: 3 }, mangle: { eval: false } },
  treeshake: true,
  // Emit the lazily-imported modules (Emscripten glue, Web Worker
  // implementation, EXIF injectors) as separate chunks so the entry plus its
  // eagerly-loaded shared chunk stay small and each deferred module is fetched
  // only when its path is first used. Byte budgets live in
  // test/unit/bundle.test.ts, which fails the build when a boundary moves.
  splitting: true,
  // The WASM binary is referenced by URL at runtime (locateFile/wasmBinary),
  // never inlined into the JS bundle.
  external: ['heic-decoder.wasm'],
  // Separate-file sourcemaps; disabled to keep the published bundle minimal.
  sourcemap: false,
});
