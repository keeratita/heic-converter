#!/usr/bin/env node
// Install-script firewall (ESM). Run via `npm run check:scripts`.
//
// With zero runtime dependencies, everything an installer executes comes from
// the *dev* tree: `npm ci` runs preinstall/install/postinstall of every dev
// dependency — the vector recent npm worms used. `npm ci --ignore-scripts` is
// not an option (esbuild's postinstall links its platform binary), so the
// packages that declare install scripts are pinned in
// `build-scripts/install-scripts.json` and CI fails on drift. A new entry means
// a real dependency was added: review it, then `npm run check:scripts -- --write`.
// Provenance is part of the verdict, not a note: a `resolved` that is not the
// public registry's own tarball for that name (`git`/`file:`/link, a foreign
// host, or another package's path) is never allowlisted, so a hand-edited
// lockfile cannot feed attacker bytes to an allowlisted name.
// npm aliases (`"typescript": "npm:@typescript/typescript6@^6"`) are the one
// sanctioned exception to "the name in `node_modules` is the package in it":
// TypeScript 7 ships only the native CLI, while typescript-eslint and tsup's
// DTS pass need the 6.0 programmatic API, so this tree installs both side by
// side. An alias still moves one package's bytes under another name, which is
// what the provenance rule exists to refuse, so it is reviewed separately — an
// explicit target in the `aliases` map, accepted only when the lockfile resolves
// the alias to that target's own tarball on the public registry.

import { existsSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ALLOWLIST = path.join(ROOT, 'build-scripts', 'install-scripts.json');
const LOCKFILE = path.join(ROOT, 'package-lock.json');
const INSTALL_SCRIPTS = ['preinstall', 'install', 'postinstall'];
const SKIP = new Set(['.bin', '.package-lock.json', '.cache']);
// The hook label that drives the verdict: `collectFromLockfile` stamps it and
// both `compare()` and `--write` refuse such entries. One shared name so a
// rename cannot silently desync the stamp from the refusal.
const NON_REGISTRY_DEP = 'non-registry-dep';
// The hook label that marks an npm alias. Aliased packages usually declare no
// install script at all, so without a label of their own they would never reach
// the verdict and an unreviewed retarget would pass silently; `compare()`
// requires a matching entry in `aliases` whenever it sees this. Same
// shared-constant rule as above: the stamp and the requirement cannot drift.
const ALIASED = 'aliased';
// Allowlist values are exact pins. A range is not a review: it matches nothing
// here, and "the package you just wrote down is not allowlisted" is the wrong
// way to discover a typo in the reviewed file.
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const PACKAGE_NAME = /^(?:@[^/]+\/)?[^/]+$/;

// Exact origin, not a hostname shape: a loose `registry.` pattern lets
// `https://registry.npmjs.org.evil.com/x.tgz`, or a plain-HTTP "registry", pass
// as the public registry — the one host the allowlist reviews tarballs against.
// Anything else is a non-registry resolution.
const REGISTRY_ORIGIN = 'https://registry.npmjs.org/';

export function isRegistryUrl(resolved) {
  return typeof resolved === 'string' && resolved.startsWith(REGISTRY_ORIGIN);
}

/**
 * Registry *provenance*, not just registry *origin*: the canonical layout is
 * `<origin>/<name>/-/<tarball>.tgz` and the name segment must equal the
 * manifest's name. Otherwise a hand-edited lockfile points an allowlisted
 * dependency (`esbuild`, say) at another package's tarball on the real registry,
 * or at a `git+ssh`/`file:` source, and slips past `compare()` — which matches
 * name and version only. Anything rejected here is never allowlisted.
 */
export function isRegistryTarballFor(name, resolved) {
  if (!isRegistryUrl(resolved)) {
    return false;
  }
  // Registry URLs keep the scope verbatim: `@scope/pkg/-/pkg-1.0.0.tgz`.
  return resolved.slice(REGISTRY_ORIGIN.length).startsWith(`${name}/-/`);
}

/**
 * Primary source: the committed lockfile — what `npm ci` installs and what a
 * reviewer diffs. `hasInstallScript` comes from the *published* manifest, so it
 * survives a package manager rewriting the installed copy: an installed
 * `node_modules/fsevents/package.json` can be missing the
 * `install: node-gyp rebuild` the registry version declares.
 *
 * Non-registry dependencies are flagged even without an install script: npm runs
 * `prepare` for `git`/`file:` deps and they have no published manifest, so
 * `hasInstallScript` never covers them. npm aliases are flagged the same way —
 * the directory name is not the package that landed in it, and which package
 * lives under a name the whole toolchain imports is a reviewable decision.
 */
export function collectFromLockfile(lock) {
  const found = [];
  for (const [key, entry] of Object.entries(lock?.packages ?? {})) {
    if (key === '' || !key.includes('node_modules/')) {
      continue; // the root project itself is not a dependency
    }
    const name = key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
    // npm writes `name` only for an aliased install: the manifest in the
    // directory belongs to the target, the directory belongs to the alias.
    const target =
      typeof entry.name === 'string' && entry.name.length && entry.name !== name ? entry.name : undefined;
    const version = entry.version ?? 'unknown';
    const hooks = [];
    if (entry.hasInstallScript) {
      hooks.push('hasInstallScript');
    }
    const resolved = typeof entry.resolved === 'string' ? entry.resolved : '';
    // Fail closed: an entry without `resolved` has no registry provenance to
    // check — the root project is already skipped above, and every legitimately
    // installed dependency carries a tarball URL. The tarball must belong to the
    // bytes' real owner, so an alias is checked against its *target's* path:
    // `npm:typescript@7` resolving to typescript's tarball is honest, resolving
    // to someone else's is the same name-swap the rule above refuses.
    if (entry.link === true || entry.linked === true || !isRegistryTarballFor(target ?? name, resolved)) {
      hooks.push(NON_REGISTRY_DEP);
    }
    if (target && !hooks.includes(NON_REGISTRY_DEP)) {
      hooks.push(ALIASED);
    }
    if (hooks.length) {
      found.push({ name, version, hooks, ...(target ? { alias: { name: target, version } } : {}) });
    }
  }
  return found;
}

/**
 * Every package under `nodeModulesDir` that runs code at install time.
 *
 * Catches what the lockfile flag does not: native addons built through
 * `binding.gyp` / `"gypfile": true`, and it still works with no lockfile at all.
 */
export function collectInstallScripts(nodeModulesDir) {
  const found = [];
  const readPkg = (dir) => {
    try {
      return JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
    } catch {
      return undefined;
    }
  };
  const isDir = (p) => {
    try {
      return statSync(p).isDirectory();
    } catch {
      return false;
    }
  };
  // Symlinks are never followed: `npm link`, a `file:` dependency, or a stray
  // self-referential link would send the walk into itself until the stack blows
  // up — a tooling crash rather than an allowlist verdict. Those packages are
  // caught by the lockfile's `non-registry-dep` rule instead, so nothing escapes
  // by skipping them here.
  const seen = new Set();
  const MAX_DEPTH = 12;
  const walk = (nmDir, depth) => {
    if (depth > MAX_DEPTH) {
      return;
    }
    let here;
    try {
      here = realpathSync(nmDir);
    } catch {
      return;
    }
    if (seen.has(here)) {
      return;
    }
    seen.add(here);
    let entries;
    try {
      entries = readdirSync(nmDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (SKIP.has(entry.name) || entry.isSymbolicLink() || !entry.isDirectory()) {
        continue;
      }
      const pkgDir = path.join(nmDir, entry.name);
      if (entry.name.startsWith('@')) {
        walk(pkgDir, depth + 1); // scope directory: its children are the packages
        continue;
      }
      const pkg = readPkg(pkgDir);
      const scripts = pkg?.scripts ?? {};
      const hooks = INSTALL_SCRIPTS.filter((hook) => typeof scripts[hook] === 'string' && scripts[hook].length);
      // node-gyp packages execute at install without saying so: npm runs an
      // implicit `install: node-gyp rebuild` when binding.gyp or "gypfile": true
      // is present, so a scripts-only scan is blind to them (fsevents is one).
      if (pkg && (pkg.gypfile === true || existsSync(path.join(pkgDir, 'binding.gyp')))) {
        hooks.push('binding.gyp');
      }
      if (pkg?.name && hooks.length) {
        found.push({ name: pkg.name, version: pkg.version ?? 'unknown', hooks });
      }
      // Nested (unhoisted) duplicates live here; a package's own source tree never
      // contains another package, so it is not walked.
      const nested = path.join(pkgDir, 'node_modules');
      if (isDir(nested)) {
        walk(nested, depth + 1);
      }
    }
  };
  walk(nodeModulesDir, 0);
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Flags install scripts that were never reviewed. The allowlist pins name *and*
 * version (`collectAll` reports distinct `name@version` pairs): matching on name
 * alone would let a malicious new release, or a nested duplicate at a second
 * version, of an already-reviewed package (`esbuild`, say) run arbitrary code at
 * install time without touching the file a reviewer looks at. When a name
 * legitimately installs at two versions, `--write` keeps only one (last wins)
 * and the other stays flagged until a reviewer edits the allowlist.
 *
 * Entries no longer installed are *not* a failure: optional dependencies are
 * platform-specific (`fsevents` exists on macOS, not on the ubuntu runner), so a
 * superset allowlist is correct and only reported as a note. Own-property lookup
 * only — a package named `constructor` or `__proto__` must not inherit its way
 * past the gate.
 *
 * `aliases` is the reviewed map of npm alias (`node_modules` directory name) to
 * the exact target it must resolve to (`name@version`). An alias is judged on
 * both axes: unreviewed or retargeted is a problem, and if the target does run
 * install scripts its *own* name and version need the `allow` entry, because the
 * target's bytes are what execute — the alias is just the address.
 */
export function compare(found, allowed, aliases) {
  const reviewedAliases = aliases ?? {};
  const problems = [];
  for (const pkg of found) {
    // Load-bearing, not decorative: an allowlisted name is worthless once its
    // bytes come from somewhere else. `git`/`file:`/foreign-host resolutions and
    // registry tarballs whose path belongs to a *different* package execute code
    // `npm ci` never reviewed against the allowlist — never allowlist them.
    if (pkg.hooks.includes(NON_REGISTRY_DEP)) {
      problems.push(
        `${pkg.name}@${pkg.version} resolves from a non-registry origin (git/file:/link, a foreign host, or a registry path belonging to another package) — non-registry install hooks are never allowlisted`
      );
      continue;
    }
    const scriptHooks = pkg.hooks.filter((hook) => hook !== ALIASED);
    let identity = pkg.name;
    if (pkg.alias) {
      identity = pkg.alias.name;
      const actual = `${pkg.alias.name}@${pkg.alias.version}`;
      const reviewed = Object.prototype.hasOwnProperty.call(reviewedAliases, pkg.name)
        ? reviewedAliases[pkg.name]
        : undefined;
      if (reviewed === undefined) {
        problems.push(
          `${pkg.name}@${pkg.version} is an npm alias for ${actual} that has not been reviewed — an alias decides whose bytes land under a name the whole toolchain imports; read the target, then npm run check:scripts -- --write`
        );
      } else if (reviewed !== actual) {
        problems.push(
          `${pkg.name}@${pkg.version} resolves to ${actual} but the allowlist reviewed ${reviewed} — retargeting an alias is a dependency change; read it, then npm run check:scripts -- --write`
        );
      }
    }
    if (!scriptHooks.length) {
      continue; // a reviewed alias that runs nothing at install time needs no `allow` entry
    }
    if (!Object.prototype.hasOwnProperty.call(allowed, identity)) {
      problems.push(`${identity}@${pkg.version} declares ${scriptHooks.join(', ')} but is not allowlisted`);
    } else if (allowed[identity] !== pkg.version) {
      problems.push(
        `${identity}@${pkg.version} is allowlisted at ${allowed[identity]} — an install script at a new version has not been reviewed; read it, then npm run check:scripts -- --write`
      );
    }
  }
  const foundNames = new Set(found.map((pkg) => (pkg.alias ? pkg.alias.name : pkg.name)));
  const stale = Object.keys(allowed).filter((name) => !foundNames.has(name));
  const staleAliases = Object.keys(reviewedAliases).filter(
    (name) => !found.some((pkg) => pkg.alias && pkg.name === name)
  );
  return { problems, stale, staleAliases };
}

/**
 * Shape check for the reviewed file itself. A malformed value fails closed
 * anyway — a range never equals an exact version, so the package stays flagged —
 * but then it fails as "not allowlisted" for a name the reviewer just wrote
 * down, which reads as a bug in the gate. Say what is actually wrong instead.
 */
export function validateAllowlist(config) {
  const problems = [];
  for (const [field, value] of [
    ['allow', config?.allow],
    ['aliases', config?.aliases],
  ]) {
    if (value === undefined || value === null) {
      continue; // absent means "nothing reviewed here", which is the fail-closed default
    }
    if (typeof value !== 'object' || Array.isArray(value)) {
      problems.push(`install-scripts.json "${field}" must be an object of package name → exact pin`);
      continue;
    }
    for (const [name, spec] of Object.entries(value)) {
      if (typeof spec !== 'string' || !spec.length) {
        problems.push(`install-scripts.json ${field}["${name}"] must be a non-empty string`);
      } else if (/\s/.test(spec)) {
        problems.push(`install-scripts.json ${field}["${name}"] = "${spec}" contains whitespace — a pin is exact, not padded`);
      } else if (field === 'aliases') {
        const at = spec.lastIndexOf('@');
        const target = at > 0 ? spec.slice(0, at) : '';
        const version = at > 0 ? spec.slice(at + 1) : '';
        if (!PACKAGE_NAME.test(target) || !EXACT_VERSION.test(version)) {
          problems.push(
            `install-scripts.json aliases["${name}"] = "${spec}" is not "name@exact-version" — an alias is reviewed against one target release`
          );
        }
      } else if (!EXACT_VERSION.test(spec)) {
        problems.push(
          `install-scripts.json allow["${name}"] = "${spec}" is not an exact version — a range is not a reviewed pin`
        );
      }
    }
  }
  return problems;
}

/**
 * Lockfile + installed tree, merged by *`name@version`*. The version in the key
 * is load-bearing: keying by name alone folds a nested duplicate of an
 * allowlisted package (`vite/node_modules/left-pad@evil` beside the reviewed
 * `left-pad@1.0.0`) into the allowlisted entry, so `compare()` never sees the
 * unreviewed version — the exact npm-worm shape the gate exists to catch.
 */
export function collectAll(nodeModules) {
  const merged = new Map();
  const add = (pkg) => {
    const key = `${pkg.name}@${pkg.version}`;
    const existing = merged.get(key);
    if (existing) {
      existing.hooks = [...new Set([...existing.hooks, ...pkg.hooks])];
    } else {
      merged.set(key, { ...pkg });
    }
  };
  if (existsSync(LOCKFILE)) {
    for (const pkg of collectFromLockfile(JSON.parse(readFileSync(LOCKFILE, 'utf8')))) {
      add(pkg);
    }
  } else {
    console.warn('package-lock.json is missing — checking only the installed tree');
  }
  if (existsSync(nodeModules)) {
    for (const pkg of collectInstallScripts(nodeModules)) {
      add(pkg);
    }
  }
  return [...merged.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function main() {
  const nodeModules = path.join(ROOT, 'node_modules');
  if (!existsSync(nodeModules) && !existsSync(LOCKFILE)) {
    console.error('Neither node_modules nor package-lock.json exists — run npm ci first.');
    process.exit(1);
  }
  const found = collectAll(nodeModules);
  if (process.argv.includes('--write')) {
    // `--write` blesses the whole found set; refusing here keeps a tampered (or
    // merely mis-installed) lockfile from being laundered into the allowlist.
    const offenders = found.filter((pkg) => pkg.hooks.includes(NON_REGISTRY_DEP));
    if (offenders.length) {
      console.error(
        `Refusing to --write with non-registry packages present: ${offenders.map((p) => `${p.name}@${p.version}`).join(', ')} — restore registry provenance (or remove them) first`
      );
      process.exit(1);
    }
    const allow = {};
    const aliases = {};
    for (const pkg of found) {
      if (pkg.alias) {
        aliases[pkg.name] = `${pkg.alias.name}@${pkg.alias.version}`;
      }
      if (pkg.hooks.some((hook) => hook !== ALIASED)) {
        // Keyed by the identity that executes: an aliased package is allowlisted
        // under its own name, so a reviewer reads the manifest of the bytes that
        // actually ran rather than of the address they were installed under.
        allow[pkg.alias ? pkg.alias.name : pkg.name] = pkg.version;
      }
    }
    writeFileSync(
      ALLOWLIST,
      `${JSON.stringify(Object.keys(aliases).length ? { allow, aliases } : { allow }, null, 2)}\n`
    );
    console.log(
      `Allowlisted ${Object.keys(allow).length} install-script package(s) and ${Object.keys(aliases).length} alias(es): ${[
        ...Object.keys(allow),
        ...Object.keys(aliases).map((name) => `${name} → ${aliases[name]}`),
      ].join(', ') || '(none)'}`
    );
    return;
  }
  if (!existsSync(ALLOWLIST)) {
    console.error('build-scripts/install-scripts.json is missing — generate it with: npm run check:scripts -- --write');
    process.exit(1);
  }
  const { allow, aliases } = JSON.parse(readFileSync(ALLOWLIST, 'utf8'));
  const malformed = validateAllowlist({ allow, aliases });
  if (malformed.length) {
    console.error(`Install-script allowlist is malformed:\n  ${malformed.join('\n  ')}`);
    console.error('\nEvery entry is a pin a human reviewed; fix the file, do not widen the gate.');
    process.exit(1);
  }
  const { problems, stale, staleAliases } = compare(found, allow ?? {}, aliases ?? {});
  if (problems.length) {
    console.error('Install-script drift detected:\n  ' + problems.join('\n  '));
    console.error('\nCurrent install-script-bearing packages:');
    for (const pkg of found) {
      console.error(`    ${pkg.name}@${pkg.version} (${pkg.hooks.join(', ')})`);
    }
    console.error('\nReview each new script — this is how npm worms execute on `npm ci` — then update the allowlist.');
    process.exit(1);
  }
  if (stale.length) {
    console.log(`Note: allowlisted but not installed here (platform-specific optional deps): ${stale.join(', ')}`);
  }
  if (staleAliases.length) {
    console.log(`Note: reviewed aliases no longer installed (drop them when convenient): ${staleAliases.join(', ')}`);
  }
  console.log(
    `Install scripts OK: ${found.length} package(s) — ${found.map((p) => `${p.name}@${p.version} (${p.hooks.join(', ')})`).join(', ') || '(none)'}`
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
