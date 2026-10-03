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

describe('convertHeic - Options', () => {
  beforeEach(() => {
    resetConvertMocks();
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

    it('should tag invalid quality with the invalid_quality code', async () => {
      await expect(convertHeic(new Uint8Array([1]), { quality: 2 })).rejects.toMatchObject({
        code: 'invalid_quality',
      });
    });

    it('should validate quality even for formats that ignore it (png)', async () => {
      // A 0-100 scale value like `quality: 90` is fatal regardless of format,
      // so mistakes surface instead of silently producing default output.
      await expect(
        convertHeic(new Uint8Array([1]), { to: 'png', quality: 90 })
      ).rejects.toThrow('Quality must be a number between 0.0 and 1.0');
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
        0.0,
        undefined,
        true
      );
    });

    it('should handle quality as 1.0 (float)', async () => {
      const result = await convertHeic(new Uint8Array([1]), { to: 'jpeg', quality: 1.0 });
      expect(result).toBeInstanceOf(Blob);
      expect(mockState.renderAndEncodeMock).toHaveBeenCalledWith(
        expect.any(Object),
        'jpeg',
        1.0,
        undefined,
        true
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
      const formats: Array<'jpeg' | 'jpg' | 'png' | 'svg' | 'webp'> = [
        'jpeg',
        'jpg',
        'png',
        'svg',
        'webp',
      ];

      for (const format of formats) {
        mockState.renderAndEncodeMock.mockClear();
        await convertHeic(new Uint8Array([1]), { to: format });
        expect(mockState.renderAndEncodeMock).toHaveBeenCalledWith(
          expect.any(Object),
          format,
          0.92,
          undefined,
          true
        );
      }
    });

    it('should reject unknown formats before decoding', async () => {
      await expect(
        convertHeic(new Uint8Array([1]), { to: 'gif' as any })
      ).rejects.toMatchObject({
        code: 'invalid_format',
        message: expect.stringContaining('Unsupported output format: gif'),
      });
      // Failed fast: neither the decoder nor the encoder were touched.
      expect(mockState.decoderInstances).toHaveLength(0);
      expect(mockState.renderAndEncodeMock).not.toHaveBeenCalled();
    });

    it('should use default quality when not specified', async () => {
      await convertHeic(new Uint8Array([1, 2, 3]), { to: 'jpeg' });

      expect(mockState.renderAndEncodeMock).toHaveBeenCalledWith(
        expect.any(Object),
        'jpeg',
        0.92,
        undefined,
        true
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

  describe('Environment pre-check', () => {
    it('should fail before decoding when the environment cannot encode', async () => {
      // assertEncodeEnvironment is spied through the shared harness; make it
      // behave like plain Node (no canvas) and verify nothing else runs.
      mockState.assertEncodeEnvironmentMock.mockImplementationOnce(() => {
        throw new Error('Canvas is not supported in the current environment.');
      });

      await expect(convertHeic(new Uint8Array([1]))).rejects.toThrow(
        'Canvas is not supported in the current environment'
      );
      expect(mockState.decoderInstances).toHaveLength(0);
      expect(mockState.renderAndEncodeMock).not.toHaveBeenCalled();
    });
  });

  describe('Options edge cases', () => {
    it('should handle empty options object', async () => {
      const result = await convertHeic(new Uint8Array([1]), {});

      expect(result).toBeInstanceOf(Blob);
      expect(mockState.renderAndEncodeMock).toHaveBeenCalledWith(
        expect.any(Object),
        'jpeg',
        0.92,
        undefined,
        true
      );
    });

    it('should handle undefined options', async () => {
      const result = await convertHeic(new Uint8Array([1]));

      expect(result).toBeInstanceOf(Blob);
      expect(mockState.renderAndEncodeMock).toHaveBeenCalledWith(
        expect.any(Object),
        'jpeg',
        0.92,
        undefined,
        true
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
        0.92,
        undefined,
        true
      );
    });

    it('should handle options as null', async () => {
      const result = await convertHeic(new Uint8Array([1]), null as any);
      expect(result).toBeInstanceOf(Blob);
    });
  });
});

describe('convertHeic - applyOrientation', () => {
  beforeEach(() => {
    resetConvertMocks();
  });

  it.each([['yes'], [1], [0], [null], [{}, 'object'], [[], 'array']])(
    'rejects non-boolean applyOrientation %p with invalid_input',
    async (value) => {
      const error = await convertHeic(new Uint8Array([1]), {
        applyOrientation: value as unknown as boolean,
      }).catch((e) => e);
      expect(error).toBeInstanceOf(Error);
      expect(error.code).toBe('invalid_input');
      expect(error.message).toContain('applyOrientation must be a boolean');
    }
  );

  it('defaults applyOrientation to true for the renderer', async () => {
    await convertHeic(new Uint8Array([1]));
    expect(mockState.renderAndEncodeMock).toHaveBeenCalledWith(
      expect.anything(),
      'jpeg',
      0.92,
      undefined,
      true
    );
  });

  it('forwards applyOrientation: false to the renderer', async () => {
    await convertHeic(new Uint8Array([1]), { applyOrientation: false });
    expect(mockState.renderAndEncodeMock).toHaveBeenCalledWith(
      expect.anything(),
      'jpeg',
      0.92,
      undefined,
      false
    );
  });

  it('passes the decoded orientation through to the renderer', async () => {
    resetConvertMocks({
      decodedImage: {
        width: 2,
        height: 1,
        data: new Uint8ClampedArray(2 * 4),
        orientation: 6,
      },
    });

    await convertHeic(new Uint8Array([1]));

    const [decoded] = mockState.renderAndEncodeMock.mock.calls[0];
    expect(decoded.orientation).toBe(6);
  });
});
