import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE_DIR = path.join(rootDir, 'test/fixtures');
const GOLDEN_TEST = path.join(rootDir, 'test/unit/wasm-golden.test.ts');
const DIST_DIR = path.join(rootDir, 'dist');

// Region of `test/unit/wasm-golden.test.ts` this script owns: everything from
// the opening brace to the closing one is regenerated wholesale, which is why
// the table carries no hand-written comments — prose belongs in the tests and
// the table is machine-owned data.
const TABLE_START = 'const MUTATION_GOLDENS: Record<string, string> = {';

const MUTATED_FIXTURES = ['example.heic', 'colors-with-alpha.heic', 'exif-orientation-6.heic'];
const MUTATION_FRACTIONS = [0.25, 0.5, 0.75, 0.999];
const FLIPS_PER_FIXTURE = 14;
const FLIP_SEED = 0x5eed;

/**
 * Builds the mutated inputs behind `MUTATION_GOLDENS`: a single deterministic
 * LCG seeded with `0x5eed`, consumed in a fixed order, so every `flipN@<offset>`
 * label is reproducible across machines and runs.
 *
 * Lives here, next to the generator that writes the table, rather than inside
 * the test file: the one operation that must use the *identical* generator is
 * regeneration, and having it in two places is how a regenerated table silently
 * re-labels inputs the assertions never intended to re-check. `readFile` is
 * injectable so the shape of the table can be tested without the fixtures.
 *
 * @param {(name: string) => Uint8Array} [readFile] fixture reader, defaults to test/fixtures
 * @returns {Array<[string, Uint8Array]>} `[label, mutatedBytes]` in table order
 */
export function buildMutations(readFile = (name) => readFileSync(path.join(FIXTURE_DIR, name))) {
  let seed = FLIP_SEED;
  const rnd = (n) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  const inputs = [];
  for (const name of MUTATED_FIXTURES) {
    const bytes = readFile(name);
    inputs.push([`${name}:full`, new Uint8Array(bytes)]);
    for (const frac of MUTATION_FRACTIONS) {
      inputs.push([
        `${name}:trunc${frac}`,
        new Uint8Array(bytes.subarray(0, Math.max(1, Math.floor(bytes.length * frac))))
      ]);
    }
    inputs.push([`${name}:empty`, new Uint8Array(0)]);
    inputs.push([`${name}:garbage`, new Uint8Array(64).fill(0xff)]);
    inputs.push([`${name}:headeronly`, new Uint8Array(bytes.subarray(0, 12))]);
    for (let i = 0; i < FLIPS_PER_FIXTURE; i++) {
      const copy = Uint8Array.from(bytes);
      const pos = 24 + rnd(Math.max(1, copy.length - 25));
      copy[pos] ^= 1 << rnd(8);
      inputs.push([`${name}:flip${i}@${pos}`, copy]);
    }
  }
  return inputs;
}

/** Golden outcome string for a decode: `OK:<first 12 hex of RGBA sha256>` or `ERR:<code>`. */
export function outcomeOf(decoded, error) {
  if (error) {
    return `ERR:${typeof error?.code === 'string' ? error.code : 'untyped'}`;
  }
  const hex = createHash('sha256').update(Buffer.from(decoded.data)).digest('hex');
  return `OK:${hex.slice(0, 12)}`;
}

/**
 * Renders the mutation table body (no braces, two-space indent, no trailing
 * comma on the last row). The caller keeps the surrounding `const ... = {` and
 * `};` so this stays a pure string->string function a unit test can round-trip.
 */
export function renderTable(rows) {
  return [...rows].map(([label, outcome]) => `  '${label}': '${outcome}'`).join(',\n');
}

/** Parses the entries out of a MUTATION_GOLDENS object literal. */
export function parseTable(source) {
  const rows = new Map();
  for (const [, label, outcome] of source.matchAll(/'([^']+)':\s*'([^']+)'/g)) {
    rows.set(label, outcome);
  }
  return rows;
}

/**
 * Rows that differ between the committed table and a fresh decode: changed
 * values, rows the decoder no longer produces, and rows the generator produces
 * that the table never recorded. Exported so the comparison the CLI performs is
 * the one under test.
 */
export function diffTable(committed, regenerated) {
  const problems = [];
  for (const [label, outcome] of regenerated) {
    if (!committed.has(label)) {
      problems.push(`${label}: <missing> -> ${outcome}`);
    } else if (committed.get(label) !== outcome) {
      problems.push(`${label}: ${committed.get(label)} -> ${outcome}`);
    }
  }
  for (const label of committed.keys()) {
    if (!regenerated.has(label)) {
      problems.push(`${label}: ${committed.get(label)} -> <the generator no longer emits this input>`);
    }
  }
  return problems;
}

// Guarded so `npm test` can import the helpers without decoding anything.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const write = process.argv.includes('--write');
  const wasmPath = path.join(DIST_DIR, 'heic-decoder.wasm');
  if (!existsSync(wasmPath) || !existsSync(path.join(DIST_DIR, 'index.mjs'))) {
    console.error(
      `Error: ${wasmPath} (or dist/index.mjs) not found.\n` +
        'The goldens describe what the *built* decoder does, so run `npm run build` first\n' +
        '(and `npm run build:wasm` before that if the decoder itself was regenerated).'
    );
    process.exit(1);
  }

  const source = readFileSync(GOLDEN_TEST, 'utf8');
  const start = source.indexOf(TABLE_START);
  if (start < 0) {
    console.error(`Error: ${TABLE_START} not found in ${GOLDEN_TEST} — the table shape changed.`);
    process.exit(1);
  }
  const end = source.indexOf('\n};', start);
  if (end < 0) {
    console.error(`Error: the MUTATION_GOLDENS block in ${GOLDEN_TEST} is unterminated.`);
    process.exit(1);
  }
  const committed = parseTable(source.slice(start, end));

  const { LibheifDecoder } = await import(path.join(DIST_DIR, 'index.mjs'));
  const wasmBinary = readFileSync(wasmPath);
  const regenerated = new Map();
  for (const [label, bytes] of buildMutations()) {
    // One decoder per input, exactly as the suite does it: a faulted module must
    // not carry into the next outcome and make a healthy input look broken.
    const decoder = new LibheifDecoder({ wasmBinary });
    try {
      await decoder.initialize();
      regenerated.set(label, outcomeOf(await decoder.decode(bytes), null));
    } catch (error) {
      regenerated.set(label, outcomeOf(null, error));
    } finally {
      decoder.free();
    }
  }

  const problems = diffTable(committed, regenerated);
  console.log(`MUTATION_GOLDENS: ${regenerated.size} inputs, ${problems.length} row(s) differ from the committed table.`);
  for (const problem of problems) {
    console.log(`  ${problem}`);
  }

  if (!write) {
    if (problems.length > 0) {
      console.error(
        '\nA drifted table means the decoder changed what it does with malformed input.\n' +
          'Confirm that change is intended, then run: npm run wasm:goldens -- --write'
      );
      process.exit(1);
    }
    console.log('Goldens match the built decoder.');
  } else {
    const bodyStart = start + TABLE_START.length; // just past the opening brace
    const rewritten = `${source.slice(0, bodyStart)}\n${renderTable(regenerated)}${source.slice(end)}`;
    writeFileSync(GOLDEN_TEST, rewritten);
    console.log(`Rewrote the MUTATION_GOLDENS block in ${path.relative(rootDir, GOLDEN_TEST)}.`);
  }
}
