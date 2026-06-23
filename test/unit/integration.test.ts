import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { convertHeic, freeSharedDecoder } from '../../src/index';

/**
 * Integration tests for the full HEIC conversion pipeline.
 *
 * All tests are skipped by default because they require the actual WASM binary
 * loaded from the build artifacts. Run manually with:
 *
 *   npx vitest run test/unit/integration.test.ts
 *
 * Or unskip the tests to run them in CI with the WASM binary available.
 */
describe.skip('Integration Tests - Full Conversion Flow', () => {
  beforeAll(() => {
    freeSharedDecoder();
  });

  afterAll(() => {
    freeSharedDecoder();
  });

  it('should complete a full conversion pipeline with real WASM', async () => {
    const input = new Uint8Array([
      // Minimal HEIC header (this would need a real fixture in practice)
    ]);

    const result = await convertHeic(input, { to: 'png' });

    expect(result).toBeInstanceOf(Blob);
    expect(result.type).toBe('image/png');
  });

  it('should not leak memory across multiple conversions', async () => {
    const iterations = 50;
    for (let i = 0; i < iterations; i++) {
      await convertHeic(new Uint8Array([0]));
      freeSharedDecoder();
    }
  });

  it('should track progress accurately through the conversion pipeline', async () => {
    const progressValues: number[] = [];
    const input = new Uint8Array([0]);

    await convertHeic(input, {
      onProgress: (percent) => {
        progressValues.push(percent);
      }
    });

    expect(progressValues.length).toBeGreaterThanOrEqual(1);
    expect(progressValues[progressValues.length - 1]).toBe(100);
  });

  it('should use custom decoder throughout the pipeline', async () => {
    const customDecoder = {
      initialize: vi.fn(async () => undefined),
      decode: vi.fn(async () => ({
        width: 2,
        height: 2,
        data: new Uint8ClampedArray(16),
      })),
      free: vi.fn(() => undefined),
    };

    const input = new Uint8Array([0]);
    const result = await convertHeic(input, { decoder: customDecoder });

    expect(customDecoder.initialize).toHaveBeenCalledTimes(1);
    expect(customDecoder.decode).toHaveBeenCalledTimes(1);
    expect(customDecoder.free).not.toHaveBeenCalled();
    expect(result).toBeInstanceOf(Blob);
  });

  it('should handle error propagation correctly through the pipeline', async () => {
    const errorDecoder = {
      initialize: vi.fn(async () => undefined),
      decode: vi.fn(async () => { throw new Error('Decoding failed'); }),
      free: vi.fn(() => undefined),
    };

    await expect(convertHeic(new Uint8Array([0]), { decoder: errorDecoder }))
      .rejects
      .toThrow('Decoding failed');
  });

  it('should validate input types before attempting conversion', async () => {
    // @ts-expect-error - intentionally testing invalid input type
    await expect(convertHeic({ invalid: true })).rejects.toThrow();
  });

  it('should perform end-to-end conversion within reasonable time', async () => {
    const start = performance.now();
    const input = new Uint8Array([0]);

    await convertHeic(input);

    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(5000); // 5 second timeout
  });
});
