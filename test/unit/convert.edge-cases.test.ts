import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockState = vi.hoisted(() => ({
  renderAndEncodeMock: vi.fn(async () => new Blob(['converted'], { type: 'image/png' })),
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
}));

vi.mock('../../src/render/canvas', () => ({
  renderAndEncode: mockState.renderAndEncodeMock,
}));

vi.mock('../../src/wasm', () => {
  class MockLibheifDecoder {
    initialize = vi.fn(async () => undefined);
    decode = vi.fn(
      async (data: Uint8Array, onProgress?: (percent: number) => void) => {
        onProgress?.(100);
        return {
          ...mockState.defaultDecodedImage,
          data: new Uint8ClampedArray(mockState.defaultDecodedImage.data),
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

import { convertHeic, freeSharedDecoder } from '../../src/index';

describe('convertHeic - Progress Callbacks', () => {
  beforeEach(() => {
    freeSharedDecoder();
    mockState.renderAndEncodeMock.mockClear();
    mockState.decoderInstances.length = 0;
  });

  it('should call onProgress callback with 100 on completion', async () => {
    const progress = vi.fn();
    const input = new Uint8Array([1, 2, 3]);

    await convertHeic(input, { onProgress: progress });

    expect(progress).toHaveBeenCalledWith(100);
  });

  it('should handle progress callback that throws', async () => {
    const throwingProgress = vi.fn().mockImplementation(() => {
      throw new Error('Progress callback error');
    });

    await expect(convertHeic(new Uint8Array([1]), { onProgress: throwingProgress }))
      .rejects.toThrow();
  });

  it('should handle progress callback with side effects', async () => {
    const progressWithSideEffects = vi.fn().mockImplementation((percent) => {
      void new Array(1000).fill(percent);
    });

    const result = await convertHeic(new Uint8Array([1]), {
      onProgress: progressWithSideEffects,
    });

    expect(result).toBeInstanceOf(Blob);
    expect(progressWithSideEffects).toHaveBeenCalledWith(100);
  });

  it('should handle progress callback that returns a value', async () => {
    const progressReturningValue = vi.fn().mockReturnValue({ result: 'value' });

    const result = await convertHeic(new Uint8Array([1]), {
      onProgress: progressReturningValue,
    });

    expect(result).toBeInstanceOf(Blob);
  });

  it('should handle async progress callback', async () => {
    const asyncProgress = vi.fn().mockImplementation(async (percent) => {
      await Promise.resolve();
      return percent;
    });

    const result = await convertHeic(new Uint8Array([1]), {
      onProgress: asyncProgress,
    });

    expect(result).toBeInstanceOf(Blob);
  });

  it('should work with null progress callback', async () => {
    const result = await convertHeic(new Uint8Array([1]), { onProgress: null as any });
    expect(result).toBeInstanceOf(Blob);
  });

  it('should work with undefined progress callback', async () => {
    const result = await convertHeic(new Uint8Array([1]), {
      onProgress: undefined,
    });
    expect(result).toBeInstanceOf(Blob);
  });
});

describe('convertHeic - Concurrency', () => {
  beforeEach(() => {
    freeSharedDecoder();
    mockState.renderAndEncodeMock.mockClear();
    mockState.decoderInstances.length = 0;
  });

    it('should handle multiple concurrent conversions', async () => {
      const promises = [
        convertHeic(new Uint8Array([1])),
        convertHeic(new Uint8Array([2])),
        convertHeic(new Uint8Array([3])),
      ];

      const results = await Promise.all(promises);

      expect(results).toHaveLength(3);
      results.forEach((result) => expect(result).toBeInstanceOf(Blob));
    });

    it('should use a distinct decoder instance for each concurrent conversion', async () => {
      const promises = [
        convertHeic(new Uint8Array([1])),
        convertHeic(new Uint8Array([2])),
        convertHeic(new Uint8Array([3])),
      ];

      await Promise.all(promises);

      const instances = mockState.decoderInstances;
      expect(instances).toHaveLength(3);
      // No two concurrent conversions may share the same decoder instance.
      expect(new Set(instances).size).toBe(3);
      instances.forEach((decoder) => expect(decoder.free).toHaveBeenCalledTimes(1));
    });

  it('should handle many concurrent conversions', async () => {
    const promises = Array(10).fill(null).map((_, i) => convertHeic(new Uint8Array([i])));

    const results = await Promise.all(promises);

    expect(results).toHaveLength(10);
    results.forEach((result) => expect(result).toBeInstanceOf(Blob));
  });

  it('should handle sequential conversions without memory issues', async () => {
    for (let i = 0; i < 5; i++) {
      const result = await convertHeic(new Uint8Array([i]));
      expect(result).toBeInstanceOf(Blob);
    }

    expect(mockState.decoderInstances).toHaveLength(5);
  });

  it('should handle mixed sync and async operations', async () => {
    const syncPromise = convertHeic(new Uint8Array([1]));

    const syncResult = 1 + 1;
    expect(syncResult).toBe(2);

    const asyncResult = await syncPromise;
    expect(asyncResult).toBeInstanceOf(Blob);
  });
});

describe('convertHeic - Error Propagation', () => {
  beforeEach(() => {
    freeSharedDecoder();
    mockState.renderAndEncodeMock.mockClear();
    mockState.decoderInstances.length = 0;
  });

  it('should preserve original error message', async () => {
    mockState.renderAndEncodeMock.mockRejectedValueOnce(
      new Error('Original error message')
    );

    await expect(convertHeic(new Uint8Array([1]))).rejects.toThrow(
      'Original error message'
    );
  });

  it('should preserve error cause when available', async () => {
    const cause = new Error('Root cause');
    const error = new Error('Wrapped error', { cause });
    mockState.renderAndEncodeMock.mockRejectedValueOnce(error);

    await expect(convertHeic(new Uint8Array([1])))
      .rejects.toThrow('Wrapped error');
  });

  it('should handle non-Error rejections', async () => {
    mockState.renderAndEncodeMock.mockRejectedValueOnce('String error');

    await expect(convertHeic(new Uint8Array([1])))
      .rejects.toBe('String error');
  });
});
