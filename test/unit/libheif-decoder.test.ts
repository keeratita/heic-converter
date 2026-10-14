import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { LibheifDecoder } from '../../src/wasm/wrapper';
import { isDecoderPoisoned } from '../../src/wasm/fault';
import { HeicConverterError } from '../../src/errors';

// Use vi.hoisted to properly hoist the mock factory
const mockState = vi.hoisted(() => {
  const heap = new Uint8Array(64 * 1024);
  const mockDecoderInstance: {
    decode: Mock<(data: Uint8Array, onProgress: any) => unknown>;
    decodeFromPointer: Mock<(ptr: number, len: number, onProgress: any) => unknown>;
    delete: Mock<() => void>;
  } = { decode: vi.fn(), decodeFromPointer: vi.fn(), delete: vi.fn() };
  const mockModule: Record<string, unknown> = {
    HeicDecoder: class MockHeicDecoder {
      constructor() {
        return mockDecoderInstance;
      }
    },
    // The pointer API is mandatory since the wrapper stopped probing per call
    // (initialize() verifies it once and fails with decoder_init_failed).
    _malloc: vi.fn(() => 16),
    _free: vi.fn(),
    HEAPU8: heap,
  };
  // Mirror the real C++ binding: read back the bytes the wrapper wrote with
  // HEAPU8.set and hand them to the same `decode` mock the tests control, so
  // decode-behavior tests keep asserting on bytes + progress.
  mockDecoderInstance.decodeFromPointer.mockImplementation(
    (ptr: number, len: number, progress: ((percent: number) => void) | null) =>
      mockDecoderInstance.decode(heap.slice(ptr, ptr + len), progress)
  );
  return { mockModuleFactory: vi.fn(), mockDecoderInstance, mockModule, mockHeap: heap };
});

vi.mock('../../src/wasm/wrapper/heic-decoder.js', () => ({
  default: mockState.mockModuleFactory,
}));

describe('LibheifDecoder (mocked glue)', () => {
  beforeEach(() => {
    mockState.mockModuleFactory.mockResolvedValue(mockState.mockModule);
    mockState.mockDecoderInstance.decode.mockClear();
    mockState.mockDecoderInstance.decodeFromPointer.mockClear();
    mockState.mockDecoderInstance.delete.mockClear();
    // Tests write at fixed offsets against the `_malloc -> 16` slot; a shared
    // dirty heap would make results order-dependent across tests.
    mockState.mockHeap.fill(0);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('Initialization', () => {
    it('should create decoder instance without options', async () => {
      const decoder = new LibheifDecoder();
      await decoder.initialize();

      expect(mockState.mockModuleFactory).toHaveBeenCalledWith({});
    });

    it('should create decoder instance with wasmBinary option', async () => {
      const wasmBinary = new ArrayBuffer(100);
      const decoder = new LibheifDecoder({ wasmBinary });
      await decoder.initialize();

      expect(mockState.mockModuleFactory).toHaveBeenCalledWith({ wasmBinary });
    });

    it('should create decoder instance with locateFile option', async () => {
      const locateFile = (path: string) => `https://cdn.example.com/${path}`;
      const decoder = new LibheifDecoder({ locateFile });
      await decoder.initialize();

      expect(mockState.mockModuleFactory).toHaveBeenCalledWith({ locateFile });
    });

    it('should create decoder instance with both options', async () => {
      const wasmBinary = new ArrayBuffer(100);
      const locateFile = (path: string) => `https://cdn.example.com/${path}`;
      const decoder = new LibheifDecoder({ wasmBinary, locateFile });
      await decoder.initialize();

      expect(mockState.mockModuleFactory).toHaveBeenCalledWith({ wasmBinary, locateFile });
    });

    it('should not reinitialize if already initialized', async () => {
      const decoder = new LibheifDecoder();
      await decoder.initialize();
      await decoder.initialize();

      expect(mockState.mockModuleFactory).toHaveBeenCalledTimes(1);
    });

    it('should not instantiate the module twice for concurrent initialize calls', async () => {
      const decoder = new LibheifDecoder();
      await Promise.all([decoder.initialize(), decoder.initialize()]);

      expect(mockState.mockModuleFactory).toHaveBeenCalledTimes(1);
    });

    it('should allow retrying after module initialization fails', async () => {
      mockState.mockModuleFactory
        .mockRejectedValueOnce(new Error('fetch failed'))
        .mockResolvedValueOnce(mockState.mockModule);

      const decoder = new LibheifDecoder();
      await expect(decoder.initialize()).rejects.toThrow('fetch failed');

      await decoder.initialize();
      expect(mockState.mockModuleFactory).toHaveBeenCalledTimes(2);
    });
  });

  describe('Decoding', () => {
    it('should decode valid HEIC data successfully', async () => {
      const mockData = new Uint8Array([1, 2, 3, 4]);
      const mockResult = {
        width: 100,
        height: 100,
        data: new Uint8Array(100 * 100 * 4),
      };
      mockState.mockDecoderInstance.decode.mockReturnValue(mockResult);

      const decoder = new LibheifDecoder();
      await decoder.initialize();
      const result = await decoder.decode(mockData);

      expect(result).toBeDefined();
      expect(result.width).toBe(100);
      expect(result.height).toBe(100);
      expect(result.data).toBeInstanceOf(Uint8ClampedArray);
      expect(mockState.mockDecoderInstance.decode).toHaveBeenCalledWith(mockData, null);
    });

    it('should call onProgress callback during decode', async () => {
      const mockData = new Uint8Array([1, 2, 3, 4]);
      const mockResult = {
        width: 100,
        height: 100,
        data: new Uint8Array(100 * 100 * 4),
      };
      
      // Mock decode to call the progress callback
      mockState.mockDecoderInstance.decode.mockImplementation((data: Uint8Array, onProgress?: (percent: number) => void) => {
        onProgress?.(50); // Call progress callback during decode
        return mockResult;
      });

      const progressCallback = vi.fn();
      const decoder = new LibheifDecoder();
      await decoder.initialize();
      await decoder.decode(mockData, progressCallback);

      expect(progressCallback).toHaveBeenCalledWith(50);
    });

    it('should throw error when decode returns null', async () => {
      const mockData = new Uint8Array([1, 2, 3, 4]);
      mockState.mockDecoderInstance.decode.mockReturnValue(null);

      const decoder = new LibheifDecoder();
      await decoder.initialize();

      await expect(decoder.decode(mockData)).rejects.toThrow('HEIC decoding failed');
    });

    it('should throw error when decode returns error string', async () => {
      const mockData = new Uint8Array([1, 2, 3, 4]);
      mockState.mockDecoderInstance.decode.mockReturnValue('Invalid HEIC format');

      const decoder = new LibheifDecoder();
      await decoder.initialize();

      await expect(decoder.decode(mockData)).rejects.toThrow('HEIC decoding failed: Invalid HEIC format');
    });

    it('should clamp an oversized decoder error detail to 200 characters', async () => {
      // Decoder strings reach error.message (logs, demo DOM): oversized
      // details clamp to 200 chars with an ellipsis, control chars stripped.
      const mockData = new Uint8Array([1, 2, 3, 4]);
      mockState.mockDecoderInstance.decode.mockReturnValue(
        `heif: ${'x'.repeat(300)}\u0000trailing`
      );

      const decoder = new LibheifDecoder();
      await decoder.initialize();

      const error = await decoder.decode(mockData).catch((e) => e);
      expect(error).toBeInstanceOf(HeicConverterError);
      // Full template: `HEIC decoding failed: ${detail} (input: ${bytes} bytes)`.
      const prefix = 'HEIC decoding failed: ';
      const suffix = ` (input: ${mockData.byteLength} bytes)`;
      expect(error.message.startsWith(prefix)).toBe(true);
      expect(error.message.endsWith(suffix)).toBe(true);
      const detail = error.message.slice(prefix.length, -suffix.length);
      expect(detail).toHaveLength(200);
      expect(detail.endsWith('...')).toBe(true);
      // Matching control characters *is* the point: asserting the strip step.
      // eslint-disable-next-line no-control-regex
      expect(detail).not.toMatch(/[\u0000\u0007]/);
    });

    it('should auto-initialize if not initialized before decode', async () => {
      const mockData = new Uint8Array([1, 2, 3, 4]);
      const mockResult = {
        width: 100,
        height: 100,
        data: new Uint8Array(100 * 100 * 4),
      };
      mockState.mockDecoderInstance.decode.mockReturnValue(mockResult);

      const decoder = new LibheifDecoder();
      // Don't call initialize() - should auto-initialize in decode()
      await decoder.decode(mockData);

      expect(mockState.mockModuleFactory).toHaveBeenCalledTimes(1);
    });

    it('should convert result data to Uint8ClampedArray', async () => {
      const mockData = new Uint8Array([1, 2, 3, 4]);
      const rawData = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255]);
      const mockResult = {
        width: 2,
        height: 1,
        data: rawData,
      };
      mockState.mockDecoderInstance.decode.mockReturnValue(mockResult);

      const decoder = new LibheifDecoder();
      await decoder.initialize();
      const result = await decoder.decode(mockData);

      expect(result.data).toBeInstanceOf(Uint8ClampedArray);
      expect(result.data[0]).toBe(255);
      expect(result.data[1]).toBe(0);
      expect(result.data[2]).toBe(0);
      expect(result.data[3]).toBe(255);
    });

    it('should return an independent copy of decoded data, not a WASM view', async () => {
      const mockData = new Uint8Array([1, 2, 3, 4]);
      // The zero-copy wrap is skipped only when the pixels prove they are a
      // heap view — place them inside the module's own HEAPU8 buffer.
      const rawData = new Uint8Array(mockState.mockHeap.buffer, 32, 4);
      rawData.set([9, 8, 7, 6]);
      mockState.mockDecoderInstance.decode.mockReturnValue({
        width: 1,
        height: 1,
        data: rawData,
      });

      const decoder = new LibheifDecoder();
      await decoder.initialize();
      const result = await decoder.decode(mockData);

      expect(result.data.buffer).not.toBe(mockState.mockHeap.buffer);
      // Mutating the raw WASM-side buffer must not affect the returned copy.
      rawData[0] = 255;
      expect(result.data[0]).toBe(9);
    });
  });

  describe('Freeing resources', () => {
    it('should call delete on decoder instance', async () => {
      const decoder = new LibheifDecoder();
      await decoder.initialize();

      decoder.free();

      expect(mockState.mockDecoderInstance.delete).toHaveBeenCalled();
    });

    it('should handle multiple free calls gracefully', async () => {
      const decoder = new LibheifDecoder();
      await decoder.initialize();

      decoder.free();
      decoder.free(); // Should not throw

      expect(mockState.mockDecoderInstance.delete).toHaveBeenCalledTimes(1);
    });

    it('should allow creating new decoder after free', async () => {
      const decoder1 = new LibheifDecoder();
      await decoder1.initialize();
      decoder1.free();

      const decoder2 = new LibheifDecoder();
      await decoder2.initialize();

      expect(mockState.mockModuleFactory).toHaveBeenCalledTimes(2);
    });
  });

  describe('Edge cases', () => {
    it('should handle empty Uint8Array input', async () => {
      const mockData = new Uint8Array([]);
      mockState.mockDecoderInstance.decode.mockReturnValue(null);

      const decoder = new LibheifDecoder();
      await decoder.initialize();

      await expect(decoder.decode(mockData)).rejects.toThrow();
    });

    it('should handle large image dimensions', async () => {
      const mockData = new Uint8Array([1, 2, 3, 4]);
      const mockResult = {
        width: 4096,
        height: 4096,
        data: new Uint8Array(4096 * 4096 * 4),
      };
      mockState.mockDecoderInstance.decode.mockReturnValue(mockResult);

      const decoder = new LibheifDecoder();
      await decoder.initialize();
      const result = await decoder.decode(mockData);

      expect(result.width).toBe(4096);
      expect(result.height).toBe(4096);
    });

    it('should handle small image dimensions', async () => {
      const mockData = new Uint8Array([1, 2, 3, 4]);
      const mockResult = {
        width: 1,
        height: 1,
        data: new Uint8Array(4),
      };
      mockState.mockDecoderInstance.decode.mockReturnValue(mockResult);

      const decoder = new LibheifDecoder();
      await decoder.initialize();
      const result = await decoder.decode(mockData);

      expect(result.width).toBe(1);
      expect(result.height).toBe(1);
      expect(result.data.length).toBe(4);
    });

    it('should handle square images', async () => {
      const mockData = new Uint8Array([1, 2, 3, 4]);
      const size = 512;
      const mockResult = {
        width: size,
        height: size,
        data: new Uint8Array(size * size * 4),
      };
      mockState.mockDecoderInstance.decode.mockReturnValue(mockResult);

      const decoder = new LibheifDecoder();
      await decoder.initialize();
      const result = await decoder.decode(mockData);

      expect(result.width).toBe(size);
      expect(result.height).toBe(size);
      expect(result.data.length).toBe(size * size * 4);
    });

    it('should handle non-square images', async () => {
      const mockData = new Uint8Array([1, 2, 3, 4]);
      const mockResult = {
        width: 1920,
        height: 1080,
        data: new Uint8Array(1920 * 1080 * 4),
      };
      mockState.mockDecoderInstance.decode.mockReturnValue(mockResult);

      const decoder = new LibheifDecoder();
      await decoder.initialize();
      const result = await decoder.decode(mockData);

      expect(result.width).toBe(1920);
      expect(result.height).toBe(1080);
      expect(result.data.length).toBe(1920 * 1080 * 4);
    });
  });

  describe('Progress callback', () => {
    it('should pass null when no progress callback is provided', async () => {
      const mockData = new Uint8Array([1, 2, 3, 4]);
      const mockResult = {
        width: 100,
        height: 100,
        data: new Uint8Array(100 * 100 * 4),
      };
      mockState.mockDecoderInstance.decode.mockReturnValue(mockResult);

      const decoder = new LibheifDecoder();
      await decoder.initialize();
      await decoder.decode(mockData);

      expect(mockState.mockDecoderInstance.decode).toHaveBeenCalledWith(mockData, null);
    });

    it('should pass a normalizing wrapper around the progress callback', async () => {
      const mockData = new Uint8Array([1, 2, 3, 4]);
      const mockResult = {
        width: 100,
        height: 100,
        data: new Uint8Array(100 * 100 * 4),
      };
      mockState.mockDecoderInstance.decode.mockReturnValue(mockResult);

      const progressCallback = vi.fn();
      const decoder = new LibheifDecoder();
      await decoder.initialize();
      await decoder.decode(mockData, progressCallback);

      const [passedData, passedProgress] = mockState.mockDecoderInstance.decode.mock.calls[0];
      // Bytes round-trip through the fake WASM heap (the wrapper's only
      // path), so compare content — identity lives on the progress wrapper.
      expect(passedData).toEqual(mockData);
      expect(passedProgress).toBeInstanceOf(Function);
      expect(passedProgress).not.toBe(progressCallback);
      // Values leaving the wrapper are clamped to the documented 0-100 range.
      passedProgress(50);
      passedProgress(150);
      passedProgress(-5);
      passedProgress(Number.NaN);
      expect(progressCallback.mock.calls.map(([percent]) => percent)).toEqual([50, 100, 0, 0]);
    });

    it('should attribute a throwing host progress callback as progress_callback_failed', async () => {
      const mockData = new Uint8Array([1, 2, 3, 4]);
      const mockResult = {
        width: 100,
        height: 100,
        data: new Uint8Array(100 * 100 * 4),
      };
      mockState.mockDecoderInstance.decode.mockImplementation(
        (_data: Uint8Array, onProgress?: (percent: number) => void) => {
          onProgress?.(50); // host callback throws below; must not reach WASM
          return mockResult;
        }
      );

      const decoder = new LibheifDecoder();
      await decoder.initialize();

      const error = await decoder
        .decode(mockData, () => {
          throw new Error('host exploded');
        })
        .catch((e) => e);
      expect(error.code).toBe('progress_callback_failed');
      expect(error.message).toContain('onProgress callback threw during decode');
      expect(error.message).toContain('host exploded');
    });
  });

  describe('Module options', () => {
    it('should pass locateFile function to module factory', async () => {
      const customLocateFile = vi.fn((path: string) => `custom/${path}`);
      const decoder = new LibheifDecoder({ locateFile: customLocateFile });
      await decoder.initialize();

      expect(mockState.mockModuleFactory).toHaveBeenCalledWith(expect.objectContaining({
        locateFile: expect.any(Function),
      }));
    });

    it('should pass wasmBinary to module factory', async () => {
      const wasmBinary = new ArrayBuffer(1024);
      const decoder = new LibheifDecoder({ wasmBinary });
      await decoder.initialize();

      expect(mockState.mockModuleFactory).toHaveBeenCalledWith({ wasmBinary });
    });

    it('should pass moduleOverrides through to the module factory', async () => {
      const decoder = new LibheifDecoder({
        moduleOverrides: { print: () => undefined },
        wasmBinary: new ArrayBuffer(4),
      });
      await decoder.initialize();

      const [moduleArgs] = mockState.mockModuleFactory.mock.calls[0];
      expect(moduleArgs.print).toBeInstanceOf(Function);
      expect(moduleArgs.wasmBinary).toBeInstanceOf(ArrayBuffer);
    });

    it('should handle undefined options', async () => {
      const decoder = new LibheifDecoder(undefined);
      await decoder.initialize();

      expect(mockState.mockModuleFactory).toHaveBeenCalledWith({});
    });
  });

  describe('Input fast path (decodeFromPointer) and buffer ownership', () => {
    const heap = new ArrayBuffer(1024);
    let fastInstance: {
      decode: ReturnType<typeof vi.fn>;
      decodeFromPointer: ReturnType<typeof vi.fn>;
      delete: ReturnType<typeof vi.fn>;
    };
    let fastModule: Record<string, unknown>;

    beforeEach(() => {
      fastInstance = {
        decode: vi.fn(),
        decodeFromPointer: vi.fn(() => ({
          width: 1,
          height: 1,
          data: new Uint8Array([1, 2, 3, 4]),
        })),
        delete: vi.fn(),
      };
      fastModule = {
        HeicDecoder: class {
          constructor() {
            return fastInstance;
          }
        },
        _malloc: vi.fn(() => 16),
        _free: vi.fn(),
        HEAPU8: new Uint8Array(heap),
      };
      mockState.mockModuleFactory.mockResolvedValue(fastModule);
    });

    it('should bulk-load input into the WASM heap and call decodeFromPointer', async () => {
      const mockData = new Uint8Array([10, 20, 30, 40]);
      const decoder = new LibheifDecoder();
      await decoder.initialize();
      const result = await decoder.decode(mockData);

      expect((fastModule as { _malloc: ReturnType<typeof vi.fn> })._malloc).toHaveBeenCalledWith(4);
      expect((fastModule as { HEAPU8: Uint8Array }).HEAPU8!.subarray(16, 20)).toEqual(
        new Uint8Array([10, 20, 30, 40])
      );
      expect(fastInstance.decodeFromPointer).toHaveBeenCalledWith(16, 4, null);
      expect(fastInstance.decode).not.toHaveBeenCalled();
      expect((fastModule as { _free: ReturnType<typeof vi.fn> })._free).toHaveBeenCalledWith(16);
      expect(result.width).toBe(1);
    });

    it('should free the malloc-ed input even when decodeFromPointer throws', async () => {
      fastInstance.decodeFromPointer.mockImplementation(() => {
        throw new Error('wasm exploded');
      });
      const decoder = new LibheifDecoder();
      await decoder.initialize();

      // SECURITY.md promises a typed error rather than a raw module fault, with
      // the original kept on `cause`, and a faulted heap must never be reused.
      const error = await decoder.decode(new Uint8Array([1])).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(HeicConverterError);
      expect((error as HeicConverterError).code).toBe('decode_failed');
      expect(((error as HeicConverterError).cause as Error).message).toContain('wasm exploded');
      expect(isDecoderPoisoned(decoder)).toBe(true);
      expect((fastModule as { _free: ReturnType<typeof vi.fn> })._free).toHaveBeenCalledWith(16);
    });

    it('should report an allocation failure when _malloc returns 0', async () => {
      (fastModule._malloc as ReturnType<typeof vi.fn>).mockReturnValue(0);

      const decoder = new LibheifDecoder();
      await decoder.initialize();
      const error = await decoder.decode(new Uint8Array([1, 2, 3, 4])).catch((e) => e);

      expect(error.code).toBe('decode_failed');
      expect(error.message).toContain('allocate');
      expect(fastInstance.decodeFromPointer).not.toHaveBeenCalled();
      expect(fastModule._free).not.toHaveBeenCalled();
    });

    it('should copy pixel data that is a view into the WASM heap', async () => {
      // Glue builds that return a heap view must not leak the view to callers.
      const heapView = new Uint8Array(heap, 0, 4);
      heapView.set([7, 7, 7, 7]);
      const heapModule = { ...fastModule, HEAPU8: new Uint8Array(heap) };
      const heapInstance = {
        decode: vi.fn(() => ({ width: 1, height: 1, data: heapView })),
        decodeFromPointer: vi.fn(() => ({ width: 1, height: 1, data: heapView })),
        delete: vi.fn(),
      };
      (heapModule as unknown as { HeicDecoder: unknown }).HeicDecoder = class {
        constructor() {
          return heapInstance;
        }
      };
      mockState.mockModuleFactory.mockResolvedValue(heapModule);

      const decoder = new LibheifDecoder();
      await decoder.initialize();
      const result = await decoder.decode(new Uint8Array([1]));

      expect(result.data.buffer).not.toBe(heap);
      expect(Array.from(result.data)).toEqual([7, 7, 7, 7]);

      // Mutating the heap afterwards must not corrupt the returned pixels.
      heapView.set([1, 2, 3, 4]);
      expect(Array.from(result.data)).toEqual([7, 7, 7, 7]);
    });

    it('should share (not copy) JS-owned pixel buffers when they are not heap views', async () => {
      // The C++ wrapper builds pixels with a JS Uint8Array; when the live
      // HEAPU8 proves the buffer is not a heap view we skip the defensive
      // second copy.
      const jsOwned = new Uint8Array([5, 6, 7, 8]);
      const jsOwnedInstance = {
        decode: vi.fn(() => ({ width: 1, height: 1, data: jsOwned })),
        decodeFromPointer: vi.fn(() => ({ width: 1, height: 1, data: jsOwned })),
        delete: vi.fn(),
      };
      const jsOwnedModule = {
        ...fastModule,
        HEAPU8: new Uint8Array(heap),
        HeicDecoder: class {
          constructor() {
            return jsOwnedInstance;
          }
        },
      };
      mockState.mockModuleFactory.mockResolvedValue(jsOwnedModule);

      const decoder = new LibheifDecoder();
      await decoder.initialize();
      const result = await decoder.decode(new Uint8Array([1]));

      expect(result.data).toBeInstanceOf(Uint8ClampedArray);
      expect(result.data.buffer).toBe(jsOwned.buffer);
      expect(Array.from(result.data)).toEqual([5, 6, 7, 8]);
    });
  });

  describe('Glue API verification and fault bookkeeping', () => {
    it('rejects with decoder_init_failed when the glue lacks the pointer API', async () => {
      // The pinned build always exports the pointer API; a glue missing it is
      // tampered or a mismatched partial upload — a load-stage verdict.
      const brokenInstance = {
        decode: vi.fn(),
        decodeFromPointer: vi.fn(),
        delete: vi.fn(),
      };
      mockState.mockModuleFactory.mockResolvedValue({
        HeicDecoder: class {
          constructor() {
            return brokenInstance;
          }
        },
        _malloc: vi.fn(() => 16),
        _free: vi.fn(),
        // HEAPU8 missing
      });

      const decoder = new LibheifDecoder();
      const error = await decoder.initialize().catch((e: unknown) => e);

      expect(error).toBeInstanceOf(HeicConverterError);
      expect((error as HeicConverterError).code).toBe('decoder_init_failed');
      expect((error as HeicConverterError).message).toContain('HEAPU8');
      expect(brokenInstance.delete).toHaveBeenCalled();
    });

    it('retries initialization after a glue-API rejection', async () => {
      mockState.mockModuleFactory.mockResolvedValueOnce({
        HeicDecoder: class {
          constructor() {
            return { decode: vi.fn(), delete: vi.fn() };
          }
        },
      });
      const decoder = new LibheifDecoder();
      await expect(decoder.initialize()).rejects.toMatchObject({ code: 'decoder_init_failed' });

      // A failed load must not poison the instance: the next attempt sees the
      // healthy default module and succeeds.
      await decoder.initialize();
      expect(mockState.mockDecoderInstance.delete).not.toHaveBeenCalled();
    });

    it('copies input that is backed by the WASM heap before writing it back', async () => {
      // Overlap/detach guard: input already living on the module heap must be
      // copied out before `HEAPU8.set` writes it into the `_malloc` slot.
      // Asserting the bytes that arrive is vacuous (source and destination
      // don't overlap here, and `TypedArray#set` is memmove-safe anyway), so
      // inspect the VIEW handed to set: it must be a copy, not the heap.
      mockState.mockHeap.set([9, 8, 7, 6], 0);
      mockState.mockDecoderInstance.decode.mockReturnValue({
        width: 1,
        height: 1,
        data: new Uint8Array([1, 2, 3, 4]),
      });
      const heapBackedInput = new Uint8Array(mockState.mockHeap.buffer, 0, 4);
      const setSpy = vi.spyOn(mockState.mockHeap, 'set');

      const decoder = new LibheifDecoder();
      await decoder.initialize();
      await decoder.decode(heapBackedInput);

      expect(setSpy).toHaveBeenCalledTimes(1);
      const written = setSpy.mock.calls[0][0] as Uint8Array;
      expect(written.buffer, 'heap-backed input must be copied out, not written in place').not.toBe(
        mockState.mockHeap.buffer
      );
      expect(Array.from(written)).toEqual([9, 8, 7, 6]);
      setSpy.mockRestore();
    });

    it('clears the faulted flag on free() so a re-initialized decoder is leaseable', async () => {
      // A fresh module means a fresh heap: the poison must not survive free()
      // or a re-initialized instance would be discarded by the pool forever.
      mockState.mockDecoderInstance.decodeFromPointer.mockImplementationOnce(() => {
        throw new Error('wasm exploded');
      });
      const decoder = new LibheifDecoder();
      await decoder.initialize();
      await decoder.decode(new Uint8Array([1, 2, 3, 4])).catch(() => undefined);
      expect(isDecoderPoisoned(decoder)).toBe(true);

      decoder.free();
      expect(isDecoderPoisoned(decoder)).toBe(false);
    });
  });

  describe('Initialization races with free()', () => {
    it('should reject decode when freed while the module is loading', async () => {
      let resolveFactory: ((module: unknown) => void) | undefined;
      mockState.mockModuleFactory.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFactory = resolve;
          })
      );

      const decoder = new LibheifDecoder();
      const decoding = decoder.decode(new Uint8Array([1, 2, 3, 4]));
      const settled = decoding.catch((e) => e);
      await new Promise((r) => setTimeout(r, 0)); // let the glue import reach the factory

      decoder.free(); // abandons the in-flight load
      resolveFactory!(mockState.mockModule);

      const error = await settled;
      expect(error.code).toBe('decode_failed');
      expect(error.message).toContain('Decoder was freed before decoding completed');
      expect(mockState.mockDecoderInstance.delete).toHaveBeenCalled();
      expect(mockState.mockDecoderInstance.decode).not.toHaveBeenCalled();
    });

    it('should not clobber a newer initialization when a stale load rejects', async () => {
      let rejectFirst: ((error: unknown) => void) | undefined;
      mockState.mockModuleFactory
        .mockImplementationOnce(
          () =>
            new Promise((_resolve, reject) => {
              rejectFirst = reject;
            })
        )
        .mockImplementationOnce(() => Promise.resolve(mockState.mockModule));

      const decoder = new LibheifDecoder();
      const first = decoder.initialize();
      // Let the first glue import settle (factory invoked, load pending)
      // before starting the second one, mirroring real-world timing.
      await new Promise((r) => setTimeout(r, 0));
      decoder.free(); // abandons the first load
      await decoder.initialize(); // newer load succeeds

      rejectFirst!(new Error('stale load failed'));
      await expect(first).rejects.toThrow('stale load failed');

      mockState.mockDecoderInstance.decode.mockReturnValue({
        width: 1,
        height: 1,
        data: new Uint8Array([0, 0, 0, 255]),
      });
      const result = await decoder.decode(new Uint8Array([1]));
      expect(result.width).toBe(1);
    });

    it('should report a non-Error progress throw via its string form', async () => {
      mockState.mockDecoderInstance.decode.mockImplementation(
        (_data: Uint8Array, onProgress?: (percent: number) => void) => {
          onProgress?.(50);
          return { width: 1, height: 1, data: new Uint8Array([0, 0, 0, 255]) };
        }
      );

      const decoder = new LibheifDecoder();
      await decoder.initialize();

      const error = await decoder
        .decode(new Uint8Array([1]), () => {
          throw 'boom-string';
        })
        .catch((e) => e);
      expect(error.code).toBe('progress_callback_failed');
      expect(error.message).toContain('boom-string');
      expect(error.cause).toBe('boom-string');
    });
  });
});
describe('LibheifDecoder (mocked glue) - orientation reporting', () => {
  beforeEach(() => {
    mockState.mockModuleFactory.mockResolvedValue(mockState.mockModule);
    mockState.mockDecoderInstance.decode.mockReset();
  });

  const mockResultWithOrientation = (orientation?: unknown): void => {
    const result: Record<string, unknown> = {
      width: 4,
      height: 2,
      data: new Uint8Array(4 * 2 * 4),
    };
    if (orientation !== undefined) {
      result.orientation = orientation;
    }
    mockState.mockDecoderInstance.decode.mockReturnValue(result);
  };

  const decodeWith = async (orientation?: unknown): Promise<DecodedImageLike> => {
    mockResultWithOrientation(orientation);
    const decoder = new LibheifDecoder();
    await decoder.initialize();
    return decoder.decode(new Uint8Array([1, 2, 3, 4]));
  };

  type DecodedImageLike = { orientation?: number };

  it('passes through a valid EXIF orientation', async () => {
    const decoded = await decodeWith(6);
    expect(decoded.orientation).toBe(6);
  });

  it('omits the field for identity (1) or when an older glue reports nothing', async () => {
    expect((await decodeWith(1)).orientation).toBeUndefined();
    expect((await decodeWith(undefined)).orientation).toBeUndefined();
  });

  it('normalizes out-of-range, fractional, and non-numeric orientations to identity', async () => {
    for (const garbage of [0, 9, 1.5, '6', NaN, Infinity, null, true]) {
      const decoded = await decodeWith(garbage);
      expect(decoded.orientation).toBeUndefined();
    }
  });
});

describe('LibheifDecoder (mocked glue) - exif reporting', () => {
  beforeEach(() => {
    mockState.mockModuleFactory.mockResolvedValue(mockState.mockModule);
    mockState.mockDecoderInstance.decode.mockReset();
  });

  const decodeWithExif = async (exif?: unknown): Promise<{ exif?: Uint8Array }> => {
    const result: Record<string, unknown> = {
      width: 4,
      height: 2,
      data: new Uint8Array(4 * 2 * 4),
    };
    if (exif !== undefined) {
      result.exif = exif;
    }
    mockState.mockDecoderInstance.decode.mockReturnValue(result);
    const decoder = new LibheifDecoder();
    await decoder.initialize();
    return decoder.decode(new Uint8Array([1, 2, 3, 4]));
  };

  const validBlock = (): Uint8Array =>
    new Uint8Array([0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0x49, 0x49, 0x2a, 0x00, 8, 0, 0, 0]);

  it('passes through a valid EXIF block', async () => {
    const source = validBlock();
    const decoded = await decodeWithExif(source);

    expect(decoded.exif).toBeInstanceOf(Uint8Array);
    // JS-owned bytes (proven against the live HEAPU8): zero-copy wrap over
    // the same buffer, mirroring the pixel-data rule.
    expect((decoded.exif as Uint8Array).buffer).toBe(source.buffer);
    expect(Array.from(decoded.exif as Uint8Array)).toEqual(Array.from(source));
  });

  it('copies an EXIF block that is a heap view, keeping bytes independent', async () => {
    // Glue builds that hand back a heap view must not leak it to callers:
    // the block has to survive free() and later glue writes.
    const heapBlock = new Uint8Array(mockState.mockHeap.buffer, 48, 14);
    heapBlock.set(validBlock());
    const decoded = await decodeWithExif(heapBlock);

    expect(decoded.exif).toBeInstanceOf(Uint8Array);
    expect(decoded.exif).not.toBe(heapBlock);
    expect((decoded.exif as Uint8Array).buffer).not.toBe(mockState.mockHeap.buffer);
    // …so later glue-side mutation cannot corrupt the consumer's block.
    heapBlock.fill(0);
    expect(Array.from(decoded.exif as Uint8Array)).toEqual(Array.from(validBlock()));
  });

  it('omits the field when absent or not a byte array', async () => {
    expect((await decodeWithExif()).exif).toBeUndefined();
    expect((await decodeWithExif('Exif')).exif).toBeUndefined();
    expect((await decodeWithExif([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14])).exif).toBeUndefined();
    expect((await decodeWithExif(null)).exif).toBeUndefined();
  });

  it('omits blocks too short to carry a marker plus a minimal TIFF header', async () => {
    expect((await decodeWithExif(new Uint8Array(13))).exif).toBeUndefined();
    expect((await decodeWithExif(new Uint8Array(14))).exif).toBeInstanceOf(Uint8Array);
  });
});
