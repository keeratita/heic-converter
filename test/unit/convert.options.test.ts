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

describe('convertHeic - Options', () => {
  beforeEach(() => {
    freeSharedDecoder();
    mockState.renderAndEncodeMock.mockClear();
    mockState.decoderInstances.length = 0;
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

    it('should handle quality as 0.0 (float)', async () => {
      const result = await convertHeic(new Uint8Array([1]), { to: 'jpeg', quality: 0.0 });
      expect(result).toBeInstanceOf(Blob);
      expect(mockState.renderAndEncodeMock).toHaveBeenCalledWith(
        expect.any(Object),
        'jpeg',
        0.0
      );
    });

    it('should handle quality as 1.0 (float)', async () => {
      const result = await convertHeic(new Uint8Array([1]), { to: 'jpeg', quality: 1.0 });
      expect(result).toBeInstanceOf(Blob);
      expect(mockState.renderAndEncodeMock).toHaveBeenCalledWith(
        expect.any(Object),
        'jpeg',
        1.0
      );
    });

    it('should handle quality as Infinity', async () => {
      await expect(convertHeic(new Uint8Array([1]), { quality: Infinity })).rejects.toThrow(
        'Quality must be a number between 0.0 and 1.0'
      );
    });

    it('should handle quality as -Infinity', async () => {
      await expect(convertHeic(new Uint8Array([1]), { quality: -Infinity })).rejects.toThrow(
        'Quality must be a number between 0.0 and 1.0'
      );
    });

    it('should handle quality as very large number', async () => {
      await expect(convertHeic(new Uint8Array([1]), { quality: 1000 })).rejects.toThrow(
        'Quality must be a number between 0.0 and 1.0'
      );
    });

    it('should handle quality as boolean', async () => {
      await expect(convertHeic(new Uint8Array([1]), { quality: true as any })).rejects.toThrow(
        'Quality must be a number between 0.0 and 1.0'
      );
    });
  });

  describe('Format handling', () => {
    it('should pass through all output formats correctly', async () => {
      const formats: Array<'jpeg' | 'jpg' | 'png' | 'svg'> = ['jpeg', 'jpg', 'png', 'svg'];

      for (const format of formats) {
        mockState.renderAndEncodeMock.mockClear();
        await convertHeic(new Uint8Array([1]), { to: format });
        expect(mockState.renderAndEncodeMock).toHaveBeenCalledWith(
          expect.any(Object),
          format,
          0.92
        );
      }
    });

    it('should use default quality when not specified', async () => {
      await convertHeic(new Uint8Array([1, 2, 3]), { to: 'jpeg' });

      expect(mockState.renderAndEncodeMock).toHaveBeenCalledWith(
        expect.any(Object),
        'jpeg',
        0.92
      );
    });

    it('should apply quality to PNG (though ignored by encoder)', async () => {
      const result = await convertHeic(new Uint8Array([1]), { to: 'png', quality: 0.5 });
      expect(result).toBeInstanceOf(Blob);
    });

    it('should apply quality to SVG (though ignored by encoder)', async () => {
      const result = await convertHeic(new Uint8Array([1]), { to: 'svg', quality: 0.5 });
      expect(result).toBeInstanceOf(Blob);
    });
  });

  describe('Options edge cases', () => {
    it('should handle empty options object', async () => {
      const result = await convertHeic(new Uint8Array([1]), {});

      expect(result).toBeInstanceOf(Blob);
      expect(mockState.renderAndEncodeMock).toHaveBeenCalledWith(
        expect.any(Object),
        'jpeg',
        0.92
      );
    });

    it('should handle undefined options', async () => {
      const result = await convertHeic(new Uint8Array([1]));

      expect(result).toBeInstanceOf(Blob);
      expect(mockState.renderAndEncodeMock).toHaveBeenCalledWith(
        expect.any(Object),
        'jpeg',
        0.92
      );
    });

    it('should handle options with extra properties', async () => {
      const result = await convertHeic(new Uint8Array([1]), {
        to: 'png',
        quality: 0.8,
        onProgress: vi.fn(),
        extraProperty: 'should be ignored' as any,
      });

      expect(result).toBeInstanceOf(Blob);
    });

    it('should handle options with undefined values for all properties', async () => {
      const result = await convertHeic(new Uint8Array([1]), {
        to: undefined,
        quality: undefined,
        decoder: undefined,
        onProgress: undefined,
      });

      expect(result).toBeInstanceOf(Blob);
      expect(mockState.renderAndEncodeMock).toHaveBeenCalledWith(
        expect.any(Object),
        'jpeg',
        0.92
      );
    });

    it('should handle options as null', async () => {
      const result = await convertHeic(new Uint8Array([1]), null as any);
      expect(result).toBeInstanceOf(Blob);
    });
  });
});
