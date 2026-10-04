import { beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { LibheifDecoder } from '../../src/index';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '../..');

// Paths to fixtures
const examplePath = path.join(ROOT_DIR, 'test/fixtures/example.heic');
const noAlphaPath = path.join(ROOT_DIR, 'test/fixtures/colors-no-alpha.heic');
const withAlphaPath = path.join(ROOT_DIR, 'test/fixtures/colors-with-alpha.heic');

// Path to compiled WASM (produced by `npm run build`)
const wasmPath = path.join(ROOT_DIR, 'dist/heic-decoder.wasm');

const hasArtifacts =
  fs.existsSync(wasmPath) &&
  fs.existsSync(examplePath) &&
  fs.existsSync(noAlphaPath) &&
  fs.existsSync(withAlphaPath);

const isCI = typeof process !== 'undefined' && !!process.env.CI;

if (!hasArtifacts) {
  if (isCI) {
    // CI must never silently skip the real-WASM decoder: this is the suite that
    // instantiates the committed binary, so a missing build or artifact would
    // hide exactly the regression class it exists to catch (a smaller WASM that
    // only fails at WebAssembly.instantiate()). Per-test it.skipIf is not enough
    // — when every test in a suite is skipped, beforeAll never runs and vitest
    // exits 0. Skip the whole suite only outside CI.
    console.error(
      '[decoder] dist/heic-decoder.wasm or test fixtures are missing in CI — this suite will FAIL.'
    );
  } else {
    console.warn(
      '[decoder] Real-WASM decoder suite is SKIPPED because dist/heic-decoder.wasm or ' +
        'test fixtures are missing — run `npm run build` first.'
    );
  }
}

/**
 * Exercises the real LibheifDecoder (actual Emscripten glue + WASM binary)
 * in Node. Distinct from integration.test.ts, which covers the end-to-end
 * convertHeic pipeline; this suite targets the decoder wrapper contract.
 *
 * Skips outside CI when build artifacts or fixtures are missing; on CI it runs
 * unconditionally and fails, so a broken artifact can never report green.
 */
describe.skipIf(!hasArtifacts && !isCI)('LibheifDecoder (real WASM)', () => {
  it('suite artifacts are present', () => {
    expect(hasArtifacts).toBe(true);
  });

  // Fixture bytes are loaded once, lazily, so a missing dist/ build skips
  // this suite instead of crashing module collection.
  let wasmBinary: ArrayBuffer;
  let exampleHeic: Uint8Array;
  let noAlphaHeic: Uint8Array;
  let withAlphaHeic: Uint8Array;

  beforeAll(() => {
    wasmBinary = new Uint8Array(fs.readFileSync(wasmPath)).buffer;
    exampleHeic = new Uint8Array(fs.readFileSync(examplePath));
    noAlphaHeic = new Uint8Array(fs.readFileSync(noAlphaPath));
    withAlphaHeic = new Uint8Array(fs.readFileSync(withAlphaPath));
  });

  it('should initialize successfully', async () => {
    const decoder = new LibheifDecoder({ wasmBinary });
    await expect(decoder.initialize()).resolves.not.toThrow();
    decoder.free();
  });

  it('should accept wasmBinary as a Node Buffer (ArrayBufferView)', async () => {
    // fs.readFileSync returns a Buffer; the widened option type must accept it.
    const decoder = new LibheifDecoder({ wasmBinary: fs.readFileSync(wasmPath) });
    await expect(decoder.initialize()).resolves.not.toThrow();
    decoder.free();
  });

  it('should decode example.heic successfully', async () => {
    const decoder = new LibheifDecoder({ wasmBinary });

    await decoder.initialize();
    const result = await decoder.decode(exampleHeic);

    expect(result).toBeDefined();
    expect(result.width).toBeGreaterThan(0);
    expect(result.height).toBeGreaterThan(0);
    expect(result.data).toBeInstanceOf(Uint8ClampedArray);
    expect(result.data.length).toBe(result.width * result.height * 4);

    decoder.free();
  });

  it('should call the onProgress callback during decode', async () => {
    const decoder = new LibheifDecoder({ wasmBinary });

    await decoder.initialize();
    const progressPercentages: number[] = [];
    const onProgress = (percent: number) => {
      progressPercentages.push(percent);
    };

    const result = await decoder.decode(exampleHeic, onProgress);

    expect(result).toBeDefined();
    expect(progressPercentages.length).toBeGreaterThan(0);
    for (const percent of progressPercentages) {
      expect(percent).toBeGreaterThanOrEqual(0);
      expect(percent).toBeLessThanOrEqual(100);
    }
    expect(progressPercentages[0]).toBe(0);
    expect(progressPercentages[progressPercentages.length - 1]).toBe(100);

    decoder.free();
  });

  it('should decode colors-no-alpha.heic successfully', async () => {
    const decoder = new LibheifDecoder({ wasmBinary });

    await decoder.initialize();
    const result = await decoder.decode(noAlphaHeic);

    expect(result).toBeDefined();
    expect(result.width).toBe(64); // colors-no-alpha is 64x64
    expect(result.height).toBe(64);
    expect(result.data.length).toBe(64 * 64 * 4);

    decoder.free();
  });

  it('should decode colors-with-alpha.heic successfully', async () => {
    const decoder = new LibheifDecoder({ wasmBinary });

    await decoder.initialize();
    const result = await decoder.decode(withAlphaHeic);

    expect(result).toBeDefined();
    expect(result.width).toBe(64); // colors-with-alpha is 64x64
    expect(result.height).toBe(64);
    expect(result.data.length).toBe(64 * 64 * 4);

    decoder.free();
  });

  it('should throw an error on invalid HEIC data', async () => {
    const invalidData = new Uint8Array([0, 1, 2, 3, 4, 5]);
    const decoder = new LibheifDecoder({ wasmBinary });

    await decoder.initialize();
    await expect(decoder.decode(invalidData)).rejects.toThrow('HEIC decoding failed');

    decoder.free();
  });

  it('should include the input byte length in decode failure messages', async () => {
    const invalidData = new Uint8Array([0, 1, 2, 3, 4, 5]);
    const decoder = new LibheifDecoder({ wasmBinary });

    await decoder.initialize();
    const error = await decoder.decode(invalidData).catch((e) => e);
    expect(error.code).toBe('decode_failed');
    expect(error.message).toContain('input: 6 bytes');

    decoder.free();
  });

  describe('HEIC file edge cases', () => {
    it('should handle truncated HEIC file', async () => {
      const truncatedData = exampleHeic.slice(0, Math.floor(exampleHeic.length / 2));

      const decoder = new LibheifDecoder({ wasmBinary });
      await decoder.initialize();

      // libheif is robust and can decode partial/truncated HEIC files
      // This is valid behavior - the decoder extracts what it can
      const result = await decoder.decode(truncatedData);

      expect(result).toBeDefined();
      expect(result.width).toBeGreaterThan(0);
      expect(result.height).toBeGreaterThan(0);

      decoder.free();
    });

    it('should handle HEIC with only header (no image data)', async () => {
      // Create a minimal HEIC-like header (not valid but tests edge case)
      const minimalHeader = new Uint8Array([
        0x00, 0x00, 0x00, 0x18, // box size
        0x66, 0x74, 0x79, 0x70, // 'ftyp'
      ]);

      const decoder = new LibheifDecoder({ wasmBinary });
      await decoder.initialize();

      await expect(decoder.decode(minimalHeader)).rejects.toThrow();

      decoder.free();
    });

    it('should handle HEIC file with extra trailing data', async () => {
      const dataWithTrailer = new Uint8Array([...exampleHeic, ...new Uint8Array(100).fill(0xFF)]);

      const decoder = new LibheifDecoder({ wasmBinary });
      await decoder.initialize();

      // Should still decode successfully (extra data ignored)
      const result = await decoder.decode(dataWithTrailer);

      expect(result).toBeDefined();
      expect(result.width).toBeGreaterThan(0);
      expect(result.height).toBeGreaterThan(0);

      decoder.free();
    });

    it('should handle HEIC with all zeros', async () => {
      const zerosData = new Uint8Array(1000).fill(0);

      const decoder = new LibheifDecoder({ wasmBinary });
      await decoder.initialize();

      await expect(decoder.decode(zerosData)).rejects.toThrow();

      decoder.free();
    });

    it('should handle HEIC with all 0xFF bytes', async () => {
      const ffData = new Uint8Array(1000).fill(0xFF);

      const decoder = new LibheifDecoder({ wasmBinary });
      await decoder.initialize();

      await expect(decoder.decode(ffData)).rejects.toThrow();

      decoder.free();
    });

    it('should handle alternating byte pattern', async () => {
      const alternatingData = new Uint8Array(1000);
      for (let i = 0; i < 1000; i++) {
        alternatingData[i] = i % 2 === 0 ? 0x00 : 0xFF;
      }

      const decoder = new LibheifDecoder({ wasmBinary });
      await decoder.initialize();

      await expect(decoder.decode(alternatingData)).rejects.toThrow();

      decoder.free();
    });
  });

  describe('WASM and decoder lifecycle edge cases', () => {
    it('should handle corrupted WASM binary', async () => {
      const corruptedWasm = new Uint8Array([0x00, 0x01, 0x02, 0x03]);

      const decoder = new LibheifDecoder({ wasmBinary: corruptedWasm.buffer });

      // Should fail to initialize with corrupted WASM
      await expect(decoder.initialize()).rejects.toThrow();
    });

    it('should handle empty WASM binary', async () => {
      const emptyWasm = new ArrayBuffer(0);

      const decoder = new LibheifDecoder({ wasmBinary: emptyWasm });

      await expect(decoder.initialize()).rejects.toThrow();
    });

    it('should re-initialize and decode successfully after free', async () => {
      // Documented contract: after free() the instance must be re-initialized;
      // decode() transparently re-loads a fresh module (the loaded WASM module
      // is dropped on free(), so this exercises a second instantiation too).
      const decoder = new LibheifDecoder({ wasmBinary });

      await decoder.initialize();
      decoder.free();

      const result = await decoder.decode(exampleHeic);
      expect(result.width).toBeGreaterThan(0);
      expect(result.height).toBeGreaterThan(0);
      expect(result.data.length).toBe(result.width * result.height * 4);

      decoder.free();
    });

    it('should discard an in-flight initialize() when freed during load', async () => {
      // free() mid-initialization must not leave a live, unreachable WASM
      // instance behind (generation-counter race fix). Observable contract:
      // the instance ends up fully freed and reusable.
      const decoder = new LibheifDecoder({ wasmBinary });

      const initializing = decoder.initialize();
      decoder.free();
      await initializing;

      // Not resurrected: decode() must re-initialize from scratch and work.
      const result = await decoder.decode(exampleHeic);
      expect(result.data.length).toBe(result.width * result.height * 4);
      decoder.free();
    });

    it('should handle calling free multiple times', async () => {
      const decoder = new LibheifDecoder({ wasmBinary });
      await decoder.initialize();

      // First free should succeed
      decoder.free();

      // Second free should not throw (idempotent)
      expect(() => decoder.free()).not.toThrow();
    });

    it('should handle calling free before initialize', async () => {
      const decoder = new LibheifDecoder({ wasmBinary });

      // Free before initialize should not throw
      expect(() => decoder.free()).not.toThrow();
    });

    it('should handle decode without initialize', async () => {
      const decoder = new LibheifDecoder({ wasmBinary });

      // decode() lazily initializes when needed
      const result = await decoder.decode(exampleHeic);

      expect(result.width).toBeGreaterThan(0);
      expect(result.data.length).toBe(result.width * result.height * 4);
    });

    it('should support concurrent decodes on the same instance', async () => {
      // The wrapper memoizes module loading and hands each decode its own
      // JS-owned pixel buffer, so concurrent decodes must all succeed with
      // independent results. (Uses the small fixture: two full-size decodes
      // are slow enough to trip the default timeout under coverage.)
      const decoder = new LibheifDecoder({ wasmBinary });

      await decoder.initialize();

      const results = await Promise.all([decoder.decode(noAlphaHeic), decoder.decode(noAlphaHeic)]);

      expect(results).toHaveLength(2);
      for (const result of results) {
        expect(result.width).toBe(64);
        expect(result.height).toBe(64);
        expect(result.data.length).toBe(result.width * result.height * 4);
      }
      // Independent buffers: the two results must not alias each other.
      expect(results[0].data).not.toBe(results[1].data);

      decoder.free();
    }, 20000);

    it('should handle very small WASM binary', async () => {
      const smallWasm = new Uint8Array([0x00, 0x01, 0x02]);

      const decoder = new LibheifDecoder({ wasmBinary: smallWasm.buffer });

      await expect(decoder.initialize()).rejects.toThrow();
    });
  });

  describe('Progress callback edge cases', () => {
    it('should attribute a throwing progress callback as progress_callback_failed', async () => {
      const heicData = exampleHeic;
      const throwingProgress = vi.fn().mockImplementation(() => {
        throw new Error('Progress error');
      });

      const decoder = new LibheifDecoder({ wasmBinary });
      await decoder.initialize();

      // The callback contract violation surfaces with attribution (and never
      // unwinds through the WASM frame, which would abort the module).
      const error = await decoder.decode(heicData, throwingProgress).catch((e) => e);
      expect(error.code).toBe('progress_callback_failed');
      expect(error.message).toContain('onProgress callback threw during decode');
      expect(error.message).toContain('Progress error');
      expect(throwingProgress).toHaveBeenCalled();

      decoder.free();
    });

    it('should handle progress callback that is not a function', async () => {
      const decoder = new LibheifDecoder({ wasmBinary });
      await decoder.initialize();

      // Should not throw with non-function progress
      const result = await decoder.decode(exampleHeic, null as any);

      expect(result).toBeDefined();

      decoder.free();
    });

    it('should handle progress callback with side effects', async () => {
      const sideEffectProgress = vi.fn().mockImplementation((percent) => {
        // Simulate side effect
        void new Array(100).fill(percent);
      });

      const decoder = new LibheifDecoder({ wasmBinary });
      await decoder.initialize();

      const result = await decoder.decode(exampleHeic, sideEffectProgress);

      expect(result).toBeDefined();
      expect(sideEffectProgress).toHaveBeenCalled();

      decoder.free();
    });

    it('should handle async progress callback', async () => {
      const asyncProgress = vi.fn().mockImplementation(async (percent) => {
        await Promise.resolve();
        return percent;
      });

      const decoder = new LibheifDecoder({ wasmBinary });
      await decoder.initialize();

      const result = await decoder.decode(exampleHeic, asyncProgress);

      expect(result).toBeDefined();

      decoder.free();
    });
  });

  describe('Decoded image edge cases', () => {
    it('should handle decoding image with zero dimensions', async () => {
      // This tests the decoder's handling of malformed HEIC that might report zero dimensions
      const invalidData = new Uint8Array([0x00, 0x00, 0x00, 0x00]);

      const decoder = new LibheifDecoder({ wasmBinary });
      await decoder.initialize();

      await expect(decoder.decode(invalidData)).rejects.toThrow();

      decoder.free();
    });

    it('should handle decoding image with very large dimensions', async () => {
      // Create data that might be interpreted as having large dimensions
      const largeDimData = new Uint8Array(10000);

      const decoder = new LibheifDecoder({ wasmBinary });
      await decoder.initialize();

      // Should fail (not valid HEIC) but not crash
      await expect(decoder.decode(largeDimData)).rejects.toThrow();

      decoder.free();
    });

    it('should verify decoded data length matches dimensions', async () => {
      const decoder = new LibheifDecoder({ wasmBinary });
      await decoder.initialize();

      const result = await decoder.decode(exampleHeic);

      // Verify the invariant: data.length === width * height * 4
      expect(result.data.length).toBe(result.width * result.height * 4);

      decoder.free();
    });

    it('should keep decoded pixels valid after free()', async () => {
      // DecodedImage.data is a JS-owned buffer; free() must not invalidate it.
      const decoder = new LibheifDecoder({ wasmBinary });
      await decoder.initialize();

      const result = await decoder.decode(exampleHeic);
      const expectedLength = result.data.length;
      const firstPixels = Array.from(result.data.slice(0, 8));

      decoder.free();

      expect(result.data.length).toBe(expectedLength);
      expect(Array.from(result.data.slice(0, 8))).toEqual(firstPixels);
      // It must be backed by a plain ArrayBuffer (usable in ImageData).
      expect(result.data.buffer).toBeInstanceOf(ArrayBuffer);
    });
  });

  describe('Memory management edge cases', () => {
    it('should handle multiple initialize calls', async () => {
      const decoder = new LibheifDecoder({ wasmBinary });

      // First initialize
      await decoder.initialize();

      // Second initialize is memoized and succeeds cheaply
      await expect(decoder.initialize()).resolves.not.toThrow();

      decoder.free();
    });

    it('should handle rapid create-free cycles', async () => {
      let completed = 0;
      for (let i = 0; i < 5; i++) {
        const decoder = new LibheifDecoder({ wasmBinary });
        await decoder.initialize();
        decoder.free();
        completed += 1;
      }
      expect(completed).toBe(5);
    });

    it('should handle many sequential decodes', async () => {
      const decoder = new LibheifDecoder({ wasmBinary });

      await decoder.initialize();

      for (let i = 0; i < 10; i++) {
        const result = await decoder.decode(exampleHeic);
        expect(result.data.length).toBe(result.width * result.height * 4);
      }

      decoder.free();
    });
  });
});
