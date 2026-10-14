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
// Same rule as the other real-artifact suites (AGENTS.md): on CI these guards
// must never skip green — a tsup regression that stops emitting the entry while
// still copying publicDir would otherwise delete every guard in this file.
const isCI = !!process.env.CI;

// 23_500 (from 23_000): the native-chunk degradation breadcrumb and the
// fallback error-class discrimination are entry-thread logic — they decide what
// the lazy chunks get asked to do and cannot be deferred. ESM (what browsers
// load) is ~21.6 K; the CJS interop helpers pushed the CJS pass over the old
// ceiling.
const EAGER_BUDGET_BYTES = 23_500;
/** A hoisted implementation leaves a re-export stub on the dynamic edge, so the import() check alone passes. */
const DEFERRED_CHUNK_MIN_BYTES = 1_000;
/** Prefix → floor. The native Strategy is ~1.6 KB raw; a hoist stub is <200 B. */
const DEFERRED_MODULES: Array<{ prefix: string; min: number }> = [
  { prefix: 'worker', min: DEFERRED_CHUNK_MIN_BYTES },
  { prefix: 'exif', min: DEFERRED_CHUNK_MIN_BYTES },
  { prefix: 'heic-decoder', min: DEFERRED_CHUNK_MIN_BYTES },
  { prefix: 'native', min: 600 },
];

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

// `\.m?js` on purpose: a bundler-output-helper change that emits an ESM chunk
// as .js (or a cross-extension static edge) must not slip past the boundary
// check and the byte budget.
const ESM_DEP = /from\s*"\.\/([^"]+\.m?js)"/g;
const CJS_DEP = /require\("\.\/([^"]+\.m?js)"\)/g;

/**
 * Static text in src/messages/worker.ts, extracted from source so the guard
 * covers entries added later. `Messages` is one object literal that esbuild
 * cannot tree-shake per property, so a worker-only string reaching the eager
 * graph is a silent size regression — and `messages.test.ts` compares key names,
 * which cannot see where the text ends up.
 */
function workerOnlyMessageFragments(): string[] {
  const source = readFileSync(fileURLToPath(new URL('../../src/messages/worker.ts', import.meta.url)), 'utf8');
  const literals = [
    ...[...source.matchAll(/'((?:[^'\\\n]|\\.){20,})'/g)].map(([, text]) => text),
    // Template literals: keep only the static pieces around `${...}` holes.
    ...[...source.matchAll(/`([^`\n]{20,})`/g)].flatMap(([, text]) => text.split(/\$\{[^}]*\}/))
  ];
  return literals.map((text) => text.replace(/\\'/g, "'")).filter((text) => text.length >= 20 && !text.includes('\\'));
}

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

describe.skipIf(!isBuilt && !isCI)('bundle boundaries (requires npm run build)', () => {
  // Read inside the tests: vitest runs describe callbacks even when the suite is
  // skipped, so a read here would fail a fresh checkout instead of skipping.
  const entrySource = (): string => readFileSync(`${DIST}/index.mjs`, 'utf8');

  // ESM and CJS are separate tsup passes: each is checked so one cannot regress
  // while the other stays deferred.
  it.each(DEFERRED_MODULES)('defers $prefix behind a dynamic import', ({ prefix, min }) => {
    const chunk = chunkFile(prefix);
    for (const [file, source] of eagerGraph()) {
      expect(new RegExp(`from\\s*"\\./${chunk}"`).test(source), `${file} statically imports ${chunk}`).toBe(false);
    }
    expect(entrySource(), `${chunk} is not reachable from the entry`).toContain(`./${chunk}`);
    const bytes = bytesOf(chunk);
    expect(bytes, `${chunk} is ${bytes} bytes — its code was hoisted into the eager chunk`).toBeGreaterThan(min);
  });

  it('keeps worker-only error text out of the eagerly loaded graph', () => {
    const fragments = workerOnlyMessageFragments();
    expect(fragments.length, 'no worker message text found to guard').toBeGreaterThan(4);
    const eager = [...eagerGraph().values(), ...staticGraph('index.js', CJS_DEP).values()].join('\n');
    const leaked = fragments.filter((fragment) => eager.includes(fragment));
    expect(
      leaked.map((fragment) => `"${fragment.slice(0, 48)}…"`),
      'worker-only message text reached the eager chunks — move the throwing validator into src/worker.ts'
    ).toEqual([]);
  });

  it('keeps the eagerly loaded JS within budget', () => {
    const total = [...eagerGraph().keys()].reduce((bytes, file) => bytes + bytesOf(file), 0);
    expect(
      total,
      `eager JS is ${total} bytes (budget ${EAGER_BUDGET_BYTES}). Every byte here is paid by every ` +
        'consumer before the first decode: prefer a dynamic import (see the three deferred modules) or a ' +
        'shorter message. If the growth is deliberate, raise the budget here and say why in the commit.'
    ).toBeLessThan(EAGER_BUDGET_BYTES);
  });

  it.each(DEFERRED_MODULES)('defers $prefix behind a dynamic import in the CJS build too', ({ prefix, min }) => {
    const chunk = chunkFile(prefix, '.js');
    for (const [file, source] of staticGraph('index.js', CJS_DEP)) {
      expect(
        new RegExp(`require\\("\\./${chunk}"\\)`).test(source),
        `${file} statically requires ${chunk}`
      ).toBe(false);
    }
    const cjsEntry = readFileSync(`${DIST}/index.js`, 'utf8');
    // Presence, not exact syntax: esbuild's CJS `import()` helper form is an
    // implementation detail, and deferral is already proven by the require-walk
    // above (a static edge would have made this graph include the chunk).
    expect(cjsEntry, `${chunk} is not reachable from the CJS entry`).toContain(`./${chunk}`);
    const bytes = bytesOf(chunk);
    expect(bytes, `${chunk} is ${bytes} bytes — its code was hoisted into the eager CJS chunk`).toBeGreaterThan(min);
  });

  it('keeps the eagerly loaded CJS within budget', () => {
    const total = [...staticGraph('index.js', CJS_DEP).keys()].reduce((bytes, f) => bytes + bytesOf(f), 0);
    expect(
      total,
      `eager CJS is ${total} bytes (budget ${EAGER_BUDGET_BYTES}). The CJS pass carries interop helpers ` +
        'and is not byte-reproducible across builds (±30 B), so this is usually the first to trip; prefer a ' +
        'dynamic import or a shorter message. If the growth is deliberate, raise the budget and say why.'
    ).toBeLessThan(EAGER_BUDGET_BYTES);
  });

  it('keeps the lazy chunks from statically sharing code outside the eager graph', () => {
    // The four lazy payloads defer independently. A static edge from one to
    // another (the worker chunk requiring the EXIF injectors, say) collapses
    // two independent deferrals: the first worker call downloads EXIF too.
    // esbuild usually honours such an edge by hoisting the imported code into
    // a shared `chunk-*` file the importer requires — and that file is named
    // by content hash, not the `exif-`/`worker-` prefix, so a prefix filter
    // misses it (this was a real hole). The robust check: two lazy chunks may
    // share a file ONLY when the eager entry graph also uses it statically
    // (both legitimately reuse entry code). A file reachable from two distinct
    // lazy chunks but NOT from the entry is lazy-to-lazy static coupling.
    for (const [ext, depPattern] of [
      ['.mjs', ESM_DEP],
      ['.js', CJS_DEP],
    ] as const) {
      const eager = new Set(staticGraph(`index${ext}`, depPattern).keys());
      const graphs = DEFERRED_MODULES.map(({ prefix }) => ({
        prefix,
        files: new Set(staticGraph(chunkFile(prefix, ext), new RegExp(depPattern.source, 'g')).keys()),
      }));
      for (let i = 0; i < graphs.length; i++) {
        for (let j = i + 1; j < graphs.length; j++) {
          // A chunk's own entry file appears in its own graph; it can only
          // appear in ANOTHER lazy chunk's graph through the leak itself — so
          // no exclusion is needed, and adding one would mask the direct edge.
          const shared = [...graphs[i].files].filter((f) => graphs[j].files.has(f) && !eager.has(f));
          expect(
            shared,
            `${graphs[i].prefix} and ${graphs[j].prefix} (${ext}) statically share code not in the eager graph: ${shared.join(', ')}`
          ).toEqual([]);
        }
      }
    }
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
