import { readFileSync, writeFileSync } from 'node:fs';
import { gzipSync, brotliCompressSync, constants } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const distDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const wasmPath = path.join(distDir, 'heic-decoder.wasm');

const raw = readFileSync(wasmPath);
const gz = gzipSync(raw, { level: 9 });
const br = brotliCompressSync(raw, {
  params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
});

writeFileSync(`${wasmPath}.gz`, gz);
writeFileSync(`${wasmPath}.br`, br);

const kb = (n) => `${(n / 1024).toFixed(0)} KB`;
console.log(`heic-decoder.wasm: ${kb(raw.length)} | gzip: ${kb(gz.length)} | brotli: ${kb(br.length)}`);
