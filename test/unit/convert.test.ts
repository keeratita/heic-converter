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

  it('should reuse shared decoder between calls and recreate after freeSharedDecoder', async () => {
    await convertHeic(new Uint8Array([1]));
    await convertHeic(new Uint8Array([2]));

    expect(mockState.decoderInstances).toHaveLength(1);
    expect(mockState.decoderInstances[0].initialize).toHaveBeenCalledTimes(2);
    expect(mockState.decoderInstances[0].free).not.toHaveBeenCalled();

    freeSharedDecoder();
    expect(mockState.decoderInstances[0].free).toHaveBeenCalledTimes(1);

    await convertHeic(new Uint8Array([3]));
    expect(mockState.decoderInstances).toHaveLength(2);
  });

  it('should throw on unsupported input type', async () => {
    const invalidInput = { foo: 'bar' } as unknown as Uint8Array;

    await expect(convertHeic(invalidInput)).rejects.toThrow(
      'Unsupported input type. Expected Blob, File, ArrayBuffer, or Uint8Array.',
    );
  });
});
