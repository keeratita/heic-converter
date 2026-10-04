import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { HeicConverterError, LibheifDecoder } from '../../src/index';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '../..');
const WASM_PATH = path.join(ROOT_DIR, 'dist/heic-decoder.wasm');
const FIXTURE_DIR = path.join(ROOT_DIR, 'test/fixtures');

const isCI = typeof process !== 'undefined' && !!process.env.CI;

/**
 * Output goldens for the committed WASM. Smaller-build work here has repeatedly
 * produced a decoder that only failed at execution, and a codegen regression in
 * libde265's IDCT / loop-filter / intra-prediction paths still yields a
 * *decodable* image with wrong pixels — so pin the exact RGBA, dimensions,
 * pending orientation and EXIF length rather than asking "does it decode?".
 */

type FixtureGolden = {
  width: number;
  height: number;
  orientation: number | null;
  exifBytes: number;
  rgbaSha256: string;
};

const FIXTURE_GOLDENS: Record<string, FixtureGolden> = {
  'example.heic': {
    width: 1280,
    height: 854,
    orientation: null,
    exifBytes: 0,
    rgbaSha256: '7f8f77c3e33f64338ebea81ce0102de5a0cf132061bef3176cad0373d7bada3b'
  },
  'colors-no-alpha.heic': {
    width: 64,
    height: 64,
    orientation: null,
    exifBytes: 0,
    rgbaSha256: 'f12be98279dea77c10af45bc315092823b1372f7a36f963e2c306e31baf0b23e'
  },
  'colors-with-alpha.heic': {
    width: 64,
    height: 64,
    orientation: null,
    exifBytes: 0,
    rgbaSha256: '982fb5bbb412504392531a9bb8e5ad3a217f31eaa53a2c941be3ac4af75dcc88'
  },
  'exif-orientation-6.heic': {
    width: 1600,
    height: 1200,
    orientation: 6,
    exifBytes: 32,
    rgbaSha256: '2000e8366c8a9aaef034018357d9b9d51741606eeb7fcb18085bd6388a7aa9ad'
  },
  'irot-orientation-6.heic': {
    width: 1200,
    height: 1600,
    orientation: null,
    exifBytes: 32,
    rgbaSha256: 'ca12eb7a0dee9e38d6b227382e18573548a19b7624774ef539456cd244c3ac45'
  }
};

/**
 * Expected outcome per mutated input: `OK:<first 12 hex of RGBA sha256>` or
 * `ERR:<error code>`. Regenerate with the decoder after an intentional change to
 * the fixtures or the decode pipeline — never adjust a single entry to make a
 * build pass.
 */
const MUTATION_GOLDENS: Record<string, string> = {
  'example.heic:full': 'OK:7f8f77c3e33f',
  'example.heic:trunc0.25': 'ERR:decode_failed',
  'example.heic:trunc0.5': 'OK:7f8f77c3e33f',
  'example.heic:trunc0.75': 'OK:7f8f77c3e33f',
  'example.heic:trunc0.999': 'OK:7f8f77c3e33f',
  'example.heic:empty': 'ERR:decode_failed',
  'example.heic:garbage': 'ERR:decode_failed',
  'example.heic:headeronly': 'ERR:decode_failed',
  'example.heic:flip0@211555': 'OK:b702717a86d0',
  'example.heic:flip1@582992': 'OK:7f8f77c3e33f',
  'example.heic:flip2@364517': 'OK:7f8f77c3e33f',
  'example.heic:flip3@493899': 'OK:7f8f77c3e33f',
  'example.heic:flip4@215364': 'OK:afc90bc1d210',
  'example.heic:flip5@591003': 'OK:7f8f77c3e33f',
  'example.heic:flip6@313145': 'OK:71a7b5272e81',
  'example.heic:flip7@649731': 'OK:7f8f77c3e33f',
  'example.heic:flip8@228053': 'OK:30c2813347c2',
  'example.heic:flip9@320989': 'OK:78854fae0e65',
  'example.heic:flip10@93693': 'OK:24c1b62e2e93',
  'example.heic:flip11@578008': 'OK:7f8f77c3e33f',
  'example.heic:flip12@450568': 'OK:7f8f77c3e33f',
  'example.heic:flip13@341895': 'OK:7f8f77c3e33f',
  'colors-with-alpha.heic:full': 'OK:982fb5bbb412',
  'colors-with-alpha.heic:trunc0.25': 'ERR:decode_failed',
  'colors-with-alpha.heic:trunc0.5': 'ERR:decode_failed',
  'colors-with-alpha.heic:trunc0.75': 'ERR:decode_failed',
  'colors-with-alpha.heic:trunc0.999': 'ERR:decode_failed',
  'colors-with-alpha.heic:empty': 'ERR:decode_failed',
  'colors-with-alpha.heic:garbage': 'ERR:decode_failed',
  'colors-with-alpha.heic:headeronly': 'ERR:decode_failed',
  'colors-with-alpha.heic:flip0@576': 'OK:982fb5bbb412',
  'colors-with-alpha.heic:flip1@472': 'ERR:decode_failed',
  'colors-with-alpha.heic:flip2@24': 'ERR:decode_failed',
  'colors-with-alpha.heic:flip3@120': 'OK:982fb5bbb412',
  'colors-with-alpha.heic:flip4@184': 'OK:982fb5bbb412',
  'colors-with-alpha.heic:flip5@528': 'ERR:decode_failed',
  'colors-with-alpha.heic:flip6@744': 'OK:d16964bef7e2',
  'colors-with-alpha.heic:flip7@96': 'OK:982fb5bbb412',
  'colors-with-alpha.heic:flip8@352': 'ERR:decode_failed',
  'colors-with-alpha.heic:flip9@368': 'OK:f12be98279de',
  'colors-with-alpha.heic:flip10@392': 'OK:982fb5bbb412',
  'colors-with-alpha.heic:flip11@72': 'ERR:decode_failed',
  'colors-with-alpha.heic:flip12@144': 'OK:982fb5bbb412',
  'colors-with-alpha.heic:flip13@296': 'ERR:decode_failed',
  'exif-orientation-6.heic:full': 'OK:2000e8366c8a',
  'exif-orientation-6.heic:trunc0.25': 'ERR:decode_failed',
  'exif-orientation-6.heic:trunc0.5': 'ERR:decode_failed',
  'exif-orientation-6.heic:trunc0.75': 'ERR:decode_failed',
  'exif-orientation-6.heic:trunc0.999': 'ERR:decode_failed',
  'exif-orientation-6.heic:empty': 'ERR:decode_failed',
  'exif-orientation-6.heic:garbage': 'ERR:decode_failed',
  'exif-orientation-6.heic:headeronly': 'ERR:decode_failed',
  'exif-orientation-6.heic:flip0@7514': 'OK:52e1e27a4691',
  'exif-orientation-6.heic:flip1@1838': 'OK:e2bd2a43f048',
  'exif-orientation-6.heic:flip2@1574': 'OK:058d70b434fb',
  'exif-orientation-6.heic:flip3@8140': 'OK:20759b148ce1',
  'exif-orientation-6.heic:flip4@966': 'OK:cc706eadf42d',
  'exif-orientation-6.heic:flip5@10104': 'OK:3735bf6023e2',
  'exif-orientation-6.heic:flip6@2760': 'OK:438a0cf4aaf0',
  'exif-orientation-6.heic:flip7@4552': 'OK:3dc001a0e4ff',
  'exif-orientation-6.heic:flip8@5984': 'OK:45b4a7378291',
  'exif-orientation-6.heic:flip9@8714': 'OK:6447527aa14d',
  'exif-orientation-6.heic:flip10@10284': 'OK:f3948b897822',
  'exif-orientation-6.heic:flip11@1832': 'OK:acc7688c9147',
  'exif-orientation-6.heic:flip12@2688': 'OK:b9b194a11532',
  'exif-orientation-6.heic:flip13@12794': 'OK:f3a28db4364b'
};

// Derived from the golden table: a fixture added there is automatically
// required on disk (and vice versa, checked below), so the two lists cannot
// drift the way a hand-maintained copy does.
const FIXTURE_NAMES = Object.keys(FIXTURE_GOLDENS);
const hasArtifacts =
  fs.existsSync(WASM_PATH) && FIXTURE_NAMES.every((f) => fs.existsSync(path.join(FIXTURE_DIR, f)));

if (!hasArtifacts && isCI) {
  console.error(
    '[wasm-golden] dist/heic-decoder.wasm or test fixtures are missing in CI — this suite will FAIL.'
  );
}

const sha256 = async (bytes: Uint8Array | Uint8ClampedArray): Promise<string> => {
  const { createHash } = await import('crypto');
  return createHash('sha256')
    .update(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length))
    .digest('hex');
};

const decodeFresh = async (bytes: Uint8Array) => {
  const decoder = new LibheifDecoder({ wasmBinary: fs.readFileSync(WASM_PATH) });
  try {
    await decoder.initialize();
    return await decoder.decode(bytes);
  } finally {
    decoder.free();
  }
};

/**
 * Builds the mutated inputs behind MUTATION_GOLDENS. The generator and the label
 * format must stay in lockstep with the table: a single deterministic LCG seeded
 * with 0x5eed, consumed in the same order the table was produced.
 */
const buildMutations = (): Array<[string, Uint8Array]> => {
  let seed = 0x5eed;
  const rnd = (n: number): number => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  const inputs: Array<[string, Uint8Array]> = [];
  for (const name of ['example.heic', 'colors-with-alpha.heic', 'exif-orientation-6.heic']) {
    const bytes = fs.readFileSync(path.join(FIXTURE_DIR, name));
    inputs.push([`${name}:full`, new Uint8Array(bytes)]);
    for (const frac of [0.25, 0.5, 0.75, 0.999]) {
      inputs.push([
        `${name}:trunc${frac}`,
        new Uint8Array(bytes.subarray(0, Math.max(1, Math.floor(bytes.length * frac))))
      ]);
    }
    inputs.push([`${name}:empty`, new Uint8Array(0)]);
    inputs.push([`${name}:garbage`, new Uint8Array(64).fill(0xff)]);
    inputs.push([`${name}:headeronly`, new Uint8Array(bytes.subarray(0, 12))]);
    for (let i = 0; i < 14; i++) {
      const copy = Uint8Array.from(bytes);
      const pos = 24 + rnd(Math.max(1, copy.length - 25));
      copy[pos] ^= 1 << rnd(8);
      inputs.push([`${name}:flip${i}@${pos}`, copy]);
    }
  }
  return inputs;
};

/**
 * Guards the golden tables themselves, independent of the artifacts: a bulk
 * edit here (renumbered labels, a dropped column, one outcome silently
 * deleted) would leave every decode assertion comparing against nonsense.
 */
describe('golden tables are well-formed', () => {
  it('pins every fixture on disk, and only those', () => {
    const onDisk = fs.readdirSync(FIXTURE_DIR).filter((f) => f.endsWith('.heic')).sort();
    expect([...FIXTURE_NAMES].sort()).toEqual(onDisk);
  });

  it('encodes each mutation outcome as an error code or a hash prefix', () => {
    const entries = Object.entries(MUTATION_GOLDENS);
    const malformed = entries.filter(
      ([, golden]) => !/^ERR:[a-z_]+$/.test(golden) && !/^OK:[0-9a-f]{12}$/.test(golden)
    );
    expect(malformed, `malformed goldens: ${JSON.stringify(malformed.slice(0, 3))}`).toEqual([]);
    const unknown = entries.filter(([label]) => !FIXTURE_NAMES.includes(label.split(':')[0] ?? ''));
    expect(
      unknown,
      `labels for unknown fixtures: ${unknown.map(([label]) => label).join(', ')}`
    ).toEqual([]);
    // Both outcomes must be represented, or the table cannot notice a decoder
    // that decodes everything (or refuses everything).
    expect(entries.filter(([, g]) => g.startsWith('ERR:')).length).toBeGreaterThan(10);
    expect(entries.filter(([, g]) => g.startsWith('OK:')).length).toBeGreaterThan(10);
  });
});

// 30s per test: each of these instantiates the real module per input (5
// fixtures, 66 mutations, 41 truncations), and under the parallel suite the
// default 5s is close enough to the edge to flake — a flaking real-decode
// suite gets ignored, which defeats its entire purpose.
describe.skipIf(!hasArtifacts && !isCI)('WASM output goldens', { timeout: 30_000 }, () => {
  it('decodes every fixture to the golden dimensions, orientation and RGBA', async () => {
    for (const [name, golden] of Object.entries(FIXTURE_GOLDENS)) {
      const decoded = await decodeFresh(fs.readFileSync(path.join(FIXTURE_DIR, name)));
      expect([decoded.width, decoded.height, decoded.orientation ?? null, decoded.exif?.length ?? 0]).toEqual(
        [golden.width, golden.height, golden.orientation, golden.exifBytes]
      );
      expect(await sha256(decoded.data)).toBe(golden.rgbaSha256);
    }
  });

  it('reproduces the golden outcome for every mutated input', async () => {
    const mismatches: string[] = [];
    for (const [label, bytes] of buildMutations()) {
      const expected = MUTATION_GOLDENS[label];
      expect(expected, `no golden recorded for ${label}`).toBeTypeOf('string');
      let actual: string;
      try {
        const decoded = await decodeFresh(bytes);
        actual = `OK:${(await sha256(decoded.data)).slice(0, 12)}`;
      } catch (error) {
        actual = `ERR:${error instanceof HeicConverterError ? error.code : 'untyped'}`;
      }
      if (actual !== expected) {
        mismatches.push(`${label}: expected ${expected}, got ${actual}`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('reports malformed input as a typed error, never as a module abort', async () => {
    const aborts: string[] = [];
    for (const [label, bytes] of buildMutations()) {
      try {
        await decodeFresh(bytes);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // An abort inside the module surfaces as a raw WebAssembly.RuntimeError
        // and leaves it unusable; the contract is a typed HeicConverterError.
        if (!(error instanceof HeicConverterError) || /Aborted|RuntimeError/.test(message)) {
          aborts.push(`${label}: ${error instanceof Error ? `${error.constructor.name}: ${message}` : message}`);
        }
      }
    }
    expect(aborts).toEqual([]);
  });

  it('survives a dense truncation sweep without aborting or wedging the module', async () => {
    // The table above samples truncation at four ratios; this sweeps the box
    // parser much finer — every offset in the container header plus a linear
    // pass over the file. Two invariants a miscompile can break while "it
    // decodes" still passes: malformed input must yield sane dimensions or a
    // typed error (never RuntimeError/abort), and the shared Emscripten module
    // must still decode a good file afterwards rather than stay wedged.
    const bytes = fs.readFileSync(path.join(FIXTURE_DIR, 'example.heic'));
    const offsets = [
      ...[1, 2, 3, 4, 6, 8, 10, 12, 16, 20, 24, 28, 32, 40, 48, 56, 64],
      ...Array.from({ length: 24 }, (_, i) => Math.floor(((i + 1) * bytes.length) / 25)),
    ];

    const problems: string[] = [];
    let decoded = 0;
    let refused = 0;
    for (const at of offsets) {
      const truncated = new Uint8Array(bytes.subarray(0, at));
      try {
        const result = await decodeFresh(truncated);
        decoded += 1;
        if (!(result.width > 0) || !(result.height > 0) || result.data.length !== result.width * result.height * 4) {
          problems.push(`offset ${at}: decoded ${result.width}x${result.height}, ${result.data.length} bytes`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!(error instanceof HeicConverterError) || /Aborted|RuntimeError/.test(message)) {
          problems.push(`offset ${at}: ${error instanceof Error ? `${error.constructor.name}: ${message}` : message}`);
        } else {
          refused += 1;
        }
      }
    }

    expect(problems).toEqual([]);
    // The sweep must actually have exercised both outcomes, or it proves nothing.
    expect(refused, 'no truncation was refused — the sweep degenerated').toBeGreaterThan(0);
    expect(decoded, 'every truncation failed — fixtures or decoder changed').toBeGreaterThan(0);

    // And the module is still healthy afterwards.
    const healthy = await decodeFresh(fs.readFileSync(path.join(FIXTURE_DIR, 'example.heic')));
    expect(await sha256(healthy.data)).toBe(FIXTURE_GOLDENS['example.heic'].rgbaSha256);
  });
});
