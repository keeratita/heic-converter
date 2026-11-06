import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Guards the published type surface — the only part of `dist/` no other suite
 * inspects:
 *
 * - every `exports` target resolves to a file that actually exists,
 * - the root `types` condition is hoisted ahead of `require`/`import`, which is
 *   what makes both consumer styles land on one declaration file,
 * - a second declaration file beside it can only be a byte-identical duplicate,
 *   never a divergent second source of truth,
 * - the declarations really declare the surface both formats export at runtime
 *   (tsup's DTS rollup can emit a stub without failing the build).
 *
 * The hoisting pin is load-bearing, not cosmetic. tsup emits `index.d.mts`
 * beside `index.d.ts`; while `types` is a single hoisted string nothing can
 * select the `.d.mts`, so the duplicate is harmless. Nest `types` per
 * condition and it becomes what ESM consumers compile against — so that
 * restructure has to trip this test deliberately rather than silently.
 *
 * Skips without `dist/`, never on CI (see `AGENTS.md`): a build that stopped
 * emitting declarations would otherwise delete these guards green.
 */
const DIST = fileURLToPath(new URL('../../dist', import.meta.url));
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const PKG_PATH = fileURLToPath(new URL('../../package.json', import.meta.url));
const isBuilt = existsSync(`${DIST}/index.mjs`);
const isCI = !!process.env.CI;

const pkg = JSON.parse(readFileSync(PKG_PATH, 'utf8')) as {
  // Required for this package: its absence would be a guard failure, not a
  // case to handle, so the type says what the manifest promises.
  types: string;
  exports: Record<string, Record<string, unknown>>;
};

/**
 * Maps a package specifier to a real path. `exports` targets are relative to
 * the package root (`./dist/index.mjs`) and `pkg.types` has no leading `./`, so
 * neither can be joined onto `dist/` directly — that resolves to `dist/dist/`.
 */
const pkgPath = (target: string): string => `${ROOT}/${target.replace(/^\.\//, '')}`;

/**
 * Node's conditional-exports rule: the first key in *object order* that is in
 * the active condition set wins, with `default` as the fallback. Order is
 * semantic, so the map's key sequence is part of what is pinned below, and
 * TypeScript participates by putting `types` first in the set it passes.
 */
function resolveTarget(entry: Record<string, unknown>, conditions: string[]): string | null {
  for (const [key, value] of Object.entries(entry)) {
    if (!(conditions.includes(key) || key === 'default')) continue;
    if (typeof value === 'string') return value;
    if (value && typeof value === 'object') {
      const nested = resolveTarget(value as Record<string, unknown>, conditions);
      if (nested) return nested;
    }
  }
  return null;
}

/**
 * Names declared as values in a `.d.ts`. A runtime export missing from this set
 * is a consumer's "has no exported member" error, so the declaration file is
 * only trustworthy as far as this check reaches.
 */
function missingDeclarations(declarations: string, names: string[]): string[] {
  return names.filter(
    (name) => !new RegExp(`declare\\s+(?:function|class|const|let|var)\\s+${name}\\b`).test(declarations)
  );
}

/** Every string leaf of an `exports` map — each one must exist on disk. */
function exportTargets(entry: Record<string, unknown>): string[] {
  return Object.values(entry).flatMap((value) =>
    typeof value === 'string' ? [value] : exportTargets(value as Record<string, unknown>)
  );
}

const rootEntry = pkg.exports['.'];

describe('published package exports and type surface', () => {
  describe.skipIf(!isBuilt && !isCI)('against the built dist/', () => {
    it('points every exports target at a file that exists', () => {
      const dangling = Object.entries(pkg.exports)
        .flatMap(([subpath, entry]) => exportTargets(entry).map((target) => `${subpath} -> ${target}`))
        .filter((pair) => !existsSync(pkgPath(pair.split(' -> ')[1])));
      expect(dangling, `dangling exports targets: ${dangling.join(', ')}`).toEqual([]);
      // The root entry must offer both formats, or one consumer style is dark.
      const root = exportTargets(rootEntry);
      expect(root.some((t) => t.endsWith('.mjs')), 'no ESM target in the root entry').toBe(true);
      expect(root.some((t) => t.endsWith('.js')), 'no CJS target in the root entry').toBe(true);
    });

    it('hoists types ahead of require/import instead of nesting them', () => {
      const keys = Object.keys(rootEntry);
      const typesValue = rootEntry['types'];
      expect(
        typeof typesValue,
        '`types` must be one hoisted string. Nesting it per condition makes the duplicate ' +
          '`index.d.mts` the file ESM consumers compile against — if that restructure is ' +
          'deliberate, pin both declaration files and extend this suite to check them both.'
      ).toBe('string');
      // Key order decides resolution, so `types` has to precede the format keys.
      expect(keys.indexOf('types')).toBeLessThan(keys.indexOf('require'));
      expect(keys.indexOf('types')).toBeLessThan(keys.indexOf('import'));
      // The two `types` fields in the manifest are separate facts that must agree.
      expect(typesValue).toBe(`./${pkg.types}`);
    });

    it('routes require and import consumers to the same declaration file', () => {
      const esmTypes = resolveTarget(rootEntry, ['types', 'import', 'node']);
      const cjsTypes = resolveTarget(rootEntry, ['types', 'require', 'node']);
      const declared = `./${pkg.types}`;
      expect(esmTypes, 'ESM consumers must resolve types through the hoisted condition').toBe(declared);
      expect(cjsTypes, 'CJS consumers must resolve types through the hoisted condition').toBe(declared);
      expect(existsSync(pkgPath(pkg.types)), 'the selected declaration file is missing').toBe(true);
    });

    it('loads both published formats in Node and exports the same names', async () => {
      const esm = await import(pathToFileURL(`${DIST}/index.mjs`).href);
      const cjs = createRequire(import.meta.url)(`${DIST}/index.js`) as Record<string, unknown>;
      // A format that silently exports less is invisible until a consumer hits it.
      expect(Object.keys(cjs).sort()).toEqual(Object.keys(esm).sort());
      expect(Object.keys(esm).length, 'the published entry exports nothing — a stub build').toBeGreaterThan(0);
    });

    it('declares every runtime export in the shipped declaration file', async () => {
      const esm = await import(pathToFileURL(`${DIST}/index.mjs`).href);
      const declarations = readFileSync(pkgPath(pkg.types), 'utf8');
      const missing = missingDeclarations(declarations, Object.keys(esm));
      expect(missing, `runtime exports missing from ${pkg.types}: ${missing.join(', ')}`).toEqual([]);
    });

    it('keeps any second declaration file a byte-identical duplicate', () => {
      const twin = `${DIST}/index.d.mts`;
      if (!existsSync(twin)) return; // tsup may collapse to one file; that is the better shape
      const selected = readFileSync(pkgPath(pkg.types));
      expect(
        readFileSync(twin).equals(selected),
        'index.d.mts differs from the file `types` selects. Two divergent declaration files mean ' +
          'which types a consumer gets depends on which tool it uses — make them identical or stop ' +
          'publishing the twin.'
      ).toBe(true);
    });
  });

  // Falsification: each guard above must actually reject the shape it claims to
  // prevent. Without these, a check that never bites reads identical to one
  // that cannot.
  describe('guards bite', () => {
    it('a nested types condition selects a different file per consumer style', () => {
      const nested = {
        import: { types: './dist/index.d.mts', default: './dist/index.mjs' },
        require: { types: './dist/index.d.ts', default: './dist/index.js' }
      };
      const esm = resolveTarget(nested, ['types', 'import', 'node']);
      const cjs = resolveTarget(nested, ['types', 'require', 'node']);
      expect(esm).not.toBe(cjs);
      expect(esm).toBe('./dist/index.d.mts');
    });

    it('a hoisted types condition selects one file for both consumer styles', () => {
      const hoisted = { types: './dist/index.d.ts', require: './dist/index.js', import: './dist/index.mjs' };
      expect(resolveTarget(hoisted, ['types', 'import', 'node'])).toBe(
        resolveTarget(hoisted, ['types', 'require', 'node'])
      );
    });

    it('a stub declaration file is reported as declaring nothing', () => {
      const names = ['convertHeic', 'convertMany', 'HeicConverterError'];
      expect(missingDeclarations('export {};\n', names)).toEqual(names);
      const declared = [
        'declare function convertHeic(input: unknown): Promise<unknown>;',
        'declare function convertMany(inputs: unknown[]): Promise<unknown[]>;',
        'declare class HeicConverterError extends Error {}'
      ].join('\n');
      expect(missingDeclarations(declared, names)).toEqual([]);
    });

    it('exportTargets walks nested conditions rather than only the top level', () => {
      const nested = {
        require: { types: './dist/index.d.ts', default: './dist/index.js' },
        import: './dist/index.mjs'
      };
      expect(exportTargets(nested).sort()).toEqual(['./dist/index.d.ts', './dist/index.js', './dist/index.mjs']);
    });
  });
});
