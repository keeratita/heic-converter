import { describe, it, expect, beforeAll, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { convertHeic, LibheifDecoder } from '../../src/index';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const WASM_PATH = path.resolve(__dirname, '../../dist/heic-decoder.wasm');
const FIXTURE_PATH = path.resolve(__dirname, '../fixtures/example.heic');
const ALPHA_FIXTURE_PATH = path.resolve(__dirname, '../fixtures/colors-with-alpha.heic');
const ORIENTED_FIXTURE_PATH = path.resolve(__dirname, '../fixtures/exif-orientation-6.heic');
const IROT_FIXTURE_PATH = path.resolve(__dirname, '../fixtures/irot-orientation-6.heic');

const hasWasm = fs.existsSync(WASM_PATH);
const hasFixture =
  fs.existsSync(FIXTURE_PATH) &&
  fs.existsSync(ALPHA_FIXTURE_PATH) &&
  fs.existsSync(ORIENTED_FIXTURE_PATH) &&
  fs.existsSync(IROT_FIXTURE_PATH);
const isCI = typeof process !== 'undefined' && !!process.env.CI;

if (!hasWasm || !hasFixture) {
  if (isCI) {
    // CI must never silently skip the real-WASM pipeline: a missing build or
    // artifact would hide regressions. Let beforeAll crash the suite instead.
    console.error(
      '[integration] dist/heic-decoder.wasm or test fixtures are missing in CI — this suite will FAIL.'
    );
  } else {
    console.warn(
      '[integration] Real-WASM integration suite is SKIPPED because dist/heic-decoder.wasm or test/fixtures are missing — run `npm run build` first.'
    );
  }
}

/**
 * Integration tests exercising the real WASM decoder with a real HEIC fixture.
 *
 * These run in Node, which can decode but not canvas-encode (see the last
 * test). Outside CI they are skipped automatically when build artifacts or
 * fixtures are missing (run `npm run build` first); on CI they fail hard.
 */
describe.skipIf((!hasWasm || !hasFixture) && !isCI)('Integration Tests - Real WASM Pipeline', () => {
  let heicBytes: Uint8Array;
  let wasmBinary: ArrayBuffer;

  beforeAll(() => {
    heicBytes = new Uint8Array(fs.readFileSync(FIXTURE_PATH));
    // In Node the WASM must be provided explicitly (no fetch); the browser
    // loads it via locateFile/fetch instead.
    wasmBinary = fs.readFileSync(WASM_PATH).buffer;
  });

  it('should decode a real HEIC fixture with the real WASM decoder', async () => {
    const decoder = new LibheifDecoder({ wasmBinary });
    await decoder.initialize();
    const decoded = await decoder.decode(heicBytes);

    expect(decoded).toBeDefined();
    expect(decoded.width).toBeGreaterThan(0);
    expect(decoded.height).toBeGreaterThan(0);
    expect(decoded.data).toBeInstanceOf(Uint8ClampedArray);
    expect(decoded.data.length).toBe(decoded.width * decoded.height * 4);
  });

  it('should return pixel data that outlives the decoder (owned copy, not a WASM view)', async () => {
    const decoder = new LibheifDecoder({ wasmBinary });
    await decoder.initialize();
    const decoded = await decoder.decode(heicBytes);

    decoder.free();

    // The data must stay fully readable after the decoder (and its WASM heap) is freed.
    expect(decoded.data.length).toBe(decoded.width * decoded.height * 4);
    expect(decoded.data.every((byte) => byte >= 0 && byte <= 255)).toBe(true);
  });

  it('should keep earlier decode results intact when the same decoder decodes again', async () => {
    const decoder = new LibheifDecoder({ wasmBinary });
    await decoder.initialize();

    const first = await decoder.decode(heicBytes);
    const firstBytes = Array.from(first.data);

    // A second decode on the same instance must not corrupt the first result.
    // This pins the owned-copy semantics: a future main.cpp that returns a
    // typed_memory_view over the heap would fail this test.
    await decoder.decode(heicBytes);

    expect(Array.from(first.data)).toEqual(firstBytes);
    expect(first.data.length).toBe(first.width * first.height * 4);
  });

  it('should decode a real alpha channel from the colors-with-alpha fixture', async () => {
    const decoder = new LibheifDecoder({ wasmBinary });
    await decoder.initialize();
    const decoded = await decoder.decode(new Uint8Array(fs.readFileSync(ALPHA_FIXTURE_PATH)));

    // 64x64 fixture; assert the alpha channel is wired and varied: at least one
    // fully opaque pixel and one semitransparent pixel. A channel-order or
    // alpha-plane regression (WASM rebuild) would fail this.
    expect(decoded.width).toBe(64);
    expect(decoded.height).toBe(64);
    let opaque = 0;
    let semiTransparent = 0;
    for (let i = 3; i < decoded.data.length; i += 4) {
      if (decoded.data[i] === 255) {
        opaque++;
      } else if (decoded.data[i] > 0) {
        semiTransparent++;
      }
    }
    expect(opaque).toBeGreaterThan(0);
    expect(semiTransparent).toBeGreaterThan(0);
  });

  it('should report progress callbacks during a real decode', async () => {
    const decoder = new LibheifDecoder({ wasmBinary });
    await decoder.initialize();

    const progressValues: number[] = [];
    await decoder.decode(heicBytes, (percent) => progressValues.push(percent));

    expect(progressValues.length).toBeGreaterThan(0);
    expect(progressValues[0]).toBeGreaterThanOrEqual(0);
    expect(progressValues[progressValues.length - 1]).toBe(100);
    progressValues.forEach((value) => {
      expect(Number.isFinite(value)).toBe(true);
      // Documented onProgress contract: normalized into [0, 100].
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(100);
    });
  });

  it('reports EXIF orientation 6 for a file whose only display transform is the Exif tag', async () => {
    // Fixture: stored 1600x1200 landscape, EXIF tag 274 = 6, no irot/imir
    // boxes — the class produced by editors that only rewrite EXIF. libheif
    // cannot apply a transform the container does not carry, so the wrapper
    // surfaces the tag and the canvas layer applies it during rendering.
    const decoder = new LibheifDecoder({ wasmBinary });
    await decoder.initialize();
    const decoded = await decoder.decode(new Uint8Array(fs.readFileSync(ORIENTED_FIXTURE_PATH)));

    expect(decoded.width).toBe(1600);
    expect(decoded.height).toBe(1200);
    expect(decoded.orientation).toBe(6);
    decoder.free();
  });

  it('reports no pending orientation when libheif already applied the irot transform', async () => {
    // Fixture: same content stored landscape with an irot 90 box (+ EXIF tag).
    // libheif applies irot at decode (dimensions come back swapped); the
    // wrapper must not stack the EXIF tag on top — double-rotation guard.
    const decoder = new LibheifDecoder({ wasmBinary });
    await decoder.initialize();
    const decoded = await decoder.decode(new Uint8Array(fs.readFileSync(IROT_FIXTURE_PATH)));

    expect(decoded.width).toBe(1200);
    expect(decoded.height).toBe(1600);
    expect(decoded.orientation).toBeUndefined();
    decoder.free();
  });

  describe('EXIF passthrough (DecodedImage.exif)', () => {
    const EXIF_MARKER = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00]; // "Exif\0\0"

    const decodeFixture = async (file: string) => {
      const decoder = new LibheifDecoder({ wasmBinary });
      await decoder.initialize();
      const decoded = await decoder.decode(new Uint8Array(fs.readFileSync(file)));
      return { decoder, decoded };
    };

    const expectExifBlock = (exif: Uint8Array | undefined): Uint8Array => {
      expect(exif).toBeInstanceOf(Uint8Array);
      const block = exif as Uint8Array;
      expect(block.length).toBeGreaterThanOrEqual(14); // marker + minimal TIFF
      expect(Array.from(block.subarray(0, 6))).toEqual(EXIF_MARKER);
      const le = block[6] === 0x49 && block[7] === 0x49;
      const be = block[6] === 0x4d && block[7] === 0x4d;
      expect(le || be).toBe(true);
      const magic = le
        ? block[8] | (block[9] << 8)
        : (block[8] << 8) | block[9];
      expect(magic).toBe(42);
      return block;
    };

    it('exposes the normalized "Exif\\0\\0"+TIFF block for Exif-item files', async () => {
      const { decoder, decoded } = await decodeFixture(ORIENTED_FIXTURE_PATH);
      const block = expectExifBlock(decoded.exif);
      // The fixture carries orientation 6: the 0x0112 entry must be inside
      // the preserved TIFF (byte order per the TIFF header).
      const le = block[6] === 0x49;
      const tag = le ? [0x12, 0x01] : [0x01, 0x12];
      const found = Array.from(block).some(
        (_, i) => block[i] === tag[0] && block[i + 1] === tag[1]
      );
      expect(found).toBe(true);
      decoder.free();
    });

    it('reports the Exif block even when irot already drove orientation (preservation is unguarded)', async () => {
      // Apple-style fixture: irot/imir present means orientation stays
      // undefined, but the Exif item still exists and must be exposed for
      // preserveExif consumers.
      const { decoder, decoded } = await decodeFixture(IROT_FIXTURE_PATH);
      expect(decoded.orientation).toBeUndefined();
      expectExifBlock(decoded.exif);
      decoder.free();
    });

    it('omits the exif field for files without an Exif item', async () => {
      const { decoder, decoded } = await decodeFixture(FIXTURE_PATH);
      expect(decoded.exif).toBeUndefined();
      decoder.free();
    });

    it('keeps the exif block fully readable after the decoder is freed', async () => {
      const { decoder, decoded } = await decodeFixture(ORIENTED_FIXTURE_PATH);
      const copy = decoded.exif ? Array.from(decoded.exif) : undefined;
      decoder.free();

      // Owned copy: still matches what was read before free(), never a
      // dangling WASM-heap view (which would read zeros after memory reuse).
      expect(decoded.exif && Array.from(decoded.exif)).toEqual(copy);
      expect(copy && copy.length).toBeGreaterThanOrEqual(14);
    });
  });

  it('should reject convertHeic in Node.js environments (no canvas) with a clear error', async () => {
    // convertHeic needs canvas APIs for encoding, which Node.js lacks — this is
    // documented behavior: Node users decode raw RGBA and encode externally.
    // The environment probe runs before decoding, so the injected decoder must
    // not even be initialized (fail fast, no wasted WASM load/decode).
    const decoder = new LibheifDecoder({ wasmBinary });
    const initSpy = vi.spyOn(decoder, 'initialize');

    const error = await convertHeic(heicBytes, { to: 'png', decoder }).catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain('Canvas is not supported');
    expect(error.code).toBe('unsupported_environment');
    expect(initSpy).not.toHaveBeenCalled();
  });
});
