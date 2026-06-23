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

describe('convertHeic - Input Types', () => {
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

  it('should handle empty Blob input', async () => {
    const emptyBlob = new Blob([]);
    const result = await convertHeic(emptyBlob);
    expect(result).toBeInstanceOf(Blob);
  });

  it('should handle empty ArrayBuffer input', async () => {
    const emptyBuffer = new ArrayBuffer(0);
    const result = await convertHeic(emptyBuffer);
    expect(result).toBeInstanceOf(Blob);
  });

  it('should handle empty Uint8Array input', async () => {
    const emptyArray = new Uint8Array([]);
    const result = await convertHeic(emptyArray);
    expect(result).toBeInstanceOf(Blob);
  });

  it('should handle very large ArrayBuffer', async () => {
    const largeBuffer = new ArrayBuffer(10000000); // 10MB
    const view = new Uint8Array(largeBuffer);
    view.fill(0);

    const result = await convertHeic(largeBuffer);
    expect(result).toBeInstanceOf(Blob);
  });

  it('should handle Blob with custom type', async () => {
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'application/octet-stream' });
    const result = await convertHeic(blob);
    expect(result).toBeInstanceOf(Blob);
  });

  it('should handle File-like object', async () => {
    const fileLike = new Blob([new Uint8Array([1, 2, 3])]);
    (fileLike as any).name = 'test.heic';
    (fileLike as any).lastModified = Date.now();

    const result = await convertHeic(fileLike as File);
    expect(result).toBeInstanceOf(Blob);
  });
});
