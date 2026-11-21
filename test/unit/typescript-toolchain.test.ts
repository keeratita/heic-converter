import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// TypeScript is installed twice on purpose. 7.x is the native (Go) compiler and
// ships only a CLI — the programmatic API arrives in 7.1 — while typescript-eslint
// and tsup's DTS pass embed the 6.0 API, so the tree resolves `tsc` to the 7.0
// binary through the `@typescript/native` alias and `require('typescript')` to the
// `@typescript/typescript6` compat shim. Nothing in `npm run typecheck` going
// green distinguishes that arrangement from a broken one, and the obvious
// "cleanup" (drop the duplicate, un-alias `typescript`) silently moves either the
// typechecker or the linter onto a compiler that cannot do its job. Pinned here:
// which binary runs, which API the tools load, and that both match what
// package.json and install-scripts.json claim.

const require = createRequire(import.meta.url);
const at = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));
const NODE_MODULES = at('../../node_modules');

type Manifest = {
  name: string;
  version: string;
  peerDependencies?: Record<string, string>;
};

const readManifest = (dir: string) =>
  JSON.parse(readFileSync(`${dir}/package.json`, 'utf8')) as Manifest;
const manifestOf = (packageName: string) => readManifest(`${NODE_MODULES}/${packageName}`);

const rootManifest = JSON.parse(readFileSync(at('../../package.json'), 'utf8')) as {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  overrides?: Record<string, string>;
};

const major = (version: string) => Number(version.split('.')[0]);
const nativeCli = manifestOf('@typescript/native'); // `typescript@7`, aliased
const compatShim = manifestOf('typescript'); // `@typescript/typescript6`, aliased
const apiVersion = require('typescript').version as string; // what the tools embed

function compareVersions(a: string, b: string) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) {
      return (pa[i] ?? 0) - (pb[i] ?? 0);
    }
  }
  return 0;
}

interface Clause {
  op: '>=' | '>' | '<=' | '<' | '=';
  version: string;
}

/**
 * The slice of semver peer ranges the TypeScript ecosystem actually writes:
 * comparators, carets, `||` alternatives, wildcards. Anything else is a parse
 * failure rather than a silent pass, so a range the parser does not understand
 * cannot quietly weaken the guard that leans on it.
 */
function satisfies(candidate: string, range: string) {
  const parseClauses = (alternative: string): Clause[] =>
    alternative
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .flatMap((clause): Clause[] => {
        if (/^(?:\*|x|latest)$/.test(clause)) {
          return [];
        }
        const caret = /^\^(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/.exec(clause);
        if (caret) {
          const [, majorPart, minorPart, patchPart] = caret;
          const lower: Clause = { op: '>=', version: `${majorPart}.${minorPart}.${patchPart}` };
          if (Number(majorPart) > 0) {
            return [lower, { op: '<', version: `${Number(majorPart) + 1}.0.0` }];
          }
          if (Number(minorPart) > 0) {
            return [lower, { op: '<', version: `0.${Number(minorPart) + 1}.0` }];
          }
          return [lower, { op: '<', version: '0.1.0' }];
        }
        const comparator = /^(>=|<=|>|<|=)?(\d+\.\d+\.\d+)(?:[-+][0-9A-Za-z.-]+)?$/.exec(clause);
        if (!comparator) {
          throw new Error(`unsupported semver clause "${clause}" in range "${range}"`);
        }
        return [{ op: (comparator[1] ?? '=') as Clause['op'], version: comparator[2] }];
      });

  const holds = (clause: Clause) => {
    const c = compareVersions(candidate, clause.version);
    switch (clause.op) {
      case '>=':
        return c >= 0;
      case '>':
        return c > 0;
      case '<=':
        return c <= 0;
      case '<':
        return c < 0;
      default:
        return c === 0;
    }
  };
  return range.split('||').some((alternative) => parseClauses(alternative).every(holds));
}

describe('the side-by-side TypeScript install', () => {
  it('runs the typecheck through the native 7.x compiler', () => {
    const bin = at('../../node_modules/.bin/tsc');
    // One assertion for "missing", "dangling", and "pointing at the JS compiler":
    // the message has to name what `npm run typecheck` actually executes.
    const resolved = existsSync(bin) ? realpathSync(bin) : '';
    expect(
      resolved.replace(/\\/g, '/').endsWith('/node_modules/@typescript/native/bin/tsc'),
      `npm run typecheck must run the aliased native compiler, but node_modules/.bin/tsc is ${resolved || 'missing or dangling'}`
    ).toBe(true);
    expect(major(nativeCli.version), `@typescript/native is ${nativeCli.name}@${nativeCli.version}`).toBeGreaterThanOrEqual(
      7
    );
    // The shim and the manifest can disagree if the alias is rewired by hand; the
    // version the binary prints itself is the fact.
    const reported = execFileSync('node', [resolved, '--version'], { encoding: 'utf8' }).trim();
    expect(reported).toBe(`Version ${nativeCli.version}`);
  });

  it('loads the 6.x programmatic API for the tools that embed it', () => {
    expect(compatShim.name, 'node_modules/typescript must be the 6.0 compat package').toBe('@typescript/typescript6');
    expect(major(apiVersion), `the API the tools load is ${apiVersion}`).toBe(6);
    // The compat package is a shim over the real 6.0 tree, so the version the
    // tools see is that copy's — and it must be the one package.json pinned.
    expect(apiVersion).toBe(manifestOf('@typescript/old').version);
    expect(
      rootManifest.overrides?.['@typescript/old'],
      'the compat shim depends on `npm:typescript@^6`, which floats past typescript-eslint\'s <6.1.0 cap without this pin'
    ).toBe(`npm:typescript@${apiVersion}`);
  });

  it('installs the two compilers as distinct packages', () => {
    // One package name at two versions is the shape; a single install means
    // either the CLI or the API is the wrong compiler for this toolchain.
    expect(nativeCli.name).toBe('typescript');
    expect(nativeCli.version).not.toBe(apiVersion);
    expect(rootManifest.devDependencies?.['@typescript/native'], 'the native CLI must be an exact alias').toBe(
      `npm:typescript@${nativeCli.version}`
    );
    expect(rootManifest.devDependencies?.typescript, 'the compat package must be an exact alias').toBe(
      `npm:${compatShim.name}@${compatShim.version}`
    );
  });

  it('keeps the loaded API inside every peer range that embeds it', () => {
    // typescript-eslint certifies `<6.1.0`; ts-api-utils and the parser declare
    // their own. Read from the installed tree so a tool added later, or a
    // tightened cap in an update, is checked without editing this file.
    const declared: Array<[string, string]> = [];
    const walk = (dir: string, depth: number) => {
      if (depth > 4) {
        return;
      }
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isSymbolicLink() || !entry.isDirectory()) {
          continue;
        }
        const here = `${dir}/${entry.name}`;
        if (entry.name.startsWith('@') && !existsSync(`${here}/package.json`)) {
          walk(here, depth); // scope directory: its children are the packages
          continue;
        }
        try {
          const pkg = readManifest(here);
          const range = pkg.peerDependencies?.typescript;
          if (range) {
            declared.push([`${pkg.name}@${pkg.version}`, range]);
          }
          walk(`${here}/node_modules`, depth + 1); // unhoisted duplicates
        } catch {
          /* not a package directory — no manifest to read */
        }
      }
    };
    walk(NODE_MODULES, 0);
    expect(declared.length, 'no installed package declares a TypeScript peer — this guard went vacuous').toBeGreaterThan(
      0
    );
    for (const [who, range] of declared) {
      expect(satisfies(apiVersion, range), `${who} requires typescript ${range}, the loaded API is ${apiVersion}`).toBe(
        true
      );
    }
  });
});

describe('satisfies — the peer-range parser this file leans on', () => {
  it('reads the forms the ecosystem writes, and refuses the rest', () => {
    expect(satisfies('6.0.3', '>=4.8.4 <6.1.0')).toBe(true);
    expect(satisfies('6.1.0', '>=4.8.4 <6.1.0')).toBe(false);
    expect(satisfies('4.8.3', '>=4.8.4 <6.1.0')).toBe(false);
    expect(satisfies('6.0.3', '^6.0.0')).toBe(true);
    expect(satisfies('7.0.2', '^6.0.0')).toBe(false);
    expect(satisfies('0.2.0', '^0.1.0')).toBe(false); // caret below 1.0 pins the minor
    expect(satisfies('0.1.9', '^0.1.0')).toBe(true);
    expect(satisfies('5.0.0', '^4.0.0 || ^5.0.0')).toBe(true);
    expect(satisfies('3.0.0', '^4.0.0 || ^5.0.0')).toBe(false);
    expect(satisfies('6.0.3', '*')).toBe(true);
    expect(satisfies('6.0.3', '>=6.0.0-beta.0')).toBe(true);
    expect(satisfies('6.0.3', '6.0.3')).toBe(true);
    expect(() => satisfies('6.0.3', 'npm:typescript@^7')).toThrow(/unsupported semver clause/);
  });
});
