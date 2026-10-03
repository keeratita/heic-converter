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

import { convertHeic, freeSharedDecoder } from '../../src/index';

const makeInjectedDecoder = (decoded = { width: 1, height: 1, data: new Uint8ClampedArray([0, 0, 0, 255]) }) => ({
  initialize: vi.fn(async () => undefined),
  decode: vi.fn(async () => decoded),
  free: vi.fn(() => undefined),
});

describe('convertHeic - Decoder Lifecycle', () => {
  beforeEach(() => {
    resetConvertMocks();
  });

  it('should use injected decoder instead of creating a default decoder', async () => {
    const injectedDecoder = makeInjectedDecoder({ width: 2, height: 2, data: new Uint8ClampedArray(16) });

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

  it('should free the per-conversion decoder after each conversion and create a new one for the next call', async () => {
    await convertHeic(new Uint8Array([1]));

    expect(mockState.decoderInstances).toHaveLength(1);
    expect(mockState.decoderInstances[0].initialize).toHaveBeenCalledTimes(1);
    expect(mockState.decoderInstances[0].free).toHaveBeenCalledTimes(1);

    await convertHeic(new Uint8Array([2]));
    expect(mockState.decoderInstances).toHaveLength(2);
    expect(mockState.decoderInstances[1].initialize).toHaveBeenCalledTimes(1);
    expect(mockState.decoderInstances[1].free).toHaveBeenCalledTimes(1);
  });

  it('should create a fresh decoder per conversion (freeSharedDecoder is a no-op)', async () => {
    await convertHeic(new Uint8Array([1]));
    const firstDecoder = mockState.decoderInstances[0];

    freeSharedDecoder();

    await convertHeic(new Uint8Array([2]));
    const secondDecoder = mockState.decoderInstances[1];

    expect(firstDecoder).not.toBe(secondDecoder);
    expect(firstDecoder.free).toHaveBeenCalledTimes(1);
  });

  it('should not create a default decoder when an injected decoder is used', async () => {
    const injectedDecoder = makeInjectedDecoder();

    await convertHeic(new Uint8Array([1]), { decoder: injectedDecoder });

    expect(mockState.decoderInstances).toHaveLength(0);
    expect(injectedDecoder.initialize).toHaveBeenCalledTimes(1);
  });

  it('should reuse injected decoder between calls', async () => {
    const injectedDecoder = makeInjectedDecoder();

    await convertHeic(new Uint8Array([1]), { decoder: injectedDecoder });
    await convertHeic(new Uint8Array([2]), { decoder: injectedDecoder });

    expect(injectedDecoder.initialize).toHaveBeenCalledTimes(2);
    expect(injectedDecoder.decode).toHaveBeenCalledTimes(2);
  });

  describe('Per-conversion decoder lifecycle', () => {
    it('should free the default decoder after each conversion when no custom decoder provided', async () => {
      await convertHeic(new Uint8Array([1]));

      expect(mockState.decoderInstances[0].free).toHaveBeenCalledTimes(1);
    });

    it('should not free custom injected decoder', async () => {
      const injectedDecoder = makeInjectedDecoder();

      await convertHeic(new Uint8Array([1]), { decoder: injectedDecoder });

      expect(injectedDecoder.free).not.toHaveBeenCalled();
    });

    it('should free the default decoder before render/encode starts', async () => {
      // Decoded pixels are a standalone copy, so the library releases the
      // decoder immediately — before the memory-heavy encode step.
      let freeCallsAtRender = -1;
      mockState.renderAndEncodeMock.mockImplementation(async () => {
        freeCallsAtRender = mockState.decoderInstances[0]?.free.mock.calls.length ?? -1;
        return new Blob(['converted'], { type: 'image/png' });
      });

      await convertHeic(new Uint8Array([1]));

      expect(freeCallsAtRender).toBe(1);
    });
  });

  describe('freeSharedDecoder (deprecated no-op)', () => {
    it('should do nothing when no decoder exists', () => {
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

    it('should tag initialize failures on injected decoders with decoder_init_failed code', async () => {
      const failingDecoder = {
        initialize: vi.fn().mockRejectedValue(new Error('Initialize failed')),
        decode: vi.fn(),
        free: vi.fn(),
      };

      const error = await convertHeic(new Uint8Array([1]), { decoder: failingDecoder }).catch((e) => e);
      // Injected-decoder init failures are wrapped with context and a code.
      expect(error.code).toBe('decoder_init_failed');
      expect(error.message).toContain('Failed to initialize HEIC decoder: Initialize failed');
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
      const customDecoder = makeInjectedDecoder();

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

    it('should wrap a non-Error value thrown by initialize', async () => {
      mockState.initializeThrowValue = 'boom';

      await expect(convertHeic(new Uint8Array([1]))).rejects.toThrow(
        'Failed to initialize HEIC decoder: boom'
      );
      expect(mockState.decoderInstances[0].free).toHaveBeenCalledTimes(1);
    });

    it('should free the default decoder when decode throws', async () => {
      // Configure the failure before starting: convertHeic reaches the
      // decoder only after an awaited input-resolution step, so the mock
      // instance does not exist yet when convertHeic() returns its promise.
      mockState.decodeImpl = async () => {
        throw new Error('Decode failed');
      };

      await expect(convertHeic(new Uint8Array([1]))).rejects.toThrow('Decode failed');
      expect(mockState.decoderInstances[0].free).toHaveBeenCalledTimes(1);
    });

    it('should free the default decoder when renderAndEncode throws', async () => {
      mockState.renderAndEncodeMock.mockRejectedValueOnce(new Error('Render failed'));

      await expect(convertHeic(new Uint8Array([1]))).rejects.toThrow('Render failed');
      expect(mockState.decoderInstances[0].free).toHaveBeenCalledTimes(1);
    });
  });
});
