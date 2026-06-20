import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockState = vi.hoisted(() => ({
  renderAndEncodeMock: vi.fn(
    async () => new Blob(['converted'], { type: 'image/png' }),
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

describe('convertHeic Unit Tests', () => {
  beforeEach(() => {
    freeSharedDecoder();
    mockState.renderAndEncodeMock.mockClear();
    mockState.decoderInstances.length = 0;
  });

  it('should normalize ArrayBuffer input and use default output options', async () => {
    const input = new Uint8Array([1, 2, 3, 4]).buffer;

    const result = await convertHeic(input);

    expect(result).toBeInstanceOf(Blob);
    expect(mockState.decoderInstances).toHaveLength(1);
    expect(mockState.decoderInstances[0].initialize).toHaveBeenCalledTimes(1);
    expect(mockState.decoderInstances[0].decode).toHaveBeenCalledTimes(1);

    const decodedInput = mockState.decoderInstances[0].decode.mock.calls[0][0];
    expect(decodedInput).toBeInstanceOf(Uint8Array);
    expect(Array.from(decodedInput)).toEqual([1, 2, 3, 4]);

    expect(mockState.renderAndEncodeMock).toHaveBeenCalledTimes(1);
    expect(mockState.renderAndEncodeMock).toHaveBeenCalledWith(
      expect.objectContaining({ width: 1, height: 1 }),
      'jpeg',
      0.92,
    );
  });

  it('should convert Blob input and forward format, quality, and progress callback', async () => {
    const progress = vi.fn();
    const inputBlob = new Blob([new Uint8Array([8, 9, 10])], {
      type: 'image/heic',
    });

    await convertHeic(inputBlob, {
      to: 'png',
      quality: 0.5,
      onProgress: progress,
    });

    expect(mockState.decoderInstances).toHaveLength(1);
    expect(mockState.decoderInstances[0].decode).toHaveBeenCalledWith(
      expect.any(Uint8Array),
      progress,
    );
    expect(progress).toHaveBeenCalledWith(100);
    expect(mockState.renderAndEncodeMock).toHaveBeenCalledWith(
      expect.objectContaining({ width: 1, height: 1 }),
      'png',
      0.5,
    );
  });

  it('should use injected decoder instead of creating shared default decoder', async () => {
    const injectedDecoder = {
      initialize: vi.fn(async () => undefined),
      decode: vi.fn(async () => ({
        width: 2,
        height: 2,
        data: new Uint8ClampedArray(16),
      })),
      free: vi.fn(() => undefined),
    };

    await convertHeic(new Uint8Array([1, 2, 3]), {
      to: 'svg',
      decoder: injectedDecoder,
    });

    expect(mockState.decoderInstances).toHaveLength(0);
    expect(injectedDecoder.initialize).toHaveBeenCalledTimes(1);
    expect(injectedDecoder.decode).toHaveBeenCalledTimes(1);
    expect(mockState.renderAndEncodeMock).toHaveBeenCalledWith(
      expect.objectContaining({ width: 2, height: 2 }),
      'svg',
      0.92,
    );
  });

  it('should free shared decoder after each conversion and create new one for next call', async () => {
    await convertHeic(new Uint8Array([1]));

    // First decoder should be freed after conversion
    expect(mockState.decoderInstances).toHaveLength(1);
    expect(mockState.decoderInstances[0].initialize).toHaveBeenCalledTimes(1);
    expect(mockState.decoderInstances[0].free).toHaveBeenCalledTimes(1);

    // Second conversion should create a new decoder
    await convertHeic(new Uint8Array([2]));
    expect(mockState.decoderInstances).toHaveLength(2);
    expect(mockState.decoderInstances[1].initialize).toHaveBeenCalledTimes(1);
    expect(mockState.decoderInstances[1].free).toHaveBeenCalledTimes(1);
  });

  it('should throw on unsupported input type', async () => {
    const invalidInput = { foo: 'bar' } as unknown as Uint8Array;

    await expect(convertHeic(invalidInput)).rejects.toThrow(
      'Unsupported input type. Expected Blob, File, ArrayBuffer, or Uint8Array.',
    );
  });

  it('should handle File input correctly', async () => {
    const mockFile = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/heic' });
    (mockFile as any).name = 'test.heic';

    const result = await convertHeic(mockFile as File);

    expect(result).toBeInstanceOf(Blob);
    expect(mockState.decoderInstances).toHaveLength(1);
  });

  it('should use default quality when not specified', async () => {
    await convertHeic(new Uint8Array([1, 2, 3]), { to: 'jpeg' });

    expect(mockState.renderAndEncodeMock).toHaveBeenCalledWith(
      expect.any(Object),
      'jpeg',
      0.92,
    );
  });

  it('should handle quality of 0 for JPEG', async () => {
    await convertHeic(new Uint8Array([1, 2, 3]), { to: 'jpeg', quality: 0 });

    expect(mockState.renderAndEncodeMock).toHaveBeenCalledWith(
      expect.any(Object),
      'jpeg',
      0,
    );
  });

  it('should handle quality of 1 for JPEG', async () => {
    await convertHeic(new Uint8Array([1, 2, 3]), { to: 'jpeg', quality: 1 });

    expect(mockState.renderAndEncodeMock).toHaveBeenCalledWith(
      expect.any(Object),
      'jpeg',
      1,
    );
  });

  it('should pass through all output formats correctly', async () => {
    const formats: Array<'jpeg' | 'jpg' | 'png' | 'svg'> = ['jpeg', 'jpg', 'png', 'svg'];

    for (const format of formats) {
      mockState.renderAndEncodeMock.mockClear();
      await convertHeic(new Uint8Array([1]), { to: format });
      expect(mockState.renderAndEncodeMock).toHaveBeenCalledWith(expect.any(Object), format, 0.92);
    }
  });

  it('should call onProgress callback with 100 on completion', async () => {
    const progress = vi.fn();
    const input = new Uint8Array([1, 2, 3]);

    await convertHeic(input, { onProgress: progress });

    expect(progress).toHaveBeenCalledWith(100);
  });

  it('should handle multiple concurrent conversions', async () => {
    const promises = [
      convertHeic(new Uint8Array([1])),
      convertHeic(new Uint8Array([2])),
      convertHeic(new Uint8Array([3])),
    ];

    const results = await Promise.all(promises);

    expect(results).toHaveLength(3);
    results.forEach(result => expect(result).toBeInstanceOf(Blob));
  });

  it('should handle Uint8Array input directly without conversion', async () => {
    const input = new Uint8Array([10, 20, 30, 40, 50]);

    await convertHeic(input);

    const decodedInput = mockState.decoderInstances[0].decode.mock.calls[0][0];
    expect(decodedInput).toBeInstanceOf(Uint8Array);
    expect(Array.from(decodedInput)).toEqual([10, 20, 30, 40, 50]);
  });

  it('should handle ArrayBuffer input correctly', async () => {
    const arrayBuffer = new ArrayBuffer(10);
    const uint8View = new Uint8Array(arrayBuffer);
    for (let i = 0; i < 10; i++) {
      uint8View[i] = i;
    }

    await convertHeic(arrayBuffer);

    const decodedInput = mockState.decoderInstances[0].decode.mock.calls[0][0];
    expect(decodedInput).toBeInstanceOf(Uint8Array);
    expect(Array.from(decodedInput)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('should handle empty options object', async () => {
    const result = await convertHeic(new Uint8Array([1]), {});

    expect(result).toBeInstanceOf(Blob);
    expect(mockState.renderAndEncodeMock).toHaveBeenCalledWith(
      expect.any(Object),
      'jpeg',
      0.92,
    );
  });

  it('should handle undefined options', async () => {
    const result = await convertHeic(new Uint8Array([1]));

    expect(result).toBeInstanceOf(Blob);
    expect(mockState.renderAndEncodeMock).toHaveBeenCalledWith(
      expect.any(Object),
      'jpeg',
      0.92,
    );
  });

  it('should create new shared decoder after freeSharedDecoder is called', async () => {
    await convertHeic(new Uint8Array([1]));
    const firstDecoder = mockState.decoderInstances[0];

    freeSharedDecoder();

    await convertHeic(new Uint8Array([2]));
    const secondDecoder = mockState.decoderInstances[1];

    expect(firstDecoder).not.toBe(secondDecoder);
    expect(firstDecoder.free).toHaveBeenCalledTimes(1);
  });

  it('should not create shared decoder when injected decoder is used', async () => {
    const injectedDecoder = {
      initialize: vi.fn(async () => undefined),
      decode: vi.fn(async () => ({
        width: 1,
        height: 1,
        data: new Uint8ClampedArray([0, 0, 0, 255]),
      })),
      free: vi.fn(() => undefined),
    };

    await convertHeic(new Uint8Array([1]), { decoder: injectedDecoder });

    expect(mockState.decoderInstances).toHaveLength(0);
    expect(injectedDecoder.initialize).toHaveBeenCalledTimes(1);
  });

  it('should reuse injected decoder between calls', async () => {
    const injectedDecoder = {
      initialize: vi.fn(async () => undefined),
      decode: vi.fn(async () => ({
        width: 1,
        height: 1,
        data: new Uint8ClampedArray([0, 0, 0, 255]),
      })),
      free: vi.fn(() => undefined),
    };

    // First call - initialize + decode
    await convertHeic(new Uint8Array([1]), { decoder: injectedDecoder });
    // Second call - initialize is called again (the wrapper always calls initialize before decode)
    await convertHeic(new Uint8Array([2]), { decoder: injectedDecoder });

    // initialize is called twice (once per convertHeic call), decode is called twice
    expect(injectedDecoder.initialize).toHaveBeenCalledTimes(2);
    expect(injectedDecoder.decode).toHaveBeenCalledTimes(2);
  });

  it('should handle injected decoder that skips initialization if already done', async () => {
    const initializeCallCount = { count: 0 };
    const injectedDecoder = {
      initialize: vi.fn(async () => {
        // Simulate checking if already initialized
        if (initializeCallCount.count === 0) {
          initializeCallCount.count++;
        }
      }),
      decode: vi.fn(async () => ({
        width: 1,
        height: 1,
        data: new Uint8ClampedArray([0, 0, 0, 255]),
      })),
      free: vi.fn(() => undefined),
    };

    await convertHeic(new Uint8Array([1]), { decoder: injectedDecoder });
    await convertHeic(new Uint8Array([2]), { decoder: injectedDecoder });

    expect(injectedDecoder.decode).toHaveBeenCalledTimes(2);
  });

  describe('Quality validation', () => {
    it('should throw error when quality is negative', async () => {
      await expect(convertHeic(new Uint8Array([1]), { quality: -0.1 })).rejects.toThrow(
        'Quality must be a number between 0.0 and 1.0'
      );
    });

    it('should throw error when quality exceeds 1', async () => {
      await expect(convertHeic(new Uint8Array([1]), { quality: 1.1 })).rejects.toThrow(
        'Quality must be a number between 0.0 and 1.0'
      );
    });

    it('should throw error when quality is NaN', async () => {
      await expect(convertHeic(new Uint8Array([1]), { quality: NaN })).rejects.toThrow(
        'Quality must be a number between 0.0 and 1.0'
      );
    });

    it('should throw error when quality is not a number', async () => {
      await expect(convertHeic(new Uint8Array([1]), { quality: '0.5' as any })).rejects.toThrow(
        'Quality must be a number between 0.0 and 1.0'
      );
    });

    it('should accept quality of exactly 0', async () => {
      const result = await convertHeic(new Uint8Array([1]), { quality: 0 });
      expect(result).toBeInstanceOf(Blob);
    });

    it('should accept quality of exactly 1', async () => {
      const result = await convertHeic(new Uint8Array([1]), { quality: 1 });
      expect(result).toBeInstanceOf(Blob);
    });
  });

  describe('Shared decoder lifecycle', () => {
    it('should free shared decoder after each conversion when no custom decoder provided', async () => {
      await convertHeic(new Uint8Array([1]));
      
      // Shared decoder should be freed after conversion
      expect(mockState.decoderInstances[0].free).toHaveBeenCalledTimes(1);
    });

    it('should not free custom injected decoder', async () => {
      const injectedDecoder = {
        initialize: vi.fn(async () => undefined),
        decode: vi.fn(async () => ({
          width: 1,
          height: 1,
          data: new Uint8ClampedArray([0, 0, 0, 255]),
        })),
        free: vi.fn(() => undefined),
      };

      await convertHeic(new Uint8Array([1]), { decoder: injectedDecoder });

      // Custom decoder should not be freed by convertHeic
      expect(injectedDecoder.free).not.toHaveBeenCalled();
    });
  });

  describe('freeSharedDecoder', () => {
    it('should do nothing when no shared decoder exists', () => {
      // No conversion has been made yet
      expect(() => freeSharedDecoder()).not.toThrow();
    });

    it('should be safe to call multiple times', async () => {
      await convertHeic(new Uint8Array([1]));
      
      // Decoder was already freed after conversion
      expect(() => freeSharedDecoder()).not.toThrow();
      expect(() => freeSharedDecoder()).not.toThrow();
    });
  });
});
