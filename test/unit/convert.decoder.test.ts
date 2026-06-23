import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockState = vi.hoisted(() => ({
  renderAndEncodeMock: vi.fn(async (decoded: unknown) => {
    if (
      typeof decoded !== 'object' ||
      decoded === null ||
      !('width' in decoded) ||
      !('height' in decoded)
    ) {
      throw new Error('Invalid decoded image');
    }
    const width = (decoded as { width: number }).width;
    const height = (decoded as { height: number }).height;
    if (width <= 0 || height <= 0) {
      throw new Error('Invalid dimensions');
    }
    const expectedLength = width * height * 4;
    const data = (decoded as { data?: Uint8ClampedArray }).data;
    if (data?.length !== expectedLength) {
      throw new Error('Image data length mismatch');
    }
    return new Blob(['converted'], { type: 'image/png' });
  }),
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

describe('convertHeic - Decoder Lifecycle', () => {
  beforeEach(() => {
    freeSharedDecoder();
    mockState.renderAndEncodeMock.mockClear();
    mockState.decoderInstances.length = 0;
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

    it('should handle decoder.decode returning invalid dimensions', async () => {
      const invalidDecoder = {
        initialize: vi.fn().mockResolvedValue(undefined),
        decode: vi.fn().mockResolvedValue({
          width: -1,
          height: -1,
          data: new Uint8ClampedArray(0),
        }),
        free: vi.fn(),
      };

      await expect(convertHeic(new Uint8Array([1]), { decoder: invalidDecoder }))
        .rejects.toThrow();
    });

    it('should handle decoder.decode returning wrong data length', async () => {
      const invalidDecoder = {
        initialize: vi.fn().mockResolvedValue(undefined),
        decode: vi.fn().mockResolvedValue({
          width: 100,
          height: 100,
          data: new Uint8ClampedArray(100),
        }),
        free: vi.fn(),
      };

      await expect(convertHeic(new Uint8Array([1]), { decoder: invalidDecoder }))
        .rejects.toThrow('Image data length mismatch');
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
  });
});
