import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import {
  brotliCompressSync,
  brotliDecompressSync,
  constants,
  gunzipSync,
  gzipSync
} from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const distDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const wasmPath = path.join(distDir, 'heic-decoder.wasm');

/**
 * Returns a problem message, or null when both sidecars decompress to `raw`.
 *
 * A CDN configured with gzip_static/brotli_static serves these bytes verbatim,
 * so a truncated or mis-configured sidecar breaks decoding for exactly those
 * visitors and nobody else — invisible to the browser E2E suite, which fetches
 * the raw binary. Exported so the check itself is tested, like the other
 * supply-chain gates in this directory.
 */
export function verifySidecars(raw, sidecars) {
  const cases = [
    ['gzip (.gz)', sidecars.gz, gunzipSync],
    ['brotli (.br)', sidecars.br, brotliDecompressSync]
  ];
  for (const [label, bytes, decompress] of cases) {
    let roundTrip;
    try {
      roundTrip = decompress(bytes);
    } catch (error) {
      return `${label} sidecar cannot be decompressed: ${error instanceof Error ? error.message : String(error)}`;
    }
    if (!roundTrip.equals(raw)) {
      return `${label} sidecar decompresses to ${roundTrip.length} bytes, not the ${raw.length}-byte heic-decoder.wasm`;
    }
  }
  return null;
}

// Guarded so the unit test can import verifySidecars without running a build.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
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

  const problem = verifySidecars(raw, {
    gz: readFileSync(`${wasmPath}.gz`),
    br: readFileSync(`${wasmPath}.br`)
  });
  if (problem) {
    console.error(`Error: ${problem}. Refusing to ship a corrupt precompressed artifact.`);
    process.exit(1);
  }

  const kb = (n) => `${(n / 1024).toFixed(0)} KB`;
  console.log(`heic-decoder.wasm: ${kb(raw.length)} | gzip: ${kb(gz.length)} | brotli: ${kb(br.length)}`);
}
