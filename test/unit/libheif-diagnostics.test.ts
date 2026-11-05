import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// The neutralizer is a fail-closed supply-chain guard: silent failure ships a
// ~55 KB-gz regression. Test it like a security control on synthetic trees
// (so CI runs it without submodules; same discipline as
// `install-scripts.test.ts`): must stub, must refuse, must stay byte-stable.

const SCRIPT = fileURLToPath(
  new URL('../../build-scripts/neutralize-libheif-diagnostics.py', import.meta.url),
);

function runNeutralizer(cwd: string) {
  const res = spawnSync('python3', [SCRIPT], { cwd, encoding: 'utf-8' });
  if (res.error) throw new Error(`python3 could not run (required by the build too): ${res.error.message}`);
  return res;
}

/** Realistic diagnostic definitions: string/comment braces test `match_body`. */
function dumpDefs(count: number, start = 0): string {
  return Array.from(
    { length: count },
    (_unused, i) => `void Box_${i + start}::dump(std::ostream& s, Indent& indent, bool full_log) const
{
  std::stringstream sstr;
  sstr << "box ${i + start} {"; // trailing } hides in a comment
}
`,
  ).join('\n');
}

const DEBUG_INFO_DEFS = `std::string Box_meta::get_debug_info() const
{
  std::stringstream sstr;
  sstr << "meta";
  return sstr.str();
}
`;

const HEIF_IMAGE_CC = `void heif_image_create()
{
  std::cerr << "libheif warning: illegal colorspace";
}
`;

interface Tree {
  /** Dir to pass as `cwd`: the script's `ROOTS` entry 'libheif' resolves under it. */
  cwd: string;
  /** The located tree root (`cwd/libheif`). */
  root: string;
}

function makeTree(opts: {
  boxCc: string;
  heifImageCc?: string | null;
  extra?: Record<string, string>;
}): Tree {
  const cwd = mkdtempSync(path.join(tmpdir(), 'neutralize-'));
  const root = path.join(cwd, 'libheif'); // `ROOTS`: 'libheif' + 'libheif/box.cc'
  const write = (rel: string, content: string) => {
    const target = path.join(root, rel);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  };
  write('libheif/box.cc', opts.boxCc);
  if (opts.heifImageCc !== null) {
    write('libheif/api/libheif/heif_image.cc', opts.heifImageCc ?? HEIF_IMAGE_CC);
  }
  for (const [rel, content] of Object.entries(opts.extra ?? {})) write(rel, content);
  return { cwd, root };
}

describe('neutralize-libheif-diagnostics.py', () => {
  const tmpDirs: string[] = [];
  let healthy: Tree;

  beforeAll(() => {
    // 100 defs in `box.cc`: exactly the `MIN_STUBS` floor, all from the sanity
    // file.
    healthy = makeTree({ boxCc: dumpDefs(99) + DEBUG_INFO_DEFS });
    tmpDirs.push(healthy.cwd);
    const res = runNeutralizer(healthy.cwd);
    expect(res.status, res.stderr).toBe(0);
  });

  afterAll(() => {
    for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  });

  function fresh(
    opts: Parameters<typeof makeTree>[0],
  ): { tree: Tree; status: number; stdout: string; stderr: string } {
    const tree = makeTree(opts);
    tmpDirs.push(tree.cwd);
    const res = runNeutralizer(tree.cwd);
    return { tree, status: res.status ?? -1, stdout: res.stdout, stderr: res.stderr };
  }

  it('stubs bodies, keeps signatures, empties the get_debug_info bodies', () => {
    const boxCc = readFileSync(path.join(healthy.root, 'libheif/box.cc'), 'utf-8');
    expect(boxCc).toContain('void Box_0::dump(std::ostream& s, Indent& indent, bool full_log) const\n{\n}');
    expect(boxCc).toContain('std::string Box_meta::get_debug_info() const\n{\n  return "";\n}');
    // Stream-heavy bodies (brace-in-string/comment payloads included) are gone.
    expect(boxCc).not.toContain('stringstream');
    expect(boxCc).not.toMatch(/box \d+ \{/);
  });

  it('drops the live-path std::cerr statement', () => {
    const imageCc = readFileSync(path.join(healthy.root, 'libheif/api/libheif/heif_image.cc'), 'utf-8');
    expect(imageCc).not.toContain('std::cerr');
    expect(imageCc).toContain('void heif_image_create()');
  });

  it('is idempotent — a second run rewrites identical bytes', () => {
    const boxCcPath = path.join(healthy.root, 'libheif/box.cc');
    const before = readFileSync(boxCcPath);
    const res = runNeutralizer(healthy.cwd);
    expect(res.status, res.stderr).toBe(0);
    expect(readFileSync(boxCcPath).equals(before)).toBe(true);
  });

  it('refuses a tree below the stub floor', () => {
    const { status, stderr } = fresh({ boxCc: dumpDefs(5) });
    expect(status).toBe(1);
    expect(stderr).toContain('floor');
  });

  it('refuses when box.cc contributes no stubs (sanity guard)', () => {
    // 100 defs live in another file; `box.cc` holds only declarations, which
    // must also survive untouched (trailing ';' never matches `HEADER`).
    const declarations = 'void Box_decl::dump(std::ostream&, Indent&, bool) const;\n';
    const { tree, status, stderr } = fresh({
      boxCc: declarations,
      extra: { 'libheif/other_boxes.cc': dumpDefs(100) },
    });
    expect(status).toBe(1);
    expect(stderr).toContain('box.cc');
    expect(readFileSync(path.join(tree.root, 'libheif/box.cc'), 'utf-8')).toBe(declarations);
  });

  it('refuses when the live-path cerr file moved (layout guard)', () => {
    const { status, stderr } = fresh({ boxCc: dumpDefs(100), heifImageCc: null });
    expect(status).toBe(1);
    expect(stderr).toContain('heif_image.cc');
  });

  it('exits loudly on a definition without any body or a braceless body', () => {
    // Both safety-net branches: `str.find('{')` returning -1 (the branch that
    // used to test against None and could not fire) and `match_body` returning
    // None on an unclosed body.
    const noBody = fresh({ boxCc: dumpDefs(99) + 'void Box_ghost::dump() const\n' });
    expect(noBody.status).toBe(1);
    expect(noBody.stderr).toContain('definition without a body');

    const unbalanced = fresh({ boxCc: dumpDefs(99) + 'void Box_open::dump() const\n{\n  missing brace\n' });
    expect(unbalanced.status).toBe(1);
    expect(unbalanced.stderr).toContain('unbalanced body');
  });

  it('refuses outright when no libheif tree is present at all', () => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'neutralize-empty-'));
    tmpDirs.push(cwd);
    const res = runNeutralizer(cwd);
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('git submodule update');
  });
});
