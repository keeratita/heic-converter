import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockState = vi.hoisted(() => ({
  renderAndEncodeMock: vi.fn(async () => new Blob(['converted'], { type: 'image/png' })),
  defaultDecodedImage: {
    width: 100,
    height: 50,
    data: new Uint8ClampedArray(100 * 50 * 4),
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

import { convertHeic } from '../../src/index';

describe('convertHeic - Resize options', () => {
  beforeEach(() => {
    mockState.renderAndEncodeMock.mockClear();
    mockState.decoderInstances.length = 0;
  });

  it('should pass scale to renderAndEncode', async () => {
    await convertHeic(new Uint8Array([1]), { scale: 0.5 });

    expect(mockState.renderAndEncodeMock).toHaveBeenCalledWith(
      expect.any(Object),
      'jpeg',
      0.92,
      { maxWidth: undefined, maxHeight: undefined, scale: 0.5 }
    );
  });

  it('should pass maxWidth to renderAndEncode', async () => {
    await convertHeic(new Uint8Array([1]), { maxWidth: 800 });

    expect(mockState.renderAndEncodeMock).toHaveBeenCalledWith(
      expect.any(Object),
      'jpeg',
      0.92,
      { maxWidth: 800, maxHeight: undefined, scale: undefined }
    );
  });

  it('should pass maxHeight to renderAndEncode', async () => {
    await convertHeic(new Uint8Array([1]), { maxHeight: 600 });

    expect(mockState.renderAndEncodeMock).toHaveBeenCalledWith(
      expect.any(Object),
      'jpeg',
      0.92,
      { maxWidth: undefined, maxHeight: 600, scale: undefined }
    );
  });

  it('should pass all resize options together', async () => {
    await convertHeic(new Uint8Array([1]), { maxWidth: 800, maxHeight: 600, scale: 0.5 });

    expect(mockState.renderAndEncodeMock).toHaveBeenCalledWith(
      expect.any(Object),
      'jpeg',
      0.92,
      { maxWidth: 800, maxHeight: 600, scale: 0.5 }
    );
  });

  it('should not pass a resize argument when no resize options are given', async () => {
    await convertHeic(new Uint8Array([1]));

    expect(mockState.renderAndEncodeMock).toHaveBeenCalledWith(
      expect.any(Object),
      'jpeg',
      0.92
    );
  });

  it('should not pass a resize argument when resize options are explicitly undefined', async () => {
    await convertHeic(new Uint8Array([1]), {
      maxWidth: undefined,
      maxHeight: undefined,
      scale: undefined,
    });

    expect(mockState.renderAndEncodeMock).toHaveBeenCalledWith(
      expect.any(Object),
      'jpeg',
      0.92
    );
  });

  it('should throw when scale is zero', async () => {
    await expect(convertHeic(new Uint8Array([1]), { scale: 0 })).rejects.toThrow(
      'Scale must be a positive finite number'
    );
  });

  it('should throw when scale is negative', async () => {
    await expect(convertHeic(new Uint8Array([1]), { scale: -0.5 })).rejects.toThrow(
      'Scale must be a positive finite number'
    );
  });

  it('should throw when scale is NaN', async () => {
    await expect(convertHeic(new Uint8Array([1]), { scale: NaN })).rejects.toThrow(
      'Scale must be a positive finite number'
    );
  });

  it('should throw when scale is Infinity', async () => {
    await expect(convertHeic(new Uint8Array([1]), { scale: Infinity })).rejects.toThrow(
      'Scale must be a positive finite number'
    );
  });

  it('should throw when scale is not a number', async () => {
    await expect(convertHeic(new Uint8Array([1]), { scale: '0.5' as any })).rejects.toThrow(
      'Scale must be a positive finite number'
    );
  });

  it('should throw when maxWidth is invalid', async () => {
    await expect(convertHeic(new Uint8Array([1]), { maxWidth: 0 })).rejects.toThrow(
      'maxWidth must be a positive finite number'
    );
  });

  it('should throw when maxHeight is invalid', async () => {
    await expect(convertHeic(new Uint8Array([1]), { maxHeight: -10 })).rejects.toThrow(
      'maxHeight must be a positive finite number'
    );
  });

  it('should fail fast before creating a decoder for invalid resize options', async () => {
    await expect(convertHeic(new Uint8Array([1]), { scale: 0 })).rejects.toThrow();

    expect(mockState.decoderInstances).toHaveLength(0);
    expect(mockState.renderAndEncodeMock).not.toHaveBeenCalled();
  });

  it('should still pass quality and format alongside resize options', async () => {
    await convertHeic(new Uint8Array([1]), { to: 'webp', quality: 0.5, scale: 2 });

    expect(mockState.renderAndEncodeMock).toHaveBeenCalledWith(
      expect.any(Object),
      'webp',
      0.5,
      expect.objectContaining({ scale: 2 })
    );
  });
});
