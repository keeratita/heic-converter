import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Guards the lazy-chunk boundaries that keep the initial bundle small. The
 * published entry must reach the Emscripten glue, the Web Worker
 * implementation, and the EXIF injectors through dynamic `import()` only — a
 * stray static import (or a worker-only helper pulled into a shared module)
 * silently moves ~8 KB back into the code every consumer pays for, and no
 * behavioural test would notice.
 *
 * Runs only when `dist/` exists: CI builds before testing, while a bare
 * `npm test` on a fresh checkout skips instead of failing on a missing build.
 *
 * Beyond the lazy boundaries it guards the published artifacts themselves: both
 * formats (ESM and CJS) must defer the same modules, every chunk a built file
 * references must exist on disk, the WASM in `dist/` must be the one in
 * `src/wasm/public/`, and the binary payload must stay under the ceilings the
 * 0.5.1 size work produced.
 */
const DIST = fileURLToPath(new URL('../../dist', import.meta.url));
const SRC_WASM = fileURLToPath(new URL('../../src/wasm/public/heic-decoder.wasm', import.meta.url));
const isBuilt = existsSync(`${DIST}/index.mjs`);

/** Minified budget for everything eagerly reachable from the entry (ESM). */
const EAGER_BUDGET_BYTES = 22_000;

/**
 * A deferred chunk must still carry its own code. When something imports a
 * deferred module statically, the bundler hoists the implementation into the
 * shared chunk and leaves a re-export stub on the dynamic edge — so the
 * "reachable via import()" check alone still passes. Asserting a floor on the
 * chunk's size catches that hoist, and the budget above catches the bytes
 * landing back on the eager path.
 */
const DEFERRED_CHUNK_MIN_BYTES = 1_000;

/** Modules that must stay behind a dynamic import. */
const DEFERRED_MODULES = ['worker', 'exif', 'heic-decoder'];

/**
 * Ceilings for the artifacts that the 0.5.1 size work produced. They are
 * deliberately loose (~15-20%) so a legitimate emsdk or libde265/libheif bump
 * does not fail the suite — they exist to catch a *flag* being dropped, not to
 * police drift. Which regression each one catches:
 *
 * - glue chunk: `-s FILESYSTEM=0` off → 68,600 raw / 22,413 gz (both tripped).
 *   The dead-libheif-embind flag alone is NOT caught here (36,141 / 12,472
 *   stays under); `npm run verify:wasm` pins the glue hash for that.
 * - wasm: an `-Oz` archive regression → ~413,850 gz, and losing libde265-only
 *   codec exclusions would blow this up too.
 * - first-decode total: any combination that re-inflates what a browser
 *   downloads before the first image appears (0.5.0 shipped 453,472 gz).
 */
const GLUE_MAX_BYTES = 40_000;
const GLUE_MAX_GZ = 14_000;
const WASM_MAX_GZ = 340_000;
const FIRST_DECODE_MAX_GZ = 380_000;

function chunkFile(prefix: string): string {
  const file = readdirSync(DIST).find((name) => name.startsWith(`${prefix}-`) && name.endsWith('.mjs'));
  if (!file) {
    throw new Error(`expected a "${prefix}" chunk in dist/ — was it inlined into the entry?`);
  }
  return file;
}

const bytesOf = (file: string): number => readFileSync(`${DIST}/${file}`).byteLength;
const gzOf = (file: string): number => gzipSync(readFileSync(`${DIST}/${file}`), { level: 9 }).length;
/** Short digest for a readable mismatch message — never deep-compare big buffers. */
const sha256Prefix = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex').slice(0, 12);

/** Files statically reachable from an entry (its own chunk graph, no dynamic edges). */
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

const ESM_DEP = /from\s*"\.\/([^"]+\.mjs)"/g;
const CJS_DEP = /require\("\.\/([^"]+\.js)"\)/g;

function eagerGraph(): Map<string, string> {
  return staticGraph('index.mjs', ESM_DEP);
}

describe.skipIf(!isBuilt)('bundle boundaries (requires npm run build)', () => {
  const entry = readFileSync(`${DIST}/index.mjs`, 'utf8');

  it.each(DEFERRED_MODULES)('defers %s behind a dynamic import', (prefix) => {
    const chunk = chunkFile(prefix);
    const graph = eagerGraph();
    // Never statically imported by the entry or anything the entry loads eagerly.
    for (const [file, source] of graph) {
      expect(new RegExp(`from\\s*"\\./${chunk}"`).test(source), `${file} statically imports ${chunk}`).toBe(false);
    }
    // Still reachable, so it has not been dropped from the bundle entirely.
    expect(entry, `${chunk} is not reachable from the entry`).toContain(`./${chunk}`);
    // And still carries its implementation rather than a hoisted re-export stub.
    const bytes = readFileSync(`${DIST}/${chunk}`).byteLength;
    expect(bytes, `${chunk} is ${bytes} bytes — its code was hoisted into the eager chunk`).toBeGreaterThan(
      DEFERRED_CHUNK_MIN_BYTES
    );
  });

  it('keeps the eagerly loaded JS within budget', () => {
    const total = [...eagerGraph().keys()].reduce((bytes, file) => bytes + bytesOf(file), 0);
    expect(total, `eager JS is ${total} bytes (budget ${EAGER_BUDGET_BYTES})`).toBeLessThan(EAGER_BUDGET_BYTES);
  });

  // The CJS half of the package is what bundlers and `require()` users load, and
  // it is emitted by a separate tsup pass — a regression can easily defer the
  // modules in one format and not the other.
  it.each(DEFERRED_MODULES)('defers %s behind a dynamic import in the CJS build too', (prefix) => {
    const chunk = readdirSync(DIST).find((n) => n.startsWith(`${prefix}-`) && n.endsWith('.js'));
    expect(chunk, `expected a "${prefix}" chunk in the CJS build`).toBeTruthy();
    const graph = staticGraph('index.js', CJS_DEP);
    for (const [file, source] of graph) {
      expect(
        new RegExp(`require\\("\\./${chunk}"\\)`).test(source),
        `${file} statically requires ${chunk}`
      ).toBe(false);
    }
    const entry = readFileSync(`${DIST}/index.js`, 'utf8');
    expect(entry, `${chunk} is not reachable from the CJS entry`).toContain(`import("./${chunk}")`);
    expect(
      bytesOf(chunk as string),
      `${chunk} is too small — its code was hoisted into the eager CJS chunk`
    ).toBeGreaterThan(DEFERRED_CHUNK_MIN_BYTES);
  });

  it('keeps the eagerly loaded CJS within budget', () => {
    const total = [...staticGraph('index.js', CJS_DEP).keys()].reduce((bytes, f) => bytes + bytesOf(f), 0);
    expect(total, `eager CJS is ${total} bytes (budget ${EAGER_BUDGET_BYTES})`).toBeLessThan(
      EAGER_BUDGET_BYTES
    );
  });

  it('publishes every chunk the built files reference', () => {
    // A chunk that is referenced but not emitted is invisible until a browser
    // 404s on it — which is precisely the failure the worker_load_failed /
    // no-EXIF fail-safe paths exist to survive. Catch it in the artifact instead.
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
    // dist/heic-decoder.wasm is a verbatim copy made by the tsup build, so a
    // mismatch means dist was built before the last `npm run build:wasm` (or
    // never rebuilt after it). That state has actually shipped a stale decoder
    // through local verification, so assert the pair instead of trusting mtimes.
    expect(existsSync(SRC_WASM), `missing ${SRC_WASM}`).toBe(true);
    const published = readFileSync(`${DIST}/heic-decoder.wasm`);
    const source = readFileSync(SRC_WASM);
    // Buffer.equals is a memcmp. Do NOT use expect(...).toEqual here: on two
    // ~800 KB Buffers it does a deep structural compare that measured ~1.1 s on
    // an idle machine and blew the 5 s test timeout under the parallel suite.
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
