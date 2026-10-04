import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The README error table is the only place a caller can learn which `code`
// values exist, and it drifted silently before (a row sat below the table and
// rendered as literal text; `worker_load_failed` was missing entirely). Both
// sides are parsed from source here, so a code added to `src/errors.ts`
// without a README row — or a row for a code that does not exist — fails.

const readme = readFileSync(
  fileURLToPath(new URL('../../README.md', import.meta.url)),
  'utf8'
);
const errorsSource = readFileSync(
  fileURLToPath(new URL('../../src/errors.ts', import.meta.url)),
  'utf8'
);

const declaredCodes = (): string[] => {
  const declaration = errorsSource.match(/export type HeicConverterErrorCode =([\s\S]*?);/);
  if (!declaration) {
    throw new Error('HeicConverterErrorCode union not found in src/errors.ts');
  }
  return [...declaration[1].matchAll(/'([a-z_]+)'/g)].map(([, code]) => code);
};

/** Lines of the "### Error handling" section, up to the example code fence. */
const errorSectionLines = (): string[] => {
  const start = readme.indexOf('### Error handling');
  expect(start, 'README has no "### Error handling" section').toBeGreaterThan(-1);
  const end = readme.indexOf('\n```', start);
  expect(end, 'error table is not followed by the example block').toBeGreaterThan(start);
  return readme.slice(start, end).split('\n');
};

/** The code column of every data row, in document order. */
const tableCodes = (): string[] => {
  return errorSectionLines()
    .filter((line) => line.startsWith('|'))
    .map((line) => (line.match(/^\|\s*`([a-z_]+)`\s*\|/) ?? ['', ''])[1])
    .filter((code) => code !== '' && code !== 'code'); // 'code' is the header cell
};

describe('README error table', () => {
  it('documents exactly the codes the public type declares', () => {
    expect([...tableCodes()].sort()).toEqual([...declaredCodes()].sort());
  });

  it('never documents a code twice', () => {
    const codes = tableCodes();
    expect(new Set(codes).size, `duplicates in: ${codes.join(', ')}`).toBe(codes.length);
  });

  it('keeps every row in one contiguous block', () => {
    // Guards the bug where a row was pasted below an intervening paragraph and
    // rendered as literal pipe characters instead of a table row.
    const lines = errorSectionLines();
    const rows = lines.map((line) => line.startsWith('|'));
    const first = rows.indexOf(true);
    expect(first, 'no table found').toBeGreaterThan(-1);
    let last = first;
    while (rows[last + 1]) {
      last += 1;
    }
    const stranded = lines
      .slice(last + 1)
      .findIndex((line) => /^\|\s*`[a-z_]+`/.test(line));
    if (stranded !== -1) {
      throw new Error(`row stranded below the table: ${lines[last + 1 + stranded]}`);
    }
  });
});
