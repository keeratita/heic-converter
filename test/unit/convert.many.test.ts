import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockState = vi.hoisted(() => {
  const state = {
    renderAndEncodeMock: vi.fn(async (decoded: { data: Uint8ClampedArray }) =>
      new Blob([String(decoded.data[0])], { type: 'image/png' })
    ),
    defaultDecodedImage: {
      width: 1,
      height: 1,
      data: new Uint8ClampedArray([0, 0, 0, 255]),
    },
    decoderInstances: [] as Array<{
      initialize: ReturnType<typeof vi.fn>;
      decode: ReturnType<typeof vi.fn>;
      free: ReturnType<typeof vi.fn>;
    }>,
    rejectWithNull: false,
    active: 0,
    maxActive: 0,
    resetConcurrency: () => {
      state.active = 0;
      state.maxActive = 0;
    },
    getMaxActive: () => state.maxActive,
  };
  return state;
});

vi.mock('../../src/render/canvas', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/render/canvas')>();
  return {
    ...actual,
    renderAndEncode: mockState.renderAndEncodeMock,
  };
});

vi.mock('../../src/wasm', () => {
  class MockLibheifDecoder {
    initialize = vi.fn(async () => undefined);
    decode = vi.fn(
      async (data: Uint8Array, onProgress?: (percent: number) => void) => {
        mockState.active += 1;
        mockState.maxActive = Math.max(mockState.maxActive, mockState.active);
        // Input 1 is slow so conversions finish out of order; inputs 8 and 9
        // fail fast (with distinct messages) so failures win the race.
        const value = data[0];
        const delay = value === 1 ? 50 : value === 8 || value === 9 ? 5 : 10;
        await new Promise((resolve) => setTimeout(resolve, delay));
        mockState.active -= 1;
        if (mockState.rejectWithNull) {
          throw null;
        }
        if (value === 8) {
          throw new Error('decode failed for input 8');
        }
        if (value === 9) {
          throw new Error('decode failed for input 9');
        }
        onProgress?.(100);
        return {
          width: 1,
          height: 1,
          data: new Uint8ClampedArray([value ?? 0, 0, 0, 255]),
        };
      },
    );
    free = vi.fn(() => undefined);

    constructor() {
      mockState.decoderInstances.push(this);
    }
  }

  return {
    LibheifDecoder: MockLibheifDecoder,
    LibheifDecoderOptions: {},
  };
});

import { convertMany } from '../../src/index';

describe('convertMany', () => {
  beforeEach(() => {
    mockState.renderAndEncodeMock.mockClear();
    mockState.decoderInstances.length = 0;
    mockState.rejectWithNull = false;
    mockState.resetConcurrency();
  });

  it('should convert all inputs and return results in input order', async () => {
    const inputs = [new Uint8Array([1]), new Uint8Array([2]), new Uint8Array([3])];

    const results = await convertMany(inputs);

    expect(results).toHaveLength(3);
    for (const result of results) {
      expect(result).toBeInstanceOf(Blob);
    }
    expect(mockState.decoderInstances).toHaveLength(3);
  });

  it('should return results in input order even when conversions finish out of order', async () => {
    const inputs = [new Uint8Array([1]), new Uint8Array([2]), new Uint8Array([3])];

    const results = await convertMany(inputs, { concurrency: 2 });

    const contents = await Promise.all(results.map((result) => result.text()));
    expect(contents).toEqual(['1', '2', '3']);
  });

  it('should respect the concurrency limit', async () => {
    const inputs = Array.from({ length: 5 }, (_, i) => new Uint8Array([i]));

    await convertMany(inputs, { concurrency: 2 });

    expect(mockState.getMaxActive()).toBe(2);
    expect(mockState.decoderInstances).toHaveLength(5);
  });

  it('should default to concurrency of 4', async () => {
    const inputs = Array.from({ length: 8 }, (_, i) => new Uint8Array([i]));

    await convertMany(inputs);

    expect(mockState.getMaxActive()).toBe(4);
  });

  it('should run sequentially with concurrency of 1', async () => {
    const inputs = Array.from({ length: 3 }, (_, i) => new Uint8Array([i]));

    await convertMany(inputs, { concurrency: 1 });

    expect(mockState.getMaxActive()).toBe(1);
  });

  it('should run all conversions at once when concurrency exceeds the input count', async () => {
    const inputs = Array.from({ length: 3 }, (_, i) => new Uint8Array([i]));

    await convertMany(inputs, { concurrency: 10 });

    expect(mockState.getMaxActive()).toBe(3);
  });

  it('should convert a single input', async () => {
    const results = await convertMany([new Uint8Array([7])]);

    expect(results).toHaveLength(1);
    expect(await results[0].text()).toBe('7');
  });

  it('should pass through format and quality options', async () => {
    await convertMany([new Uint8Array([1])], { to: 'png', quality: 0.5 });

    expect(mockState.renderAndEncodeMock).toHaveBeenCalledWith(
      expect.any(Object),
      'png',
      0.5
    );
  });

  it('should pass through resize options', async () => {
    await convertMany([new Uint8Array([1])], { scale: 0.5 });

    expect(mockState.renderAndEncodeMock).toHaveBeenCalledWith(
      expect.any(Object),
      'jpeg',
      0.92,
      expect.objectContaining({ scale: 0.5 })
    );
  });

  it('should forward per-item progress with the item index', async () => {
    const onProgress = vi.fn();

    await convertMany([new Uint8Array([1]), new Uint8Array([2])], { onProgress });

    expect(onProgress).toHaveBeenCalledWith(0, 100);
    expect(onProgress).toHaveBeenCalledWith(1, 100);
  });

  it('should only report progress for successful items', async () => {
    const onProgress = vi.fn();

    await expect(
      convertMany([new Uint8Array([9]), new Uint8Array([2])], { onProgress })
    ).rejects.toThrow('decode failed for input 9');

    expect(onProgress).not.toHaveBeenCalledWith(0, 100);
    // The in-flight item finishes after the rejection; wait for its progress.
    await vi.waitFor(() => expect(onProgress).toHaveBeenCalledWith(1, 100));
  });

  it('should reject with the failing item index and the first error', async () => {
    const inputs = [new Uint8Array([1]), new Uint8Array([9]), new Uint8Array([3])];

    await expect(convertMany(inputs)).rejects.toThrow(
      'Conversion of item 2 of 3 failed: decode failed for input 9'
    );
  });

  it('should report the first failure in time, not the lowest index', async () => {
    // Item 1 (index 1) fails fast while item 0 is still decoding slowly.
    const inputs = [new Uint8Array([1]), new Uint8Array([8]), new Uint8Array([9])];

    await expect(convertMany(inputs, { concurrency: 2 })).rejects.toThrow(
      'Conversion of item 2 of 3 failed: decode failed for input 8'
    );
  });

  it('should reject with the first error when all conversions fail', async () => {
    const inputs = [new Uint8Array([9]), new Uint8Array([9])];

    await expect(convertMany(inputs)).rejects.toThrow(
      'Conversion of item 1 of 2 failed: decode failed for input 9'
    );
  });

  it('should wrap a null rejection with the item index', async () => {
    mockState.rejectWithNull = true;

    await expect(convertMany([new Uint8Array([1])])).rejects.toThrow(
      'Conversion of item 1 of 1 failed: null'
    );
  });

  it('should return an empty array for empty inputs', async () => {
    const results = await convertMany([]);

    expect(results).toEqual([]);
    expect(mockState.decoderInstances).toHaveLength(0);
  });

  it('should throw a clear error for non-array inputs', async () => {
    await expect(convertMany(undefined as any)).rejects.toThrow(
      'Inputs must be an array of HEIC images'
    );
    await expect(convertMany('not-an-array' as any)).rejects.toThrow(
      'Inputs must be an array of HEIC images'
    );
  });

  it('should throw when concurrency is zero', async () => {
    await expect(convertMany([new Uint8Array([1])], { concurrency: 0 })).rejects.toThrow(
      'Concurrency must be a positive integer'
    );
  });

  it('should throw when concurrency is negative', async () => {
    await expect(convertMany([new Uint8Array([1])], { concurrency: -1 })).rejects.toThrow(
      'Concurrency must be a positive integer'
    );
  });

  it('should throw when concurrency is not an integer', async () => {
    await expect(convertMany([new Uint8Array([1])], { concurrency: 1.5 })).rejects.toThrow(
      'Concurrency must be a positive integer'
    );
  });

  it('should throw when concurrency is not a number', async () => {
    await expect(convertMany([new Uint8Array([1])], { concurrency: '2' as any })).rejects.toThrow(
      'Concurrency must be a positive integer'
    );
  });

  it('should throw when concurrency is Infinity or NaN', async () => {
    await expect(convertMany([new Uint8Array([1])], { concurrency: Infinity })).rejects.toThrow(
      'Concurrency must be a positive integer'
    );
    await expect(convertMany([new Uint8Array([1])], { concurrency: NaN })).rejects.toThrow(
      'Concurrency must be a positive integer'
    );
  });
});
