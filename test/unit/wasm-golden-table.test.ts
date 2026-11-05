import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  buildMutations,
  diffTable,
  outcomeOf,
  parseTable,
  renderTable
} from '../../build-scripts/wasm-golden-table.mjs';

/**
 * The golden-table generator and the CLI that rewrites `MUTATION_GOLDENS`
 * share these functions, so the asserted table is produced by code under test
 * rather than an untested script (same arrangement as `compress-wasm.test.ts`
 * and `install-scripts.test.ts`).
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const GOLDEN_TEST = path.join(__dirname, 'wasm-golden.test.ts');
const TABLE_START = 'const MUTATION_GOLDENS: Record<string, string> = {';
const FIXTURE_NAMES = ['example.heic', 'colors-with-alpha.heic', 'exif-orientation-6.heic'];

/** Synthetic fixtures: the generator only slices, copies, and flips one bit. */
function fakeFixtures(): Map<string, Uint8Array> {
  const sizes: Record<string, number> = { 'example.heic': 200, 'colors-with-alpha.heic': 400, 'exif-orientation-6.heic': 600 };
  const files = new Map<string, Uint8Array>();
  for (const [name, size] of Object.entries(sizes)) {
    files.set(
      name,
      Uint8Array.from({ length: size }, (_, i) => (i * 31 + 7) & 0xff)
    );
  }
  return files;
}

function mutate(readFile: (name: string) => Uint8Array): Array<[string, Uint8Array]> {
  return buildMutations(readFile);
}

describe('buildMutations', () => {
  it('emits the documented label set, deterministically', () => {
    const files = fakeFixtures();
    const first = mutate((name) => files.get(name) as Uint8Array);
    const labels = first.map(([label]) => label);

    // 3 fixtures x (full + 4 truncations + empty + garbage + headeronly + 14
    // flips) = 66.
    expect(labels).toHaveLength(66);
    expect(new Set(labels).size, 'labels must be unique').toBe(66);
    for (const name of FIXTURE_NAMES) {
      expect(labels.filter((l) => l.startsWith(`${name}:`))).toHaveLength(22);
      expect(labels).toContain(`${name}:full`);
      for (const frac of [0.25, 0.5, 0.75, 0.999]) {
        expect(labels).toContain(`${name}:trunc${frac}`);
      }
      expect(labels).toContain(`${name}:empty`);
      expect(labels).toContain(`${name}:garbage`);
      expect(labels).toContain(`${name}:headeronly`);
      for (let i = 0; i < 14; i++) {
        expect(labels.some((l) => l.startsWith(`${name}:flip${i}@`))).toBe(true);
      }
    }

    // Same seed, same order: a second pass must be indistinguishable, or a
    // regenerated table would re-label inputs the assertions never moved.
    const second = mutate((name) => files.get(name) as Uint8Array);
    expect(second.map(([label]) => label)).toEqual(labels);
    for (let i = 0; i < second.length; i++) {
      expect(second[i]?.[1]).toEqual(first[i]?.[1]);
    }
  });

  it('builds each mutation kind as documented', () => {
    const files = fakeFixtures();
    const rows = new Map(mutate((name) => files.get(name) as Uint8Array));
    const original = files.get('example.heic') as Uint8Array;

    expect(rows.get('example.heic:full')).toEqual(original);
    expect(rows.get('example.heic:trunc0.5')).toEqual(original.subarray(0, 100));
    expect(rows.get('example.heic:trunc0.999')).toEqual(original.subarray(0, 199));
    expect(rows.get('example.heic:empty')).toHaveLength(0);
    expect(rows.get('example.heic:headeronly')).toEqual(original.subarray(0, 12));
    expect([...(rows.get('example.heic:garbage') as Uint8Array)]).toEqual(new Array(64).fill(0xff));
  });

  it('flips exactly one bit at the offset the label names', () => {
    const files = fakeFixtures();
    const original = files.get('colors-with-alpha.heic') as Uint8Array;
    const rows = new Map(
      mutate((name) => (name === 'colors-with-alpha.heic' ? original : new Uint8Array(1)))
    );

    const flips = [...rows].filter(([label]) => label.startsWith('colors-with-alpha.heic:flip'));
    expect(flips).toHaveLength(14);
    for (const [label, bytes] of flips) {
      const pos = Number(label.split('@')[1]);
      expect(Number.isInteger(pos), label).toBe(true);
      expect(pos, label).toBeGreaterThanOrEqual(24);
      expect(bytes.length).toBe(original.length);
      let differing = 0;
      for (let i = 0; i < bytes.length; i++) {
        const xor = bytes[i] ^ (original[i] as number);
        if (xor !== 0) {
          differing += 1;
          expect(i, `${label}: diff byte is not the labelled offset`).toBe(pos);
          expect(xor & (xor - 1), `${label}: more than one bit flipped`).toBe(0);
        }
      }
      expect(differing, `${label}: nothing was mutated`).toBe(1);
    }
  });
});

describe('outcomeOf', () => {
  it('encodes a successful decode as a 12-hex RGBA prefix', () => {
    const outcome = outcomeOf({ data: new Uint8Array([1, 2, 3, 4]) }, null);
    expect(outcome).toMatch(/^OK:[0-9a-f]{12}$/);
    // Content-addressed: a different raster must not collide with the same prefix by luck.
    expect(outcomeOf({ data: new Uint8Array([1, 2, 3, 5]) }, null)).not.toBe(outcome);
  });

  it('encodes typed failures by code and everything else as untyped', () => {
    expect(outcomeOf(null, { code: 'decode_failed' })).toBe('ERR:decode_failed');
    expect(outcomeOf(null, new Error('boom'))).toBe('ERR:untyped');
    expect(outcomeOf(null, 'raw string')).toBe('ERR:untyped');
  });
});

describe('table rendering', () => {
  const rows = new Map([
    ['a.heic:full', 'OK:0123456789ab'],
    ['a.heic:garbage', 'ERR:decode_failed']
  ]);

  it('round-trips through parseTable', () => {
    expect(parseTable(renderTable(rows))).toEqual(rows);
  });

  it('renders one quoted entry per line with no trailing comma', () => {
    const rendered = renderTable(rows);
    expect(rendered).toBe("  'a.heic:full': 'OK:0123456789ab',\n  'a.heic:garbage': 'ERR:decode_failed'");
    expect(rendered.endsWith(',')).toBe(false);
  });
});

describe('diffTable', () => {
  it('reports changed, newly emitted, and stale rows', () => {
    const committed = new Map([
      ['kept', 'OK:aaaaaaaaaaaa'],
      ['moved', 'ERR:decode_failed'],
      ['stale', 'OK:bbbbbbbbbbbb']
    ]);
    const regenerated = new Map([
      ['kept', 'OK:aaaaaaaaaaaa'],
      ['moved', 'OK:cccccccccccc'],
      ['fresh', 'ERR:decode_failed']
    ]);
    expect(diffTable(committed, regenerated)).toEqual([
      'moved: ERR:decode_failed -> OK:cccccccccccc',
      'fresh: <missing> -> ERR:decode_failed',
      'stale: OK:bbbbbbbbbbbb -> <the generator no longer emits this input>'
    ]);
  });

  it('is empty when the tables agree', () => {
    const rows = new Map([['kept', 'OK:aaaaaaaaaaaa']]);
    expect(diffTable(rows, new Map(rows))).toEqual([]);
  });
});

describe('the committed MUTATION_GOLDENS block', () => {
  const source = readFileSync(GOLDEN_TEST, 'utf8');
  const start = source.indexOf(TABLE_START);
  const end = source.indexOf('\n};', start);

  it('exists where the generator expects it', () => {
    expect(start, `${TABLE_START} not found`).toBeGreaterThan(-1);
    expect(end, 'unterminated MUTATION_GOLDENS block').toBeGreaterThan(start);
  });

  it('is machine-formatted: the CLI can rewrite it byte for byte', () => {
    // The block is generated output — prose belongs in the tests, since
    // regeneration destroys comments inside it. Asserting the bytes are exactly
    // what `renderTable` emits fails hand-edits (reordered row, stray comment,
    // reformatted entry).
    const body = source.slice(start + TABLE_START.length + 1, end);
    expect(parseTable(body).size, 'every row must parse as a label/outcome pair').toBe(66);
    expect(body).not.toMatch(/\/\/|\/\*/);
    expect(body).toBe(renderTable(parseTable(body)));
  });
});
