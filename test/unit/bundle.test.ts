import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Guards the lazy-chunk boundaries that keep the initial bundle small, plus the
 * published artifacts: both formats must defer the same modules, every
 * referenced chunk must exist on disk, dist's WASM must match src/wasm/public,
 * and the binary payload must stay under its ceilings. Skips when dist/ is
 * absent, so a bare `npm test` on a fresh checkout is unaffected; CI builds first.
 */
const DIST = fileURLToPath(new URL('../../dist', import.meta.url));
const SRC_WASM = fileURLToPath(new URL('../../src/wasm/public/heic-decoder.wasm', import.meta.url));
const isBuilt = existsSync(`${DIST}/index.mjs`);

const EAGER_BUDGET_BYTES = 22_000;
/** A hoisted implementation leaves a re-export stub on the dynamic edge, so the import() check alone passes. */
const DEFERRED_CHUNK_MIN_BYTES = 1_000;
const DEFERRED_MODULES = ['worker', 'exif', 'heic-decoder'];

// Deliberately loose (~15-20%): these catch a dropped build flag, not version
// drift. Losing -s FILESYSTEM=0 trips the glue ceilings; losing the -Oz archives
// or the codec exclusions trips the WASM one.
const GLUE_MAX_BYTES = 40_000;
const GLUE_MAX_GZ = 14_000;
const WASM_MAX_GZ = 340_000;
const FIRST_DECODE_MAX_GZ = 380_000;

function chunkFile(prefix: string, ext = '.mjs'): string {
  const file = readdirSync(DIST).find((name) => name.startsWith(`${prefix}-`) && name.endsWith(ext));
  if (!file) {
    throw new Error(`expected a "${prefix}" chunk in dist/ — was it inlined into the entry?`);
  }
  return file;
}

const bytesOf = (file: string): number => readFileSync(`${DIST}/${file}`).byteLength;
const gzOf = (file: string): number => gzipSync(readFileSync(`${DIST}/${file}`), { level: 9 }).length;
const sha256Prefix = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex').slice(0, 12);

const ESM_DEP = /from\s*"\.\/([^"]+\.mjs)"/g;
const CJS_DEP = /require\("\.\/([^"]+\.js)"\)/g;

/** Files statically reachable from an entry — its chunk graph, dynamic edges excluded. */
function staticGraph(entry: string, depPattern: RegExp): Map<string, string> {
  const seen = new Map<string, string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift() as string;
    if (seen.has(file) || !existsSync(`${DIST}/${file}`)) {
      continue;
    }
    const source = readFileSync(`${DIST}/${file}`, 'utf8');
    seen.set(file, source);
    for (const [, dep] of source.matchAll(depPattern)) {
      queue.push(dep);
    }
  }
  return seen;
}

const eagerGraph = (): Map<string, string> => staticGraph('index.mjs', ESM_DEP);

describe.skipIf(!isBuilt)('bundle boundaries (requires npm run build)', () => {
  const entry = readFileSync(`${DIST}/index.mjs`, 'utf8');

  // ESM and CJS are separate tsup passes: each is checked so one cannot regress
  // while the other stays deferred.
  it.each(DEFERRED_MODULES)('defers %s behind a dynamic import', (prefix) => {
    const chunk = chunkFile(prefix);
    for (const [file, source] of eagerGraph()) {
      expect(new RegExp(`from\\s*"\\./${chunk}"`).test(source), `${file} statically imports ${chunk}`).toBe(false);
    }
    expect(entry, `${chunk} is not reachable from the entry`).toContain(`./${chunk}`);
    const bytes = bytesOf(chunk);
    expect(bytes, `${chunk} is ${bytes} bytes — its code was hoisted into the eager chunk`).toBeGreaterThan(
      DEFERRED_CHUNK_MIN_BYTES
    );
  });

  it('keeps the eagerly loaded JS within budget', () => {
    const total = [...eagerGraph().keys()].reduce((bytes, file) => bytes + bytesOf(file), 0);
    expect(total, `eager JS is ${total} bytes (budget ${EAGER_BUDGET_BYTES})`).toBeLessThan(EAGER_BUDGET_BYTES);
  });

  it.each(DEFERRED_MODULES)('defers %s behind a dynamic import in the CJS build too', (prefix) => {
    const chunk = chunkFile(prefix, '.js');
    for (const [file, source] of staticGraph('index.js', CJS_DEP)) {
      expect(
        new RegExp(`require\\("\\./${chunk}"\\)`).test(source),
        `${file} statically requires ${chunk}`
      ).toBe(false);
    }
    const cjsEntry = readFileSync(`${DIST}/index.js`, 'utf8');
    expect(cjsEntry, `${chunk} is not reachable from the CJS entry`).toContain(`import("./${chunk}")`);
    const bytes = bytesOf(chunk);
    expect(bytes, `${chunk} is ${bytes} bytes — its code was hoisted into the eager CJS chunk`).toBeGreaterThan(
      DEFERRED_CHUNK_MIN_BYTES
    );
  });

  it('keeps the eagerly loaded CJS within budget', () => {
    const total = [...staticGraph('index.js', CJS_DEP).keys()].reduce((bytes, f) => bytes + bytesOf(f), 0);
    expect(total, `eager CJS is ${total} bytes (budget ${EAGER_BUDGET_BYTES})`).toBeLessThan(EAGER_BUDGET_BYTES);
  });

  it('publishes every chunk the built files reference', () => {
    // A dangling reference is invisible until a browser 404s on it.
    const missing: string[] = [];
    for (const file of readdirSync(DIST).filter((n) => n.endsWith('.mjs') || n.endsWith('.js'))) {
      const source = readFileSync(`${DIST}/${file}`, 'utf8');
      const refs = [
        ...source.matchAll(/from\s*"\.\/([^"]+\.m?js)"/g),
        ...source.matchAll(/import\("\.\/([^"]+\.m?js)"\)/g),
        ...source.matchAll(/require\("\.\/([^"]+\.m?js)"\)/g),
      ];
      for (const [, dep] of refs) {
        if (!existsSync(`${DIST}/${dep}`)) {
          missing.push(`${file} -> ./${dep}`);
        }
      }
    }
    expect(missing, 'dangling chunk references').toEqual([]);
  });

  it('ships the WASM that src/wasm/public currently holds', () => {
    // tsup copies the binary verbatim, so a mismatch means dist/ predates the
    // last `npm run build:wasm` — a stale dist has shipped a wrong decoder past
    // local verification before.
    expect(existsSync(SRC_WASM), `missing ${SRC_WASM}`).toBe(true);
    const published = readFileSync(`${DIST}/heic-decoder.wasm`);
    const source = readFileSync(SRC_WASM);
    // equals() is memcmp; toEqual on ~800 KB Buffers deep-compares and timed out.
    if (!published.equals(source)) {
      throw new Error(
        `dist/heic-decoder.wasm (${published.length} B, ${sha256Prefix(published)}) differs from ` +
          `src/wasm/public/heic-decoder.wasm (${source.length} B, ${sha256Prefix(source)}) — ` +
          'dist/ is stale, run `npm run build`'
      );
    }
  });

  it('keeps the binary payload within its size ceilings', () => {
    const glue = chunkFile('heic-decoder');
    expect(bytesOf(glue), `glue chunk is ${bytesOf(glue)} raw`).toBeLessThan(GLUE_MAX_BYTES);
    expect(gzOf(glue), `glue chunk is ${gzOf(glue)} gz`).toBeLessThan(GLUE_MAX_GZ);
    expect(gzOf('heic-decoder.wasm'), 'wasm gzipped').toBeLessThan(WASM_MAX_GZ);

    const firstDecode =
      [...eagerGraph().keys()].reduce((n, f) => n + gzOf(f), 0) + gzOf(glue) + gzOf('heic-decoder.wasm');
    expect(
      firstDecode,
      `first-decode payload is ${firstDecode} gz (budget ${FIRST_DECODE_MAX_GZ})`
    ).toBeLessThan(FIRST_DECODE_MAX_GZ);
  });
});
