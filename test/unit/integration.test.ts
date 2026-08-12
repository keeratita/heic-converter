import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { convertHeic, LibheifDecoder } from '../../src/index';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const WASM_PATH = path.resolve(__dirname, '../../dist/heic-decoder.wasm');
const FIXTURE_PATH = path.resolve(__dirname, '../fixtures/example.heic');
const ALPHA_FIXTURE_PATH = path.resolve(__dirname, '../fixtures/colors-with-alpha.heic');

const hasWasm = fs.existsSync(WASM_PATH);
const hasFixture = fs.existsSync(FIXTURE_PATH) && fs.existsSync(ALPHA_FIXTURE_PATH);

if (!hasWasm || !hasFixture) {
  console.warn(
    '[integration] Real-WASM integration suite is SKIPPED because dist/heic-decoder.wasm or test/fixtures are missing — run `npm run build` first.'
  );
}

/**
 * Integration tests exercising the real WASM decoder with a real HEIC fixture.
 *
 * These run in Node, which can decode but not canvas-encode (see the last
 * test). They are skipped automatically when the build artifacts or fixtures
 * are missing — run `npm run build` first.
 */
describe.skipIf(!hasWasm || !hasFixture)('Integration Tests - Real WASM Pipeline', () => {
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
    });
  });

  it('should reject convertHeic in Node.js environments (no canvas) with a clear error', async () => {
    // convertHeic needs canvas APIs for encoding, which Node.js lacks — this is
    // documented behavior: Node users decode raw RGBA and encode externally.
    // The decoder is injected (with the WASM binary) so the failure comes from
    // the missing canvas, not from module loading.
    const decoder = new LibheifDecoder({ wasmBinary });

    await expect(convertHeic(heicBytes, { to: 'png', decoder })).rejects.toThrow(
      'Canvas is not supported'
    );
  });
});
