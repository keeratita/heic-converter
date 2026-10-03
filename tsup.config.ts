import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  clean: true,
  publicDir: 'src/wasm/public',
  // Optimization settings for smaller bundle size
  minify: true,
  treeshake: true,
  // Emit the dynamically-imported Emscripten glue as a separate chunk so the
  // main entry stays small and the glue is only fetched on first decode.
  splitting: true,
  // Exclude large WASM from main bundle
  external: ['heic-decoder.wasm'],
  // Add sourcemaps for debugging (separate file)
  sourcemap: false,
  // Reduce bundle size by removing comments
  banner: {},
  footer: {},
});