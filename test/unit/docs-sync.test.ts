import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The worker script lives in four places: the runnable canonical file
 * (docs/worker.js — served by both the GitHub Pages demo and the sandbox E2E
 * via the /worker.js route) and three illustrative copies (README.md, API.md,
 * and the JSDoc example on convertHeicInWorker in src/index.ts). They were
 * once five copies with three divergent bodies. Every example body must be
 * byte-equal to the canonical one, modulo two documented decorations:
 *
 *   - the import specifier (docs/worker.js imports the built entry by
 *     relative path so it runs from /worker.js on Pages; examples import the
 *     package name as a consumer would),
 *   - the JSDoc ' * ' gutter in src/index.ts.
 *
 * Editing any copy means editing all four — this test fails otherwise.
 */

const ROOT = new URL('../..', import.meta.url);
const CANONICAL_SPECIFIER = "from './dist/index.mjs'";
const EXAMPLE_SPECIFIER = "from '@keeratita/heic-converter'";

/**
 * Extract the protocol body: the import statement through the final `};`,
 * JSDoc gutter stripped, canonical specifier normalized to the package name.
 */
function protocolBody(source: string): string {
  const lines = source.split('\n');
  const start = lines.findIndex((line) => line.replace(/^ \* ?/, '').startsWith('import { convertHeic }'));
  if (start === -1) {
    throw new Error('no `import { convertHeic }` line found');
  }
  let end = -1;
  for (let i = lines.length - 1; i >= start; i--) {
    if (lines[i].replace(/^ \* ?/, '').trimEnd() === '};') {
      end = i;
      break;
    }
  }
  if (end === -1) {
    throw new Error('no terminating `};` found');
  }
  // Nothing executable may follow the `};` inside the compared scope — else a
  // copy could append `self.close();` (the contract API.md forbids) after the
  // body and the byte-equal check would never see it.
  const trailing = lines
    .slice(end + 1)
    .map((line) => line.replace(/^ \* ?/, '').trim())
    .filter((line) => line.length > 0);
  expect(trailing, 'unexpected content after the final `};` of the worker example').toEqual([]);
  return lines
    .slice(start, end + 1)
    .map((line) => line.replace(/^ \* ?/, ''))
    .join('\n')
    .replace(CANONICAL_SPECIFIER, EXAMPLE_SPECIFIER)
    .trim();
}

/** The js fence whose body implements the worker protocol. */
function fencedWorkerFence(text: string): string {
  for (const match of text.matchAll(/```js\n([\s\S]*?)```/g)) {
    if (match[1].includes('self.onmessage')) {
      expect(match[1], 'worker example must carry the // converter.worker.js title').toContain(
        '// converter.worker.js'
      );
      return match[1];
    }
  }
  throw new Error('no js fence implementing the worker protocol');
}

const canonical = readFileSync(new URL('docs/worker.js', ROOT), 'utf8');
const readme = readFileSync(new URL('README.md', ROOT), 'utf8');
const api = readFileSync(new URL('API.md', ROOT), 'utf8');
const entry = readFileSync(new URL('src/index.ts', ROOT), 'utf8');

describe('worker-script canonicalization', () => {
  // Lazy: evaluating protocolBody(canonical) at describe scope would run its
  // trailing-content assertion during collection — a canonical-file violation
  // then reports as a file-level "no tests" failure instead of naming a test.
  const canonicalBody = () => protocolBody(canonical);

  it('documents the canonical file as the reference in API.md', () => {
    expect(api).toContain('docs/worker.js');
  });

  it('README example is byte-equal to docs/worker.js', () => {
    expect(protocolBody(fencedWorkerFence(readme))).toBe(canonicalBody());
  });

  it('API.md example is byte-equal to docs/worker.js', () => {
    expect(protocolBody(fencedWorkerFence(api))).toBe(canonicalBody());
  });

  it('JSDoc example is byte-equal to docs/worker.js', () => {
    expect(protocolBody(fencedWorkerFence(entry))).toBe(canonicalBody());
  });

  it('canonical file keeps the documented worker contract', () => {
    // The contract API.md warns about must hold in the runnable code (the
    // header comment legitimately mentions self.close as a don't). Assert the
    // three concrete reply sites carry the request id — `toContain('id')` would
    // be satisfied by "width"/"invalid" and prove nothing.
    const body = canonicalBody();
    expect(body).toContain("self.postMessage({ id, type: 'progress', percent })");
    expect(body).toContain("{ id, type: 'result', ok: true, blob }");
    expect(body).toContain("{ id, type: 'result', ok: false,");
    expect(body).not.toContain('self.close');
  });
});
