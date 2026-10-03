import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockState, resetConvertMocks } from './helpers/convert-mocks';

vi.mock('../../src/render/canvas', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/render/canvas')>();
  const { mockState } = await import('./helpers/convert-mocks');
  return {
    ...actual,
    renderAndEncode: mockState.renderAndEncodeMock,
    assertEncodeEnvironment: mockState.assertEncodeEnvironmentMock,
  };
});

vi.mock('../../src/wasm', async () => {
  const { MockLibheifDecoder } = await import('./helpers/convert-mocks');
  return { LibheifDecoder: MockLibheifDecoder };
});

import { convertHeic } from '../../src/index';

describe('convertHeic - Progress Callbacks', () => {
  beforeEach(() => {
    resetConvertMocks();
  });

  it('should call onProgress callback with 100 on completion', async () => {
    const progress = vi.fn();
    const input = new Uint8Array([1, 2, 3]);

    await convertHeic(input, { onProgress: progress });

    expect(progress).toHaveBeenCalledWith(100);
  });

  it('should propagate a throwing progress callback as a rejection', async () => {
    const throwingProgress = vi.fn().mockImplementation(() => {
      throw new Error('Progress callback error');
    });

    await expect(convertHeic(new Uint8Array([1]), { onProgress: throwingProgress }))
      .rejects.toThrow('Progress callback error');
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
    resetConvertMocks();
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
    resetConvertMocks();
  });

  it('should preserve original error message in the wrapped render error', async () => {
    mockState.renderAndEncodeMock.mockRejectedValueOnce(
      new Error('Original error message')
    );

    await expect(convertHeic(new Uint8Array([1]))).rejects.toThrow(
      'Failed to render and encode image as jpeg: Original error message'
    );
  });

  it('should tag render failures with the render_encode_failed code and cause', async () => {
    const cause = new Error('Root cause');
    mockState.renderAndEncodeMock.mockRejectedValueOnce(cause);

    const error = await convertHeic(new Uint8Array([1])).catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe('render_encode_failed');
    expect(error.cause).toBe(cause);
  });

  it('should preserve error cause when available', async () => {
    const cause = new Error('Root cause');
    const error = new Error('Wrapped error', { cause });
    mockState.renderAndEncodeMock.mockRejectedValueOnce(error);

    await expect(convertHeic(new Uint8Array([1])))
      .rejects.toThrow('Wrapped error');
  });

  it('should normalize non-Error rejections from renderAndEncode', async () => {
    mockState.renderAndEncodeMock.mockRejectedValueOnce('String error');

    await expect(convertHeic(new Uint8Array([1]))).rejects.toThrow(
      'Failed to render and encode image as jpeg: String error'
    );
  });
});
