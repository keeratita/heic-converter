import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['cjs', 'esm'],
  dts: true,
  clean: true,
  publicDir: 'src/wasm/public', // We will place the compiled wasm here so it gets copied to dist
});
