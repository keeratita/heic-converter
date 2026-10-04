#!/usr/bin/env node
// Install-script firewall (ESM). Run via `npm run check:scripts`.
//
// The package ships no runtime dependencies, so everything an installer
// executes comes from the *dev* tree: `npm ci` runs preinstall/install/
// postinstall of every dev dependency, and that is the vector recent npm
// worms used. `npm ci --ignore-scripts` is not an option here — esbuild needs
// its postinstall to link the platform binary — so instead the set of packages
// that declare install scripts is pinned in build-scripts/install-scripts.json
// and CI fails when it changes. A new entry means a real dependency was added;
// review it, then `npm run check:scripts -- --write`.

import { existsSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ALLOWLIST = path.join(ROOT, 'build-scripts', 'install-scripts.json');
const LOCKFILE = path.join(ROOT, 'package-lock.json');
const INSTALL_SCRIPTS = ['preinstall', 'install', 'postinstall'];
const SKIP = new Set(['.bin', '.package-lock.json', '.cache']);
const REGISTRY_HOST = /^https?:\/\/[^/]*registry\.[^/]+\//i;

/**
 * Primary source: the committed lockfile, which is what `npm ci` installs and
 * what a reviewer diffs. `hasInstallScript` is taken from the *published*
 * manifest, so it survives a package manager rewriting the installed copy — an
 * installed node_modules/fsevents/package.json can be missing the
 * `install: node-gyp rebuild` that the registry version declares.
 *
 * Non-registry dependencies are flagged even without an install script: npm runs
 * `prepare` for git/`file:` deps, and those have no published manifest, so
 * `hasInstallScript` never covers them.
 */
export function collectFromLockfile(lock) {
  const found = [];
  for (const [key, entry] of Object.entries(lock?.packages ?? {})) {
    if (key === '' || !key.includes('node_modules/')) {
      continue; // the root project itself is not a dependency
    }
    const name = key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
    const hooks = [];
    if (entry.hasInstallScript) {
      hooks.push('hasInstallScript');
    }
    const resolved = typeof entry.resolved === 'string' ? entry.resolved : '';
    if (entry.link === true || entry.linked === true || (resolved && !REGISTRY_HOST.test(resolved))) {
      hooks.push('non-registry-dep');
    }
    if (hooks.length) {
      found.push({ name, version: entry.version ?? 'unknown', hooks });
    }
  }
  return found;
}

/**
 * Every package under `nodeModulesDir` that runs code at install time.
 *
 * This catches what the lockfile flag does not: native addons built through
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
  // self-referential link would otherwise make the walk descend into itself
  // until the stack blows up, which reads as a tooling crash rather than an
  // allowlist verdict. Those packages are caught by the lockfile's
  // `non-registry-dep` rule instead, so nothing escapes by skipping them here.
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
 * version, because matching on name alone would let a malicious new release of
 * an already-reviewed package (esbuild, say) run arbitrary code at install time
 * without touching the file a reviewer looks at.
 *
 * Entries in the allowlist that are no longer installed are *not* a failure:
 * optional dependencies are platform-specific (fsevents exists on macOS, not on
 * the ubuntu runner), so a superset allowlist is correct and only reported as a
 * note. Own-property lookup only — a package named `constructor` or `__proto__`
 * must not inherit its way past the gate.
 */
export function compare(found, allowed) {
  const problems = [];
  for (const pkg of found) {
    if (!Object.prototype.hasOwnProperty.call(allowed, pkg.name)) {
      problems.push(`${pkg.name}@${pkg.version} declares ${pkg.hooks.join(', ')} but is not allowlisted`);
    } else if (allowed[pkg.name] !== pkg.version) {
      problems.push(
        `${pkg.name}@${pkg.version} is allowlisted at ${allowed[pkg.name]} — an install script at a new version has not been reviewed; read it, then npm run check:scripts -- --write`
      );
    }
  }
  const foundNames = new Set(found.map((pkg) => pkg.name));
  const stale = Object.keys(allowed).filter((name) => !foundNames.has(name));
  return { problems, stale };
}

/** Lockfile + installed tree, merged by package name. */
export function collectAll(nodeModules) {
  const merged = new Map();
  const add = (pkg) => {
    const existing = merged.get(pkg.name);
    if (existing) {
      existing.hooks = [...new Set([...existing.hooks, ...pkg.hooks])];
      existing.version = existing.version === 'unknown' ? pkg.version : existing.version;
    } else {
      merged.set(pkg.name, { ...pkg });
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
    const allow = Object.fromEntries(found.map((pkg) => [pkg.name, pkg.version]));
    writeFileSync(ALLOWLIST, `${JSON.stringify({ allow }, null, 2)}\n`);
    console.log(`Allowlisted ${found.length} package(s): ${Object.keys(allow).join(', ') || '(none)'}`);
    return;
  }
  if (!existsSync(ALLOWLIST)) {
    console.error('build-scripts/install-scripts.json is missing — generate it with: npm run check:scripts -- --write');
    process.exit(1);
  }
  const { allow } = JSON.parse(readFileSync(ALLOWLIST, 'utf8'));
  const { problems, stale } = compare(found, allow ?? {});
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
  console.log(
    `Install scripts OK: ${found.length} package(s) — ${found.map((p) => `${p.name}@${p.version} (${p.hooks.join(', ')})`).join(', ') || '(none)'}`
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
