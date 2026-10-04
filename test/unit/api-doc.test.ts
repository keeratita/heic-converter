import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// API.md is the reference consumers (and coding agents) actually read, and it
// duplicates two facts that live in code: the HeicConverterErrorCode union and
// the set of names the entry point publishes. Both drift silently — a code can
// be added without a row, a row can sit below the table and render as literal
// pipes, an export can ship undocumented — so both sides are parsed from source
// here, the same discipline test/unit/readme.test.ts applies to the README.

const apiDoc = readFileSync(fileURLToPath(new URL('../../API.md', import.meta.url)), 'utf8');
const errorsSource = readFileSync(
  fileURLToPath(new URL('../../src/errors.ts', import.meta.url)),
  'utf8'
);
const indexSource = readFileSync(
  fileURLToPath(new URL('../../src/index.ts', import.meta.url)),
  'utf8'
);

const declaredCodes = (): string[] => {
  const declaration = errorsSource.match(/export type HeicConverterErrorCode =([\s\S]*?);/);
  if (!declaration) {
    throw new Error('HeicConverterErrorCode union not found in src/errors.ts');
  }
  return [...declaration[1].matchAll(/'([a-z_]+)'/g)].map(([, code]) => code);
};

/**
 * The data rows of the error-code table: the contiguous run of `|` lines that
 * follows the "### `HeicConverterErrorCode`" heading, bounded by the next
 * section so a later table in the document cannot be mistaken for this one.
 */
const errorTableRows = (): { rows: string[]; below: string[] } => {
  const start = apiDoc.indexOf('### `HeicConverterErrorCode`');
  expect(start, 'API.md has no "### `HeicConverterErrorCode`" section').toBeGreaterThan(-1);
  const section = apiDoc.slice(start).split('\n').slice(1);
  const end = section.findIndex((line) => line === '---' || line.startsWith('## '));
  const body = section.slice(0, end === -1 ? section.length : end);
  const first = body.findIndex((line) => line.startsWith('| `'));
  expect(first, 'no error-code table found under the HeicConverterErrorCode heading').toBeGreaterThan(
    -1
  );
  let last = first;
  while (body[last + 1]?.startsWith('|')) {
    last += 1;
  }
  return { rows: body.slice(first, last + 1), below: body.slice(last + 1) };
};

const tableCodes = (): string[] =>
  errorTableRows()
    .rows.filter((line) => !line.startsWith('| ---'))
    .map((line) => (line.match(/^\|\s*`([a-z_]+)`\s*\|/) ?? ['', ''])[1])
    .filter((code) => code !== '' && code !== 'code'); // 'code' is the header cell

/** `export [type] { A, B } from './x'` and `export * from './x'` re-exports. */
const collectExports = (source: string, seen = new Set<string>()): Set<string> => {
  const names = new Set<string>();
  const declarations =
    /export\s+(?:async\s+)?(?:function|class|const|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g;
  for (const match of source.matchAll(declarations)) {
    names.add(match[1]);
  }
  for (const match of source.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}\s+from\s+'([^']+)'/g)) {
    for (const name of match[1].split(',')) {
      const trimmed = name.trim().split(/\s+as\s+/)[0];
      if (trimmed) {
        names.add(trimmed);
      }
    }
  }
  for (const match of source.matchAll(/export\s+\*\s+from\s+'([^']+)'/g)) {
    const specifier = match[1];
    if (specifier.startsWith('.')) {
      const path = fileURLToPath(new URL(`../../src/${specifier.replace(/^\.\//, '')}.ts`, import.meta.url));
      if (!seen.has(path)) {
        seen.add(path);
        for (const name of collectExports(readFileSync(path, 'utf8'), seen)) {
          names.add(name);
        }
      }
    }
  }
  return names;
};

const publicExports = (): string[] => [...collectExports(indexSource)].sort();

describe('API.md error table', () => {
  it('documents exactly the codes the public type declares', () => {
    expect([...tableCodes()].sort()).toEqual([...declaredCodes()].sort());
  });

  it('never documents a code twice', () => {
    const codes = tableCodes();
    expect(new Set(codes).size, `duplicates in: ${codes.join(', ')}`).toBe(codes.length);
  });

  it('keeps every row in one contiguous block', () => {
    // A row pasted below an intervening paragraph renders as literal pipe
    // characters instead of a table row — the failure the README guard exists
    // for, and one a hand-edited second copy is equally prone to.
    const stranded = errorTableRows().below.findIndex((line) => /^\|\s*`[a-z_]+`\s*\|/.test(line));
    expect(stranded, `row stranded below the table: ${errorTableRows().below[stranded] ?? ''}`).toBe(-1);
  });
});

describe('API.md export coverage', () => {
  it('documents every name the entry point exports', () => {
    const undocumented = publicExports().filter(
      (name) => !new RegExp(`\\b${name}\\b`).test(apiDoc)
    );
    expect(undocumented, `undocumented exports: ${undocumented.join(', ')}`).toEqual([]);
  });

  it('is not vacuous — the entry point publishes a substantial surface', () => {
    // Guards the extraction itself: a regex that stopped matching would make
    // the coverage check above pass by comparing against an empty list.
    expect(publicExports().length).toBeGreaterThan(20);
  });
});
