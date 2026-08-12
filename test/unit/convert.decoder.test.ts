import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockState = vi.hoisted(() => ({
  // Deliberately a pass-through: convertHeic does not re-validate decoded
  // output — the real renderAndEncode does (covered in canvas.test.ts).
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
  initializeShouldThrow: false,
}));

vi.mock('../../src/render/canvas', () => ({
  renderAndEncode: mockState.renderAndEncodeMock,
}));

vi.mock('../../src/wasm', () => {
  class MockLibheifDecoder {
    initialize = vi.fn(async () => {
      if (mockState.initializeShouldThrow) {
        throw new Error('Init failed');
      }
    });
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

describe('convertHeic - Decoder Lifecycle', () => {
  beforeEach(() => {
    freeSharedDecoder();
    mockState.renderAndEncodeMock.mockClear();
    mockState.decoderInstances.length = 0;
    mockState.initializeShouldThrow = false;
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

    expect(mockState.decoderInstances).toHaveLength(1);
    expect(mockState.decoderInstances[0].initialize).toHaveBeenCalledTimes(1);
    expect(mockState.decoderInstances[0].free).toHaveBeenCalledTimes(1);

    await convertHeic(new Uint8Array([2]));
    expect(mockState.decoderInstances).toHaveLength(2);
    expect(mockState.decoderInstances[1].initialize).toHaveBeenCalledTimes(1);
    expect(mockState.decoderInstances[1].free).toHaveBeenCalledTimes(1);
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

    await convertHeic(new Uint8Array([1]), { decoder: injectedDecoder });
    await convertHeic(new Uint8Array([2]), { decoder: injectedDecoder });

    expect(injectedDecoder.initialize).toHaveBeenCalledTimes(2);
    expect(injectedDecoder.decode).toHaveBeenCalledTimes(2);
  });

  describe('Shared decoder lifecycle', () => {
    it('should free shared decoder after each conversion when no custom decoder provided', async () => {
      await convertHeic(new Uint8Array([1]));

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

      expect(injectedDecoder.free).not.toHaveBeenCalled();
    });
  });

  describe('freeSharedDecoder', () => {
    it('should do nothing when no shared decoder exists', () => {
      expect(() => freeSharedDecoder()).not.toThrow();
    });

    it('should be safe to call multiple times', async () => {
      await convertHeic(new Uint8Array([1]));

      expect(() => freeSharedDecoder()).not.toThrow();
      expect(() => freeSharedDecoder()).not.toThrow();
    });
  });

  describe('Decoder error handling', () => {
    it('should handle decoder.initialize that throws', async () => {
      const failingDecoder = {
        initialize: vi.fn().mockRejectedValue(new Error('Initialize failed')),
        decode: vi.fn(),
        free: vi.fn(),
      };

      await expect(convertHeic(new Uint8Array([1]), { decoder: failingDecoder }))
        .rejects.toThrow('Initialize failed');
    });

    it('should handle decoder.decode that throws', async () => {
      const failingDecoder = {
        initialize: vi.fn().mockResolvedValue(undefined),
        decode: vi.fn().mockRejectedValue(new Error('Decode failed')),
        free: vi.fn(),
      };

      await expect(convertHeic(new Uint8Array([1]), { decoder: failingDecoder }))
        .rejects.toThrow('Decode failed');
    });

    it('should forward decoder output to renderAndEncode (render layer validates it)', async () => {
      const garbageDecoder = {
        initialize: vi.fn().mockResolvedValue(undefined),
        decode: vi.fn().mockResolvedValue({
          width: -1,
          height: -1,
          data: new Uint8ClampedArray(0),
        }),
        free: vi.fn(),
      };

      const result = await convertHeic(new Uint8Array([1]), { decoder: garbageDecoder });

      // convertHeic does not re-validate decoded output; validation happens in
      // renderAndEncode (covered directly in canvas.test.ts).
      expect(result).toBeInstanceOf(Blob);
      expect(mockState.renderAndEncodeMock).toHaveBeenCalledWith(
        expect.objectContaining({ width: -1, height: -1 }),
        'jpeg',
        0.92
      );
    });

    it('should not call free on custom decoder even when conversion fails', async () => {
      const customDecoder = {
        initialize: vi.fn().mockResolvedValue(undefined),
        decode: vi.fn().mockResolvedValue({
          width: 1,
          height: 1,
          data: new Uint8ClampedArray([0, 0, 0, 255]),
        }),
        free: vi.fn(),
      };

      mockState.renderAndEncodeMock.mockRejectedValue(new Error('Render failed'));

      try {
        await convertHeic(new Uint8Array([1]), { decoder: customDecoder });
      } catch {
        // Expected
      }

      expect(customDecoder.free).not.toHaveBeenCalled();
    });

    it('should free the default decoder when initialize throws', async () => {
      mockState.initializeShouldThrow = true;

      await expect(convertHeic(new Uint8Array([1]))).rejects.toThrow('Init failed');
      expect(mockState.decoderInstances[0].free).toHaveBeenCalledTimes(1);
    });

    it('should free the default decoder when decode throws', async () => {
      const promise = convertHeic(new Uint8Array([1]));
      const decoder = mockState.decoderInstances[0];
      decoder.decode.mockRejectedValue(new Error('Decode failed'));

      await expect(promise).rejects.toThrow('Decode failed');
      expect(decoder.free).toHaveBeenCalledTimes(1);
    });

    it('should free the default decoder when renderAndEncode throws', async () => {
      mockState.renderAndEncodeMock.mockRejectedValueOnce(new Error('Render failed'));

      await expect(convertHeic(new Uint8Array([1]))).rejects.toThrow('Render failed');
      expect(mockState.decoderInstances[0].free).toHaveBeenCalledTimes(1);
    });
  });
});
