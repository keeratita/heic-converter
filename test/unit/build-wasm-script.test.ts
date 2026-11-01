import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * build-wasm.sh runs its critical path inside `docker run ... bash -c "..."`
 * with `set -e`, and the sentinel check only proves the LAST line ran. A
 * middle command failing silently is therefore invisible to the sentinel —
 * exactly what `cmd && cmd2` does: set -e ignores a failure before the final
 * && of a list. Observed in the wild: a failed post-link wasm-opt skipped its
 * mv, the build reported success, and the copied artifact lacked
 * --zero-filled-memory (only the artifact-hash gate caught it).
 */
describe('build-wasm.sh failure semantics', () => {
  const script = readFileSync('build-scripts/build-wasm.sh', 'utf8');

  it('runs the post-link wasm-opt as a separate statement (no && it to mv)', () => {
    const line = script.split('\n').find((l) => l.includes('/emsdk/upstream/bin/wasm-opt '));
    expect(line).toBeDefined();
    expect(line).not.toContain('&&');
    // ...and its output really is moved into place afterwards.
    expect(script).toContain(
      'mv /src/build-wasm/wrapper/heic-decoder.wasm.opt /src/build-wasm/wrapper/heic-decoder.wasm'
    );
  });

  it('fails closed when the linker map is missing', () => {
    // A missing map must not let the grep's exit code 2 read as "no iostream".
    expect(script).toContain('[ ! -s /src/build-wasm/wrapper/heic-decoder.map ]');
  });

  it('fails closed when libc++ iostream objects get linked (diagnostics shim guard)', () => {
    expect(script).toContain("(iostream|new_helpers)");
    expect(script).toContain('Build complete!');
  });
});
