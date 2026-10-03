import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LibheifDecoder } from '../../src/wasm/wrapper';

// Use vi.hoisted to properly hoist the mock factory
const mockState = vi.hoisted(() => ({
  mockModuleFactory: vi.fn(),
  mockDecoderInstance: {
    decode: vi.fn(),
    delete: vi.fn(),
  },
  mockModule: {
    HeicDecoder: class MockHeicDecoder {
      constructor() {
        return mockState.mockDecoderInstance;
      }
    },
  },
}));

vi.mock('../../src/wasm/wrapper/heic-decoder.js', () => ({
  default: mockState.mockModuleFactory,
}));

describe('LibheifDecoder (mocked glue)', () => {
  beforeEach(() => {
    mockState.mockModuleFactory.mockResolvedValue(mockState.mockModule);
    mockState.mockDecoderInstance.decode.mockClear();
    mockState.mockDecoderInstance.delete.mockClear();
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
      const rawData = new Uint8Array([9, 8, 7, 6]);
      mockState.mockDecoderInstance.decode.mockReturnValue({
        width: 1,
        height: 1,
        data: rawData,
      });

      const decoder = new LibheifDecoder();
      await decoder.initialize();
      const result = await decoder.decode(mockData);

      expect(result.data).not.toBe(rawData);
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
      expect(passedData).toBe(mockData);
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

      await expect(decoder.decode(new Uint8Array([1]))).rejects.toThrow('wasm exploded');
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
        delete: vi.fn(),
      };
      (heapModule as { HeicDecoder: unknown }).HeicDecoder = class {
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

    it('should share (not copy) JS-owned pixel buffers when heap is inspectable', async () => {
      // The C++ wrapper builds pixels with a JS Uint8Array; when the glue
      // exposes HEAPU8 we can prove the buffer is not a heap view and skip
      // the defensive second copy.
      const jsOwned = new Uint8Array([5, 6, 7, 8]);
      const jsOwnedInstance = {
        decode: vi.fn(() => ({ width: 1, height: 1, data: jsOwned })),
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

  it('passes through a valid EXIF block as an owned copy', async () => {
    const source = validBlock();
    const decoded = await decodeWithExif(source);

    expect(decoded.exif).toBeInstanceOf(Uint8Array);
    // Defensive copy: distinct buffer, identical bytes…
    expect(decoded.exif).not.toBe(source);
    expect(Array.from(decoded.exif as Uint8Array)).toEqual(Array.from(source));
    // …so later glue-side mutation cannot corrupt the consumer's block.
    source.fill(0);
    expect(Array.from(decoded.exif as Uint8Array)).not.toEqual(Array.from(source));
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
