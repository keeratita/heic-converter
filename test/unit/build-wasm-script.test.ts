import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * The critical path runs inside `docker run ... bash -c "..."` with `set -e`,
 * and the sentinel only proves the LAST line ran — a silently failing middle
 * command is invisible to it. That is exactly what `cmd && cmd2` does: `set -e`
 * ignores a failure before the final `&&`. Observed: a failed post-link
 * `wasm-opt` skipped its `mv`, the build reported success, and the copied
 * artifact lacked `--zero-filled-memory` (only the artifact-hash gate caught
 * it).
 */
describe('build-wasm.sh failure semantics', () => {
  const script = readFileSync('build-scripts/build-wasm.sh', 'utf8');

  it('runs the post-link wasm-opt as a separate statement (no && it to mv)', () => {
    const line = script.split('\n').find((l) => l.includes('/emsdk/upstream/bin/wasm-opt '));
    expect(line).toBeDefined();
    expect(line).not.toContain('&&');
    // And its output really is moved into place afterwards.
    expect(script).toContain(
      'mv /src/build-wasm/wrapper/heic-decoder.wasm.opt /src/build-wasm/wrapper/heic-decoder.wasm'
    );
  });

  it('fails closed when the linker map is missing', () => {
    // A missing map must not let grep's exit code 2 read as "no streams".
    expect(script).toContain('[ ! -s /src/build-wasm/wrapper/heic-decoder.map ]');
  });

  it('fails closed when libc++ iostream objects get linked (diagnostics shim guard)', () => {
    expect(script).toContain("(iostream|ostream|strstream)");
    expect(script).toContain('Build complete!');
  });

  it('compiles both archives with -Oz and -DNDEBUG', () => {
    // Dropping -DNDEBUG is a silent 5,877 B gz (2.4%) payload regression, and
    // the 300 KB WASM ceilings are deliberately too loose to notice; -Oz loss
    // costs far more. The cache stamps key on this file, so either flag moving
    // forces both libraries to rebuild rather than relinking stale archives.
    const flags = script.match(/-DCMAKE_C(?:XX)?_FLAGS=\\"[^"]*\\"/g) ?? [];
    expect(flags).toHaveLength(4); // libde265 + libheif, C and CXX each
    expect(flags.every((f) => f.includes('-Oz') && f.includes('-DNDEBUG'))).toBe(true);
  });

  it('pins the toolchain to an immutable image tag, never a floating one', () => {
    // `emscripten/emsdk:latest` would make `wasm-artifacts.json` unverifiable:
    // the same commit would rebuild to different bytes whenever upstream ships,
    // and the provenance job would fail with no way to reproduce the green run.
    const emsdk = script.match(/EMSDK_VERSION="([^"]*)"/)?.[1];
    expect(emsdk).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

/**
 * `WASM_DEPENDENCIES.md` restates the three pins as prose and a table. Repo
 * convention is that a doc which duplicates a code fact is tested, not trusted
 * — an unstamped table is how a bump ends up shipping with docs describing the
 * previous release.
 */
describe('WASM_DEPENDENCIES.md pin table', () => {
  const script = readFileSync('build-scripts/build-wasm.sh', 'utf8');
  const doc = readFileSync('WASM_DEPENDENCIES.md', 'utf8');
  const pin = (name: string): string => {
    const value = script.match(new RegExp(`${name}="([^"]*)"`))?.[1];
    if (!value) {
      throw new Error(`${name} is missing from build-scripts/build-wasm.sh`);
    }
    return value;
  };

  it('states the same libheif and libde265 versions the script builds', () => {
    expect(doc).toContain(`| libheif | ${pin('LIBHEIF_VERSION')} |`);
    expect(doc).toContain(`| libde265 | ${pin('LIBDE265_VERSION')} |`);
  });

  it('states the same emsdk version the script pulls', () => {
    expect(doc).toContain(`**${pin('EMSDK_VERSION')}**`);
  });
});
