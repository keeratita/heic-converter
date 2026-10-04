import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockState, resetConvertMocks } from './helpers/convert-mocks';

vi.mock('../../src/render/canvas', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/render/canvas')>();
  const { mockState } = await import('./helpers/convert-mocks');
  return {
    ...actual,
    renderAndEncode: mockState.renderAndEncodeMock,
    assertEncodeEnvironment: mockState.assertEncodeEnvironmentMock,
    assertEncodeCapability: mockState.assertEncodeCapabilityMock,
  };
});

vi.mock('../../src/wasm', async () => {
  const { MockLibheifDecoder } = await import('./helpers/convert-mocks');
  return { LibheifDecoder: MockLibheifDecoder };
});

import { convertHeic } from '../../src/index';
import { HeicConverterError } from '../../src/errors';

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
        true,
        undefined,
      false);
    });

    it('should handle quality as 1.0 (float)', async () => {
      const result = await convertHeic(new Uint8Array([1]), { to: 'jpeg', quality: 1.0 });
      expect(result).toBeInstanceOf(Blob);
      expect(mockState.renderAndEncodeMock).toHaveBeenCalledWith(
        expect.any(Object),
        'jpeg',
        1.0,
        undefined,
        true,
        undefined,
      false);
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
      const formats: Array<'jpeg' | 'jpg' | 'png' | 'svg' | 'webp' | 'avif'> = [
        'jpeg',
        'jpg',
        'png',
        'svg',
        'webp',
        'avif',
      ];

      for (const format of formats) {
        mockState.renderAndEncodeMock.mockClear();
        await convertHeic(new Uint8Array([1]), { to: format });
        expect(mockState.renderAndEncodeMock).toHaveBeenCalledWith(
          expect.any(Object),
          format,
          0.92,
          undefined,
          true,
          undefined,
        false);
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
        true,
        undefined,
      false);
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
        true,
        undefined,
      false);
    });

    it('should handle undefined options', async () => {
      const result = await convertHeic(new Uint8Array([1]));

      expect(result).toBeInstanceOf(Blob);
      expect(mockState.renderAndEncodeMock).toHaveBeenCalledWith(
        expect.any(Object),
        'jpeg',
        0.92,
        undefined,
        true,
        undefined,
      false);
    });

    it('should handle options with extra properties', async () => {
      // Unknown keys must be tolerated, not rejected. Passed as a variable so
      // the excess-property check (which only fires on fresh object literals)
      // doesn't block the case being exercised.
      const options = { to: 'png' as const, quality: 0.8, onProgress: vi.fn(), extraProperty: 'should be ignored' };
      const result = await convertHeic(new Uint8Array([1]), options);

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
        true,
        undefined,
      false);
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

  it.each<[unknown, string?]>([['yes'], [1], [0], [null], [{}, 'object'], [[], 'array']])(
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
      true,
      undefined,
    false);
  });

  it('forwards applyOrientation: false to the renderer', async () => {
    await convertHeic(new Uint8Array([1]), { applyOrientation: false });
    expect(mockState.renderAndEncodeMock).toHaveBeenCalledWith(
      expect.anything(),
      'jpeg',
      0.92,
      undefined,
      false,
      undefined,
    false);
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

describe('convertHeic - Output shape', () => {
  beforeEach(() => {
    resetConvertMocks();
  });

  it('returns a Blob by default', async () => {
    const result = await convertHeic(new Uint8Array([1]));
    expect(result).toBeInstanceOf(Blob);
  });

  it("returns a Blob for an explicit output: 'blob'", async () => {
    const result = await convertHeic(new Uint8Array([1]), { output: 'blob' });
    expect(result).toBeInstanceOf(Blob);
  });

  it("output: 'dataUrl' returns a base64 data URL carrying the encoded type", async () => {
    const result = await convertHeic(new Uint8Array([1]), { output: 'dataUrl' });
    expect(typeof result).toBe('string');
    // The mocked renderer returns an image/png blob; the data URL must
    // inherit its type.
    expect(result.startsWith('data:image/png;base64,')).toBe(true);
    expect(result.length).toBeGreaterThan('data:image/png;base64,'.length);
  });

  it("output: 'arrayBuffer' returns the raw bytes", async () => {
    const result = await convertHeic(new Uint8Array([1]), { output: 'arrayBuffer' });
    expect(result).toBeInstanceOf(ArrayBuffer);
    expect(new TextDecoder().decode(new Uint8Array(result))).toBe('converted');
  });

  it.each<[unknown, string]>([
    ['base64', 'string'],
    ['Blob', 'case-wrong string'],
    ['', 'empty string'],
    ['dataURL', 'case-wrong string'],
    [1, 'number'],
    [{}, 'object'],
  ])('rejects invalid output value (%s as %s)', async (output) => {
    const error = await convertHeic(new Uint8Array([1]), {
      output: output as 'blob',
    }).catch((e) => e);
    expect(error).toMatchObject({ code: 'invalid_input' });
    expect(error.message).toContain("output must be one of 'blob'");
  });

  it('fails validation before any decoder is created', async () => {
    await expect(
      convertHeic(new Uint8Array([1]), { output: 'nope' as 'blob' })
    ).rejects.toMatchObject({ code: 'invalid_input' });
    expect(mockState.decoderInstances).toHaveLength(0);
  });
});

describe('convertHeic - Crop option', () => {
  beforeEach(() => {
    resetConvertMocks();
  });

  it('forwards the crop rectangle to the renderer as the 6th argument', async () => {
    await convertHeic(new Uint8Array([1]), { crop: { x: 10, y: 20, width: 30, height: 40 } });

    expect(mockState.renderAndEncodeMock).toHaveBeenCalledWith(
      expect.any(Object),
      'jpeg',
      expect.any(Number),
      undefined,
      true,
      { x: 10, y: 20, width: 30, height: 40 },
    false);
  });

  it('rejects malformed crop shapes before creating a decoder', async () => {
    const error = await convertHeic(new Uint8Array([1]), {
      crop: { x: 0, y: 0, width: 0, height: 5 },
    }).catch((e) => e);

    expect(error).toMatchObject({ code: 'invalid_crop' });
    expect(mockState.decoderInstances).toHaveLength(0);
  });

  it('propagates the renderer invalid_crop (range check) with its original code', async () => {
    // Range validation needs real decoded dimensions, so it happens in the
    // renderer; the library error must pass through unwrapped.
    mockState.renderAndEncodeMock.mockImplementationOnce(() => {
      throw new HeicConverterError('invalid_crop', 'crop 9999x9999 exceeds the image');
    });

    const error = await convertHeic(new Uint8Array([1]), {
      crop: { x: 0, y: 0, width: 9999, height: 9999 },
    }).catch((e) => e);

    expect(error).toMatchObject({ code: 'invalid_crop' });
    expect(error.message).toContain('exceeds the image');
  });
});

describe('convertHeic - AbortSignal', () => {
  beforeEach(() => {
    resetConvertMocks();
  });

  it('rejects an already-aborted signal with aborted before any work', async () => {
    const controller = new AbortController();
    controller.abort();

    const error = await convertHeic(new Uint8Array([1]), { signal: controller.signal }).catch(
      (e) => e
    );

    expect(error).toMatchObject({ code: 'aborted' });
    expect(mockState.decoderInstances).toHaveLength(0);
    expect(mockState.renderAndEncodeMock).not.toHaveBeenCalled();
  });

  it.each([[{}], [42], ['abort'], [null]])('rejects non-AbortSignal signal (%p)', async (signal) => {
    const error = await convertHeic(new Uint8Array([1]), {
      signal: signal as unknown as AbortSignal,
    }).catch((e) => e);
    expect(error).toMatchObject({ code: 'invalid_input' });
    expect(error.message).toContain('signal must be an AbortSignal');
  });

  it('accepts duck-typed AbortSignal-like objects', async () => {
    const fakeSignal = {
      aborted: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };

    const result = await convertHeic(new Uint8Array([1]), {
      signal: fakeSignal as unknown as AbortSignal,
    });
    expect(result).toBeInstanceOf(Blob);
  });

  it('stops after decode when the signal aborts during decoding, and still frees the decoder', async () => {
    const controller = new AbortController();
    mockState.decodeImpl = async () => {
      controller.abort();
      return { width: 1, height: 1, data: new Uint8ClampedArray([0, 0, 0, 255]) };
    };

    const error = await convertHeic(new Uint8Array([1]), { signal: controller.signal }).catch(
      (e) => e
    );

    expect(error).toMatchObject({ code: 'aborted' });
    expect(mockState.renderAndEncodeMock).not.toHaveBeenCalled();
    // The owned decoder is released even on the abort path.
    expect(mockState.decoderInstances[0].free).toHaveBeenCalled();
  });

  it('stops before creating a decoder when abort happens during input reading', async () => {
    const controller = new AbortController();
    const blobLike = {
      arrayBuffer: async () => {
        controller.abort();
        return new Uint8Array([1]).buffer;
      },
    };

    const error = await convertHeic(blobLike as unknown as Blob, {
      signal: controller.signal,
    }).catch((e) => e);

    expect(error).toMatchObject({ code: 'aborted' });
    expect(mockState.decoderInstances).toHaveLength(0);
  });

  it('does not emit the withheld 100% when aborted mid-decode', async () => {
    const controller = new AbortController();
    const onProgress = vi.fn();
    mockState.decodeImpl = async (_data, cb) => {
      cb?.(50);
      controller.abort();
      return { width: 1, height: 1, data: new Uint8ClampedArray([0, 0, 0, 255]) };
    };

    await expect(
      convertHeic(new Uint8Array([1]), { signal: controller.signal, onProgress })
    ).rejects.toMatchObject({ code: 'aborted' });

    expect(onProgress).toHaveBeenCalledWith(50);
    expect(onProgress).not.toHaveBeenCalledWith(100);
  });

  it('a post-completion abort does not disturb the resolved result', async () => {
    const controller = new AbortController();
    const result = await convertHeic(new Uint8Array([1]), { signal: controller.signal });
    controller.abort();
    expect(result).toBeInstanceOf(Blob);
  });

  it('options validation wins over a pre-aborted signal (deterministic argument errors)', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      convertHeic(new Uint8Array([1]), { signal: controller.signal, quality: 5 })
    ).rejects.toMatchObject({ code: 'invalid_quality' });
  });

  it('rejects avif before decoding when the environment cannot encode it', async () => {
    mockState.assertEncodeCapabilityMock.mockRejectedValueOnce(
      new HeicConverterError('format_unsupported', 'no avif here')
    );

    const error = await convertHeic(new Uint8Array([1]), { to: 'avif' }).catch((e) => e);

    expect(error).toMatchObject({ code: 'format_unsupported' });
    expect(mockState.assertEncodeCapabilityMock).toHaveBeenCalledWith('avif');
    expect(mockState.decoderInstances).toHaveLength(0);
    expect(mockState.renderAndEncodeMock).not.toHaveBeenCalled();
  });

  it('does not emit 100% progress when the conversion is aborted during encoding', async () => {
    const controller = new AbortController();
    mockState.decodeImpl = async (_data, onProgress) => {
      onProgress?.(50);
      return { width: 1, height: 1, data: new Uint8ClampedArray([1, 0, 0, 255]) };
    };
    mockState.renderAndEncodeMock.mockImplementationOnce(async () => {
      controller.abort(); // cancelled after encode started
      return new Blob([new Uint8Array([0xff, 0xd9])], { type: 'image/jpeg' });
    });
    const onProgress = vi.fn();

    const error = await convertHeic(new Uint8Array([1]), {
      signal: controller.signal,
      onProgress,
    }).catch((e) => e);

    expect(error).toMatchObject({ code: 'aborted' });
    const percents = onProgress.mock.calls.map((call) => call[0]);
    expect(percents).toContain(50);
    expect(percents).not.toContain(100);
  });
});
