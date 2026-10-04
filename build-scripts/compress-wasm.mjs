import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { gzipSync, brotliCompressSync, constants } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const distDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const wasmPath = path.join(distDir, 'heic-decoder.wasm');

if (!existsSync(wasmPath)) {
  console.error(
    `Error: ${wasmPath} not found.\n` +
      'The tsup build should have copied it from src/wasm/public/. If the WASM decoder\n' +
      'was never built, run `npm run build:wasm` (requires Docker) before `npm run build`.'
  );
  process.exit(1);
}

const raw = readFileSync(wasmPath);
const gz = gzipSync(raw, { level: 9 });
const br = brotliCompressSync(raw, {
  params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
});

writeFileSync(`${wasmPath}.gz`, gz);
writeFileSync(`${wasmPath}.br`, br);

// Round-trip the sidecars: a CDN with gzip_static/brotli_static serves these
// bytes, and a truncated one would break decoding only for those visitors.
const { gunzipSync, brotliDecompressSync } = await import('node:zlib');
for (const [suffix, decompress] of [
  ['.gz', gunzipSync],
  ['.br', brotliDecompressSync],
]) {
  const onDisk = readFileSync(`${wasmPath}${suffix}`);
  if (!decompress(onDisk).equals(raw)) {
    console.error(
      `Error: ${path.basename(wasmPath)}${suffix} does not decompress back to the ` +
        `${raw.length}-byte heic-decoder.wasm. Refusing to ship a corrupt precompressed artifact.`
    );
    process.exit(1);
  }
}

const kb = (n) => `${(n / 1024).toFixed(0)} KB`;
console.log(`heic-decoder.wasm: ${kb(raw.length)} | gzip: ${kb(gz.length)} | brotli: ${kb(br.length)}`);
