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

describe('LibheifDecoder Unit Tests', () => {
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

    it('should pass the progress callback when provided', async () => {
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

      expect(mockState.mockDecoderInstance.decode).toHaveBeenCalledWith(mockData, progressCallback);
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

    it('should handle undefined options', async () => {
      const decoder = new LibheifDecoder(undefined);
      await decoder.initialize();

      expect(mockState.mockModuleFactory).toHaveBeenCalledWith({});
    });
  });
});