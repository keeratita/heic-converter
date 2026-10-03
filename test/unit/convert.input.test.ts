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

describe('convertHeic - Input Types', () => {
  beforeEach(() => {
    resetConvertMocks();
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
    const [decodeInput, decodeProgress] = mockState.decoderInstances[0].decode.mock.calls[0];
    expect(decodeInput).toBeInstanceOf(Uint8Array);
    // The callback passed to decode() is the library's normalizing wrapper
    // around the user callback, so assert the user callback got the percent.
    expect(decodeProgress).toBeInstanceOf(Function);
    decodeProgress(100);
    expect(progress).toHaveBeenCalledWith(100);
    expect(mockState.renderAndEncodeMock).toHaveBeenCalledWith(
      expect.objectContaining({ width: 1, height: 1 }),
      'png',
      0.5,
    );
  });

  it('should normalize out-of-range progress values before reaching the caller', async () => {
    const progress = vi.fn();

    await convertHeic(new Uint8Array([1]), { onProgress: progress });

    const decodeProgress = mockState.decoderInstances[0].decode.mock.calls[0][1];
    decodeProgress(150);
    decodeProgress(-20);
    decodeProgress(Number.NaN);
    // First 100: the mock decoder's own onProgress?.(100) call.
    // Then clamped 150→100, -20→0, NaN→0.
    expect(progress.mock.calls.map(([percent]) => percent)).toEqual([100, 100, 0, 0]);
  });

  it('should throw on unsupported input type', async () => {
    const invalidInput = { foo: 'bar' } as unknown as Uint8Array;

    await expect(convertHeic(invalidInput)).rejects.toThrow(
      'Unsupported input type. Expected Blob, File, ArrayBuffer, or Uint8Array.',
    );
  });

  it('should tag unsupported input errors with the invalid_input code', async () => {
    const invalidInput = { foo: 'bar' } as unknown as Uint8Array;

    await expect(convertHeic(invalidInput)).rejects.toMatchObject({ code: 'invalid_input' });
  });

  it('should handle File input correctly', async () => {
    const mockFile = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/heic' });
    (mockFile as any).name = 'test.heic';

    const result = await convertHeic(mockFile as File);

    expect(result).toBeInstanceOf(Blob);
    expect(mockState.decoderInstances).toHaveLength(1);
  });

  it('should accept cross-realm Blob-likes via duck typing', async () => {
    // A Blob from another realm fails `instanceof Blob` but exposes
    // arrayBuffer(); the library must still accept it.
    const crossRealmBlobLike = {
      arrayBuffer: async () => new Uint8Array([4, 5, 6]).buffer,
    } as unknown as Blob;

    const result = await convertHeic(crossRealmBlobLike);

    expect(result).toBeInstanceOf(Blob);
    const decodedInput = mockState.decoderInstances[0].decode.mock.calls[0][0];
    expect(Array.from(decodedInput)).toEqual([4, 5, 6]);
  });

  it('should accept other ArrayBufferViews (DataView)', async () => {
    const view = new DataView(new ArrayBuffer(3));
    view.setUint8(0, 7);
    view.setUint8(1, 8);
    view.setUint8(2, 9);

    const result = await convertHeic(view as unknown as Uint8Array);

    expect(result).toBeInstanceOf(Blob);
    const decodedInput = mockState.decoderInstances[0].decode.mock.calls[0][0];
    expect(Array.from(decodedInput)).toEqual([7, 8, 9]);
  });

  it('should handle Uint8Array input directly without conversion', async () => {
    const input = new Uint8Array([10, 20, 30, 40, 50]);

    await convertHeic(input);

    const decodedInput = mockState.decoderInstances[0].decode.mock.calls[0][0];
    expect(decodedInput).toBeInstanceOf(Uint8Array);
    expect(Array.from(decodedInput)).toEqual([10, 20, 30, 40, 50]);
    // Fast path: the Uint8Array is handed to decode() without a copy.
    expect(decodedInput).toBe(input);
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
