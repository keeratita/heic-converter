import { existsSync, readFileSync, readdirSync } from 'node:fs';
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
 */
const DIST = fileURLToPath(new URL('../../dist', import.meta.url));
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

function chunkFile(prefix: string): string {
  const file = readdirSync(DIST).find((name) => name.startsWith(`${prefix}-`) && name.endsWith('.mjs'));
  if (!file) {
    throw new Error(`expected a "${prefix}" chunk in dist/ — was it inlined into the entry?`);
  }
  return file;
}

/** Files statically reachable from the entry (its own chunk graph, no dynamic edges). */
function eagerGraph(): Map<string, string> {
  const seen = new Map<string, string>();
  const queue = ['index.mjs'];
  while (queue.length > 0) {
    const file = queue.shift() as string;
    if (seen.has(file)) {
      continue;
    }
    const source = readFileSync(`${DIST}/${file}`, 'utf8');
    seen.set(file, source);
    for (const [, dep] of source.matchAll(/from\s*"\.\/([^"]+\.mjs)"/g)) {
      queue.push(dep);
    }
  }
  return seen;
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
    const total = [...eagerGraph().keys()].reduce(
      (bytes, file) => bytes + readFileSync(`${DIST}/${file}`).byteLength,
      0
    );
    expect(total, `eager JS is ${total} bytes (budget ${EAGER_BUDGET_BYTES})`).toBeLessThan(EAGER_BUDGET_BYTES);
  });
});
