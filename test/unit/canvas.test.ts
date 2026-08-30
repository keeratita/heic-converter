import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderAndEncode } from '../../src/render/canvas';
import { DecodedImage } from '../../src/types';

// Mock test image data
const createMockDecodedImage = (width: number, height: number): DecodedImage => ({
  width,
  height,
  data: new Uint8ClampedArray(width * height * 4).fill(255),
});

describe('renderAndEncode Unit Tests', () => {
  let mockCanvas: HTMLCanvasElement;
  let mockCtx: CanvasRenderingContext2D;
  let originalDocument: typeof document;
  let originalOffscreenCanvas: typeof OffscreenCanvas;
  let originalImageData: typeof ImageData;

  beforeEach(() => {
    // Save originals
    originalDocument = global.document;
    originalOffscreenCanvas = global.OffscreenCanvas;
    originalImageData = global.ImageData;

    // Mock canvas
    mockCtx = {
      putImageData: vi.fn(),
      createImageData: vi.fn(),
      getContext: vi.fn(),
    } as unknown as CanvasRenderingContext2D;

    mockCanvas = {
      width: 0,
      height: 0,
      getContext: vi.fn().mockReturnValue(mockCtx),
      toBlob: vi.fn(),
    } as unknown as HTMLCanvasElement;

    // Mock document.createElement
    global.document = {
      createElement: vi.fn().mockReturnValue(mockCanvas),
    } as unknown as typeof document;

    // Mock OffscreenCanvas as undefined to test fallback
    global.OffscreenCanvas = undefined as unknown as typeof OffscreenCanvas;
    global.ImageData = class MockImageData {
      data: Uint8ClampedArray;
      width: number;
      height: number;
      constructor(data: Uint8ClampedArray, width: number, height: number) {
        this.data = data;
        this.width = width;
        this.height = height;
      }
    } as unknown as typeof ImageData;
  });

  afterEach(() => {
    // Restore originals
    global.document = originalDocument;
    global.OffscreenCanvas = originalOffscreenCanvas;
    global.ImageData = originalImageData;
  });

  describe('JPEG/JPG format', () => {
    it('should encode to JPEG with default quality (0.92)', async () => {
      const decoded = createMockDecodedImage(100, 100);
      const mockBlob = new Blob(['jpeg-data'], { type: 'image/jpeg' });

      mockCanvas.toBlob = vi.fn((callback: (blob: Blob | null) => void) => {
        callback(mockBlob);
      });

      const result = await renderAndEncode(decoded, 'jpeg', 0.92);

      expect(result).toBeInstanceOf(Blob);
      expect(result.type).toBe('image/jpeg');
      expect(mockCanvas.toBlob).toHaveBeenCalledWith(expect.any(Function), 'image/jpeg', 0.92);
    });

    it('should encode to JPEG with custom quality', async () => {
      const decoded = createMockDecodedImage(100, 100);
      const mockBlob = new Blob(['jpeg-data'], { type: 'image/jpeg' });

      mockCanvas.toBlob = vi.fn((callback: (blob: Blob | null) => void) => {
        callback(mockBlob);
      });

      const result = await renderAndEncode(decoded, 'jpeg', 0.5);

      expect(result.type).toBe('image/jpeg');
      expect(mockCanvas.toBlob).toHaveBeenCalledWith(expect.any(Function), 'image/jpeg', 0.5);
    });

    it('should normalize "jpg" format to "image/jpeg"', async () => {
      const decoded = createMockDecodedImage(100, 100);
      const mockBlob = new Blob(['jpeg-data'], { type: 'image/jpeg' });

      mockCanvas.toBlob = vi.fn((callback: (blob: Blob | null) => void) => {
        callback(mockBlob);
      });

      const result = await renderAndEncode(decoded, 'jpg', 0.92);

      expect(result.type).toBe('image/jpeg');
      expect(mockCanvas.toBlob).toHaveBeenCalledWith(expect.any(Function), 'image/jpeg', 0.92);
    });
  });

  describe('PNG format', () => {
    it('should encode to PNG', async () => {
      const decoded = createMockDecodedImage(100, 100);
      const mockBlob = new Blob(['png-data'], { type: 'image/png' });

      mockCanvas.toBlob = vi.fn((callback: (blob: Blob | null) => void) => {
        callback(mockBlob);
      });

      const result = await renderAndEncode(decoded, 'png', 1);

      expect(result).toBeInstanceOf(Blob);
      expect(result.type).toBe('image/png');
      expect(mockCanvas.toBlob).toHaveBeenCalledWith(expect.any(Function), 'image/png', undefined);
    });

    it('should ignore quality parameter for PNG format', async () => {
      const decoded = createMockDecodedImage(100, 100);
      const mockBlob = new Blob(['png-data'], { type: 'image/png' });

      mockCanvas.toBlob = vi.fn((callback: (blob: Blob | null) => void) => {
        callback(mockBlob);
      });

      const result = await renderAndEncode(decoded, 'png', 0.5);

      expect(result.type).toBe('image/png');
    });
  });

  describe('SVG format', () => {
    it('should encode to SVG with embedded PNG', async () => {
      const decoded = createMockDecodedImage(100, 100);
      const mockPngBlob = new Blob(['png-data'], { type: 'image/png' });

      mockCanvas.toBlob = vi.fn((callback: (blob: Blob | null) => void) => {
        callback(mockPngBlob);
      });

      // Mock FileReader class properly
      class MockFileReader1 {
        result: string | null = 'data:image/png;base64,cG5nLWRhdGE=';
        onloadend: (() => void) | null = null;
        onerror: (() => void) | null = null;
        
        readAsDataURL(): void {
          // Simulate async completion
          setTimeout(() => {
            if (this.onloadend) {
              this.onloadend();
            }
          }, 0);
        }
      }

      global.FileReader = MockFileReader1 as unknown as typeof FileReader;

      const result = await renderAndEncode(decoded, 'svg', 1);

      expect(result).toBeInstanceOf(Blob);
      expect(result.type).toBe('image/svg+xml');
      
      const svgContent = await result.text();
      expect(svgContent).toContain('<svg');
      expect(svgContent).toContain('xmlns="http://www.w3.org/2000/svg"');
      expect(svgContent).toContain('viewBox="0 0 100 100"');
      expect(svgContent).toContain('data:image/png;base64');
    });

    it('should handle SVG encoding with different dimensions', async () => {
      const decoded = createMockDecodedImage(200, 150);
      const mockPngBlob = new Blob(['png-data'], { type: 'image/png' });

      mockCanvas.toBlob = vi.fn((callback: (blob: Blob | null) => void) => {
        callback(mockPngBlob);
      });

      class MockFileReader2 {
        result: string | null = 'data:image/png;base64,test';
        onloadend: (() => void) | null = null;
        onerror: (() => void) | null = null;
        
        readAsDataURL(): void {
          setTimeout(() => {
            if (this.onloadend) {
              this.onloadend();
            }
          }, 0);
        }
      }

      global.FileReader = MockFileReader2 as unknown as typeof FileReader;

      const result = await renderAndEncode(decoded, 'svg', 1);

      const svgContent = await result.text();
      expect(svgContent).toContain('viewBox="0 0 200 150"');
      expect(svgContent).toContain('width="200" height="150"');
    });
  });

  describe('WebP format', () => {
    it('should encode to WebP with default quality', async () => {
      const decoded = createMockDecodedImage(100, 100);
      const mockBlob = new Blob(['webp-data'], { type: 'image/webp' });

      mockCanvas.toBlob = vi.fn((callback: (blob: Blob | null) => void) => {
        callback(mockBlob);
      });

      const result = await renderAndEncode(decoded, 'webp', 0.92);

      expect(result).toBeInstanceOf(Blob);
      expect(result.type).toBe('image/webp');
      expect(mockCanvas.toBlob).toHaveBeenCalledWith(expect.any(Function), 'image/webp', 0.92);
    });

    it('should encode to WebP with custom quality', async () => {
      const decoded = createMockDecodedImage(100, 100);
      const mockBlob = new Blob(['webp-data'], { type: 'image/webp' });

      mockCanvas.toBlob = vi.fn((callback: (blob: Blob | null) => void) => {
        callback(mockBlob);
      });

      const result = await renderAndEncode(decoded, 'webp', 0.5);

      expect(result.type).toBe('image/webp');
      expect(mockCanvas.toBlob).toHaveBeenCalledWith(expect.any(Function), 'image/webp', 0.5);
    });
  });

  describe('Error handling', () => {
    it('should throw error for unsupported format', async () => {
      const decoded = createMockDecodedImage(100, 100);

      await expect(renderAndEncode(decoded, 'gif' as any, 0.92)).rejects.toThrow(
        'Unsupported output format: gif'
      );
    });

    it('should throw error when canvas context is not available', async () => {
      const decoded = createMockDecodedImage(100, 100);
      
      mockCanvas.getContext = vi.fn().mockReturnValue(null);
      global.document = {
        createElement: vi.fn().mockReturnValue(mockCanvas),
      } as unknown as typeof document;

      await expect(renderAndEncode(decoded, 'jpeg', 0.92)).rejects.toThrow(
        'Failed to acquire 2D rendering context from canvas'
      );
    });

    it('should throw error when canvas is not supported', async () => {
      const decoded = createMockDecodedImage(100, 100);

      global.document = undefined as any;
      global.OffscreenCanvas = undefined as any;

      await expect(renderAndEncode(decoded, 'jpeg', 0.92)).rejects.toThrow(
        'Canvas is not supported in the current environment'
      );
    });
  });

  describe('ImageData handling', () => {
    it('should use ImageData constructor when available', async () => {
      const decoded = createMockDecodedImage(100, 100);
      const mockBlob = new Blob(['jpeg-data'], { type: 'image/jpeg' });

      mockCanvas.toBlob = vi.fn((callback: (blob: Blob | null) => void) => {
        callback(mockBlob);
      });

      const result = await renderAndEncode(decoded, 'jpeg', 0.92);

      expect(result).toBeInstanceOf(Blob);
      expect(mockCtx.putImageData).toHaveBeenCalled();
    });

    it('should handle case where ImageData is not defined but createImageData is', async () => {
      const decoded = createMockDecodedImage(100, 100);
      const mockBlob = new Blob(['jpeg-data'], { type: 'image/jpeg' });

      mockCanvas.toBlob = vi.fn((callback: (blob: Blob | null) => void) => {
        callback(mockBlob);
      });

      const createdImageData = new Uint8ClampedArray(100 * 100 * 4);
      mockCtx.createImageData = vi.fn().mockReturnValue({
        data: createdImageData,
      });

      global.ImageData = undefined as unknown as typeof ImageData;

      const result = await renderAndEncode(decoded, 'jpeg', 0.92);

      expect(result).toBeInstanceOf(Blob);
    });
  });

  describe('OffscreenCanvas support', () => {
    it('should use OffscreenCanvas when available', async () => {
      const decoded = createMockDecodedImage(100, 100);
      const mockBlob = new Blob(['jpeg-data'], { type: 'image/jpeg' });

      const mockOffscreenCtx = {
        putImageData: vi.fn(),
      };

      const convertToBlobMock = vi.fn().mockResolvedValue(mockBlob);
      const MockOffscreenCanvasClass = class MockOffscreenCanvas {
        width: number;
        height: number;
        constructor(width: number, height: number) {
          this.width = width;
          this.height = height;
        }
        getContext = vi.fn().mockReturnValue(mockOffscreenCtx);
        convertToBlob = convertToBlobMock;
      };

      global.OffscreenCanvas = MockOffscreenCanvasClass as unknown as typeof OffscreenCanvas;

      const result = await renderAndEncode(decoded, 'jpeg', 0.92);

      expect(result).toBeInstanceOf(Blob);
      expect(convertToBlobMock).toHaveBeenCalledWith({ type: 'image/jpeg', quality: 0.92 });
    });
  });

  describe('blobToBase64 Node.js fallback', () => {
    it('should use Buffer when FileReader is not available', async () => {
      const decoded = createMockDecodedImage(100, 100);
      const mockArrayBuffer = new ArrayBuffer(100);
      const mockBlob = new Blob(['test-data'], { type: 'image/png' });

      mockCanvas.toBlob = vi.fn((callback: (blob: Blob | null) => void) => {
        callback(mockBlob);
      });

      // Mock blob.arrayBuffer()
      mockBlob.arrayBuffer = vi.fn().mockResolvedValue(mockArrayBuffer);

      // Remove FileReader to trigger Node.js fallback
      const originalFileReader = global.FileReader;
      global.FileReader = undefined as any;

      class MockFileReader3 {
        result: string | null = 'data:image/png;base64,dGVzdC1kYXRh';
        onloadend: (() => void) | null = null;
        onerror: (() => void) | null = null;
        readAsDataURL(): void {
          setTimeout(() => {
            if (this.onloadend) {
              this.onloadend();
            }
          }, 0);
        }
      }

      global.FileReader = MockFileReader3 as unknown as typeof FileReader;

      const result = await renderAndEncode(decoded, 'svg', 1);

      const svgContent = await result.text();
      expect(svgContent).toContain('data:image/png;base64');

      // Restore FileReader
      global.FileReader = originalFileReader;
    });
  });

  describe('blobToBase64 error handling', () => {
    it('should reject when FileReader result is not a string', async () => {
      const decoded = createMockDecodedImage(100, 100);
      const mockBlob = new Blob(['test-data'], { type: 'image/png' });

      mockCanvas.toBlob = vi.fn((callback: (blob: Blob | null) => void) => {
        callback(mockBlob);
      });

      class MockFileReader4 {
        result: any = null; // Not a string
        onloadend: (() => void) | null = null;
        onerror: (() => void) | null = null;
        readAsDataURL(): void {
          setTimeout(() => {
            if (this.onloadend) {
              this.onloadend();
            }
          }, 0);
        }
      }

      global.FileReader = MockFileReader4 as unknown as typeof FileReader;

      await expect(renderAndEncode(decoded, 'svg', 1)).rejects.toThrow(
        'Failed to convert Blob to base64 string'
      );
    });

    it('should reject when FileReader encounters an error', async () => {
      const decoded = createMockDecodedImage(100, 100);
      const mockBlob = new Blob(['test-data'], { type: 'image/png' });

      mockCanvas.toBlob = vi.fn((callback: (blob: Blob | null) => void) => {
        callback(mockBlob);
      });

      const mockError = new Error('FileReader error');
      class MockFileReader5 {
        result: string | null = 'data:image/png;base64,test';
        onloadend: (() => void) | null = null;
        onerror: (() => void) | null = null;
        readAsDataURL(): void {
          setTimeout(() => {
            if (this.onerror) {
              // Simulate error
              (this as any).error = mockError;
              this.onerror();
            }
          }, 0);
        }
      }

      global.FileReader = MockFileReader5 as unknown as typeof FileReader;

      await expect(renderAndEncode(decoded, 'svg', 1)).rejects.toThrow('FileReader error');
    });

    it('should wrap a non-Error value thrown by the Node fallback', async () => {
      const decoded = createMockDecodedImage(100, 100);
      const mockBlob = new Blob(['test-data'], { type: 'image/png' });

      mockCanvas.toBlob = vi.fn((callback: (blob: Blob | null) => void) => {
        callback(mockBlob);
      });

      // Remove FileReader to trigger the Node.js fallback path.
      global.FileReader = undefined as unknown as typeof FileReader;
      mockBlob.arrayBuffer = vi.fn().mockRejectedValue('boom');

      await expect(renderAndEncode(decoded, 'svg', 1)).rejects.toThrow(
        'Failed to convert Blob to base64 string: boom'
      );
    });
  });

  describe('canvasToBlob error handling', () => {
    it('should reject when canvas.toBlob returns null', async () => {
      const decoded = createMockDecodedImage(100, 100);

      mockCanvas.toBlob = vi.fn((callback: (blob: Blob | null) => void) => {
        callback(null); // Simulate failure
      });

      await expect(renderAndEncode(decoded, 'jpeg', 0.92)).rejects.toThrow(
        'Failed to convert canvas to blob'
      );
    });
  });

  describe('Case insensitivity', () => {
    it('should handle uppercase format names', async () => {
      const decoded = createMockDecodedImage(100, 100);
      const mockBlob = new Blob(['jpeg-data'], { type: 'image/jpeg' });

      mockCanvas.toBlob = vi.fn((callback: (blob: Blob | null) => void) => {
        callback(mockBlob);
      });

      const result = await renderAndEncode(decoded, 'JPEG' as any, 0.92);

      expect(result.type).toBe('image/jpeg');
    });

    it('should handle mixed case format names', async () => {
      const decoded = createMockDecodedImage(100, 100);
      const mockBlob = new Blob(['png-data'], { type: 'image/png' });

      mockCanvas.toBlob = vi.fn((callback: (blob: Blob | null) => void) => {
        callback(mockBlob);
      });

      const result = await renderAndEncode(decoded, 'PnG' as any, 0.92);

      expect(result.type).toBe('image/png');
    });
  });

  describe('Data validation', () => {
    it('should throw error when data length does not match dimensions', async () => {
      // Create decoded image with mismatched data length
      const decoded: DecodedImage = {
        width: 100,
        height: 100,
        data: new Uint8ClampedArray(100), // Wrong size: should be 40000
      };

      await expect(renderAndEncode(decoded, 'jpeg', 0.92)).rejects.toThrow(
        'Image data length mismatch'
      );
    });

    it('should accept correct data length', async () => {
      const decoded = createMockDecodedImage(100, 100);
      const mockBlob = new Blob(['jpeg-data'], { type: 'image/jpeg' });

      mockCanvas.toBlob = vi.fn((callback: (blob: Blob | null) => void) => {
        callback(mockBlob);
      });

      const result = await renderAndEncode(decoded, 'jpeg', 0.92);

      expect(result).toBeInstanceOf(Blob);
    });
  });

  describe('Image dimension edge cases', () => {
    it('should reject zero width image', async () => {
      const decoded: DecodedImage = {
        width: 0,
        height: 100,
        data: new Uint8ClampedArray(0),
      };

      await expect(renderAndEncode(decoded, 'jpeg', 0.92)).rejects.toThrow(
        'Invalid image dimensions'
      );
    });

    it('should reject zero height image', async () => {
      const decoded: DecodedImage = {
        width: 100,
        height: 0,
        data: new Uint8ClampedArray(0),
      };

      await expect(renderAndEncode(decoded, 'jpeg', 0.92)).rejects.toThrow(
        'Invalid image dimensions'
      );
    });

    it('should reject negative dimensions', async () => {
      const decoded: DecodedImage = {
        width: -1,
        height: 100,
        data: new Uint8ClampedArray(0),
      };

      await expect(renderAndEncode(decoded, 'jpeg', 0.92)).rejects.toThrow(
        'Invalid image dimensions'
      );
    });

    it('should reject non-integer dimensions', async () => {
      const decoded: DecodedImage = {
        width: 100.5,
        height: 100,
        data: new Uint8ClampedArray(0),
      };

      await expect(renderAndEncode(decoded, 'jpeg', 0.92)).rejects.toThrow(
        'Invalid image dimensions'
      );
    });

    it('should handle 1x1 pixel image', async () => {
      const decoded: DecodedImage = {
        width: 1,
        height: 1,
        data: new Uint8ClampedArray([255, 0, 0, 255]), // Red pixel
      };
      const mockBlob = new Blob(['jpeg-data'], { type: 'image/jpeg' });

      mockCanvas.toBlob = vi.fn((callback: (blob: Blob | null) => void) => {
        callback(mockBlob);
      });

      const result = await renderAndEncode(decoded, 'jpeg', 0.92);

      expect(result).toBeInstanceOf(Blob);
      expect(mockCanvas.width).toBe(1);
      expect(mockCanvas.height).toBe(1);
    });

    it('should handle extreme aspect ratio (wide)', async () => {
      const width = 1000;
      const height = 1;
      const decoded: DecodedImage = {
        width,
        height,
        data: new Uint8ClampedArray(width * height * 4),
      };
      const mockBlob = new Blob(['jpeg-data'], { type: 'image/jpeg' });

      mockCanvas.toBlob = vi.fn((callback: (blob: Blob | null) => void) => {
        callback(mockBlob);
      });

      const result = await renderAndEncode(decoded, 'jpeg', 0.92);

      expect(result).toBeInstanceOf(Blob);
      expect(mockCanvas.width).toBe(width);
      expect(mockCanvas.height).toBe(height);
    });

    it('should handle extreme aspect ratio (tall)', async () => {
      const width = 1;
      const height = 1000;
      const decoded: DecodedImage = {
        width,
        height,
        data: new Uint8ClampedArray(width * height * 4),
      };
      const mockBlob = new Blob(['jpeg-data'], { type: 'image/jpeg' });

      mockCanvas.toBlob = vi.fn((callback: (blob: Blob | null) => void) => {
        callback(mockBlob);
      });

      const result = await renderAndEncode(decoded, 'jpeg', 0.92);

      expect(result).toBeInstanceOf(Blob);
      expect(mockCanvas.width).toBe(width);
      expect(mockCanvas.height).toBe(height);
    });

    it('should handle very large image dimensions', async () => {
      const width = 5000;
      const height = 5000;
      const decoded: DecodedImage = {
        width,
        height,
        data: new Uint8ClampedArray(width * height * 4),
      };
      const mockBlob = new Blob(['jpeg-data'], { type: 'image/jpeg' });

      mockCanvas.toBlob = vi.fn((callback: (blob: Blob | null) => void) => {
        callback(mockBlob);
      });

      const result = await renderAndEncode(decoded, 'jpeg', 0.92);

      expect(result).toBeInstanceOf(Blob);
      expect(mockCanvas.width).toBe(width);
      expect(mockCanvas.height).toBe(height);
    });
  });

  describe('Empty and partial data edge cases', () => {
    it('should throw error for empty data array with non-zero dimensions', async () => {
      const decoded: DecodedImage = {
        width: 100,
        height: 100,
        data: new Uint8ClampedArray(0),
      };

      await expect(renderAndEncode(decoded, 'jpeg', 0.92)).rejects.toThrow(
        'Image data length mismatch'
      );
    });

    it('should throw error for partial data (less than expected)', async () => {
      const decoded: DecodedImage = {
        width: 100,
        height: 100,
        data: new Uint8ClampedArray(1000), // Should be 40000
      };

      await expect(renderAndEncode(decoded, 'jpeg', 0.92)).rejects.toThrow(
        'Image data length mismatch'
      );
    });

    it('should throw error for excess data (more than expected)', async () => {
      const decoded: DecodedImage = {
        width: 100,
        height: 100,
        data: new Uint8ClampedArray(50000), // Should be 40000
      };

      await expect(renderAndEncode(decoded, 'jpeg', 0.92)).rejects.toThrow(
        'Image data length mismatch'
      );
    });

    it('should handle data with all zeros (black image)', async () => {
      const decoded: DecodedImage = {
        width: 10,
        height: 10,
        data: new Uint8ClampedArray(10 * 10 * 4).fill(0),
      };
      const mockBlob = new Blob(['jpeg-data'], { type: 'image/jpeg' });

      mockCanvas.toBlob = vi.fn((callback: (blob: Blob | null) => void) => {
        callback(mockBlob);
      });

      const result = await renderAndEncode(decoded, 'jpeg', 0.92);

      expect(result).toBeInstanceOf(Blob);
    });

    it('should handle data with all 255s (white image)', async () => {
      const decoded: DecodedImage = {
        width: 10,
        height: 10,
        data: new Uint8ClampedArray(10 * 10 * 4).fill(255),
      };
      const mockBlob = new Blob(['jpeg-data'], { type: 'image/jpeg' });

      mockCanvas.toBlob = vi.fn((callback: (blob: Blob | null) => void) => {
        callback(mockBlob);
      });

      const result = await renderAndEncode(decoded, 'jpeg', 0.92);

      expect(result).toBeInstanceOf(Blob);
    });
  });

  describe('Environment fallback edge cases', () => {
    it('should handle OffscreenCanvas without convertToBlob', async () => {
      const decoded = createMockDecodedImage(100, 100);
      const mockBlob = new Blob(['jpeg-data'], { type: 'image/jpeg' });

      // Set OffscreenCanvas to undefined to force HTMLCanvasElement fallback
      const originalOffscreenCanvas = global.OffscreenCanvas;
      global.OffscreenCanvas = undefined as unknown as typeof OffscreenCanvas;

      // Mock document.createElement to provide fallback
      const fallbackCanvas = {
        width: 100,
        height: 100,
        getContext: vi.fn().mockReturnValue({
          putImageData: vi.fn(),
        }),
        toBlob: vi.fn((callback: (blob: Blob | null) => void) => {
          callback(mockBlob);
        }),
      } as unknown as HTMLCanvasElement;

      global.document = {
        createElement: vi.fn().mockReturnValue(fallbackCanvas),
      } as unknown as typeof document;

      // The code should use HTMLCanvasElement when OffscreenCanvas is not available
      const result = await renderAndEncode(decoded, 'jpeg', 0.92);
      expect(result).toBeInstanceOf(Blob);

      // Restore original OffscreenCanvas
      global.OffscreenCanvas = originalOffscreenCanvas;
    });

    it('should handle getContext returning undefined instead of null', async () => {
      const decoded = createMockDecodedImage(100, 100);

      mockCanvas.getContext = vi.fn().mockReturnValue(undefined);

      await expect(renderAndEncode(decoded, 'jpeg', 0.92)).rejects.toThrow(
        'Failed to acquire 2D rendering context from canvas'
      );
    });

    it('should handle ImageData constructor throwing an error', async () => {
      const decoded = createMockDecodedImage(100, 100);
      const mockBlob = new Blob(['jpeg-data'], { type: 'image/jpeg' });

      mockCanvas.toBlob = vi.fn((callback: (blob: Blob | null) => void) => {
        callback(mockBlob);
      });

      const originalImageData = global.ImageData;
      global.ImageData = class MockImageData {
        constructor() {
          throw new Error('ImageData constructor failed');
        }
        width = 0;
        height = 0;
        data = new Uint8ClampedArray(0);
      } as unknown as typeof ImageData;

      await expect(renderAndEncode(decoded, 'jpeg', 0.92)).rejects.toThrow(
        'ImageData constructor failed'
      );

      global.ImageData = originalImageData;
    });

    it('should use createImageData fallback when ImageData is undefined', async () => {
      const decoded = createMockDecodedImage(100, 100);
      const mockBlob = new Blob(['jpeg-data'], { type: 'image/jpeg' });

      const createdData = {
        data: new Uint8ClampedArray(100 * 100 * 4),
      };

      mockCanvas.toBlob = vi.fn((callback: (blob: Blob | null) => void) => {
        callback(mockBlob);
      });
      mockCtx.createImageData = vi.fn().mockReturnValue(createdData);
      mockCtx.putImageData = vi.fn();

      global.ImageData = undefined as unknown as typeof ImageData;

      const result = await renderAndEncode(decoded, 'jpeg', 0.92);

      expect(result).toBeInstanceOf(Blob);
      expect(mockCtx.createImageData).toHaveBeenCalledWith(100, 100);
      expect(mockCtx.putImageData).toHaveBeenCalled();

      global.ImageData = originalImageData;
    });
  });

  describe('blobToBase64 error handling', () => {
    it('should throw error with message when arrayBuffer fails', async () => {
      const decoded = createMockDecodedImage(100, 100);
      const mockBlob = new Blob(['test-data'], { type: 'image/png' });

      mockCanvas.toBlob = vi.fn((callback: (blob: Blob | null) => void) => {
        callback(mockBlob);
      });

      // Mock arrayBuffer to throw
      mockBlob.arrayBuffer = vi.fn().mockRejectedValue(new Error('arrayBuffer failed'));

      // Remove FileReader to trigger Node.js fallback
      const originalFileReader = global.FileReader;
      global.FileReader = undefined as any;

      await expect(renderAndEncode(decoded, 'svg', 1)).rejects.toThrow(
        'Failed to convert Blob to base64 string: arrayBuffer failed'
      );

      // Restore FileReader
      global.FileReader = originalFileReader;
    });
  });
});
