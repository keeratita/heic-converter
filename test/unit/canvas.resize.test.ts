import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderAndEncode } from '../../src/render/canvas';
import { DecodedImage } from '../../src/types';

const createMockDecodedImage = (width: number, height: number): DecodedImage => ({
  width,
  height,
  data: new Uint8ClampedArray(width * height * 4).fill(255),
});

describe('renderAndEncode - Resize', () => {
  let mockCanvas: HTMLCanvasElement;
  let mockCtx: CanvasRenderingContext2D;
  let originalDocument: typeof document;
  let originalOffscreenCanvas: typeof OffscreenCanvas;
  let originalImageData: typeof ImageData;
  let originalFileReader: typeof FileReader;

  beforeEach(() => {
    originalDocument = global.document;
    originalOffscreenCanvas = global.OffscreenCanvas;
    originalImageData = global.ImageData;
    originalFileReader = global.FileReader;

    mockCtx = {
      putImageData: vi.fn(),
      createImageData: vi.fn(),
      drawImage: vi.fn(),
      getContext: vi.fn(),
    } as unknown as CanvasRenderingContext2D;

    mockCanvas = {
      width: 0,
      height: 0,
      getContext: vi.fn().mockReturnValue(mockCtx),
      toBlob: vi.fn(),
    } as unknown as HTMLCanvasElement;

    global.document = {
      createElement: vi.fn().mockReturnValue(mockCanvas),
    } as unknown as typeof document;

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
    global.document = originalDocument;
    global.OffscreenCanvas = originalOffscreenCanvas;
    global.ImageData = originalImageData;
    global.FileReader = originalFileReader;
  });

  it('should downscale with scale factor and draw the source canvas scaled', async () => {
    const decoded = createMockDecodedImage(100, 100);
    const mockBlob = new Blob(['jpeg-data'], { type: 'image/jpeg' });
    mockCanvas.toBlob = vi.fn((callback: (blob: Blob | null) => void) => {
      callback(mockBlob);
    });

    const result = await renderAndEncode(decoded, 'jpeg', 0.92, { scale: 0.5 });

    expect(result.type).toBe('image/jpeg');
    expect(mockCtx.drawImage).toHaveBeenCalledWith(expect.any(Object), 0, 0, 50, 50);
    expect(mockCanvas.toBlob).toHaveBeenCalledWith(expect.any(Function), 'image/jpeg', 0.92);
  });

  it('should upscale with a scale factor greater than 1', async () => {
    const decoded = createMockDecodedImage(10, 10);
    const mockBlob = new Blob(['png-data'], { type: 'image/png' });
    mockCanvas.toBlob = vi.fn((callback: (blob: Blob | null) => void) => {
      callback(mockBlob);
    });

    await renderAndEncode(decoded, 'png', 1, { scale: 2 });

    expect(mockCtx.drawImage).toHaveBeenCalledWith(expect.any(Object), 0, 0, 20, 20);
  });

  it('should downscale to fit within maxWidth while preserving aspect ratio', async () => {
    const decoded = createMockDecodedImage(200, 100);
    const mockBlob = new Blob(['jpeg-data'], { type: 'image/jpeg' });
    mockCanvas.toBlob = vi.fn((callback: (blob: Blob | null) => void) => {
      callback(mockBlob);
    });

    await renderAndEncode(decoded, 'jpeg', 0.92, { maxWidth: 100 });

    expect(mockCtx.drawImage).toHaveBeenCalledWith(expect.any(Object), 0, 0, 100, 50);
  });

  it('should downscale to fit within maxHeight while preserving aspect ratio', async () => {
    const decoded = createMockDecodedImage(200, 100);
    const mockBlob = new Blob(['jpeg-data'], { type: 'image/jpeg' });
    mockCanvas.toBlob = vi.fn((callback: (blob: Blob | null) => void) => {
      callback(mockBlob);
    });

    await renderAndEncode(decoded, 'jpeg', 0.92, { maxHeight: 50 });

    expect(mockCtx.drawImage).toHaveBeenCalledWith(expect.any(Object), 0, 0, 100, 50);
  });

  it('should not upscale when maxWidth is larger than the image', async () => {
    const decoded = createMockDecodedImage(100, 100);
    const mockBlob = new Blob(['jpeg-data'], { type: 'image/jpeg' });
    mockCanvas.toBlob = vi.fn((callback: (blob: Blob | null) => void) => {
      callback(mockBlob);
    });

    await renderAndEncode(decoded, 'jpeg', 0.92, { maxWidth: 1000 });

    expect(mockCtx.drawImage).not.toHaveBeenCalled();
    expect(mockCanvas.toBlob).toHaveBeenCalledWith(expect.any(Function), 'image/jpeg', 0.92);
  });

  it('should not resize when no resize options are provided', async () => {
    const decoded = createMockDecodedImage(100, 100);
    const mockBlob = new Blob(['jpeg-data'], { type: 'image/jpeg' });
    mockCanvas.toBlob = vi.fn((callback: (blob: Blob | null) => void) => {
      callback(mockBlob);
    });

    await renderAndEncode(decoded, 'jpeg', 0.92);

    expect(mockCtx.drawImage).not.toHaveBeenCalled();
    expect(mockCtx.putImageData).toHaveBeenCalledTimes(1);
  });

  it('should throw when scale is invalid', async () => {
    const decoded = createMockDecodedImage(100, 100);

    await expect(renderAndEncode(decoded, 'jpeg', 0.92, { scale: 0 })).rejects.toThrow(
      'Scale must be a positive finite number'
    );
  });

  it('should throw when maxWidth is invalid', async () => {
    const decoded = createMockDecodedImage(100, 100);

    await expect(renderAndEncode(decoded, 'jpeg', 0.92, { maxWidth: -5 })).rejects.toThrow(
      'maxWidth must be a positive finite number'
    );
  });

  it('should throw when maxHeight is invalid', async () => {
    const decoded = createMockDecodedImage(100, 100);

    await expect(renderAndEncode(decoded, 'jpeg', 0.92, { maxHeight: NaN })).rejects.toThrow(
      'maxHeight must be a positive finite number'
    );
  });

  it('should use the resized dimensions in the SVG output', async () => {
    const decoded = createMockDecodedImage(200, 100);
    const mockPngBlob = new Blob(['png-data'], { type: 'image/png' });
    mockCanvas.toBlob = vi.fn((callback: (blob: Blob | null) => void) => {
      callback(mockPngBlob);
    });

    class MockFileReader {
      result: string | null = 'data:image/png;base64,cG5nLWRhdGE=';
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

    global.FileReader = MockFileReader as unknown as typeof FileReader;

    const result = await renderAndEncode(decoded, 'svg', 1, { scale: 0.5 });

    const svgContent = await result.text();
    expect(svgContent).toContain('viewBox="0 0 100 50"');
    expect(svgContent).toContain('width="100" height="50"');
  });

  it('should pass quality to the encoder when resizing', async () => {
    const decoded = createMockDecodedImage(100, 100);
    const mockBlob = new Blob(['webp-data'], { type: 'image/webp' });
    mockCanvas.toBlob = vi.fn((callback: (blob: Blob | null) => void) => {
      callback(mockBlob);
    });

    await renderAndEncode(decoded, 'webp', 0.5, { scale: 0.5 });

    expect(mockCanvas.toBlob).toHaveBeenCalledWith(expect.any(Function), 'image/webp', 0.5);
  });

  it('should not resize when scale is exactly 1', async () => {
    const decoded = createMockDecodedImage(100, 100);
    const mockBlob = new Blob(['jpeg-data'], { type: 'image/jpeg' });
    mockCanvas.toBlob = vi.fn((callback: (blob: Blob | null) => void) => {
      callback(mockBlob);
    });

    await renderAndEncode(decoded, 'jpeg', 0.92, { scale: 1 });

    expect(mockCtx.drawImage).not.toHaveBeenCalled();
    expect(mockCtx.putImageData).toHaveBeenCalledTimes(1);
  });

  it('should let scale take precedence over maxWidth and maxHeight', async () => {
    const decoded = createMockDecodedImage(200, 100);
    const mockBlob = new Blob(['jpeg-data'], { type: 'image/jpeg' });
    mockCanvas.toBlob = vi.fn((callback: (blob: Blob | null) => void) => {
      callback(mockBlob);
    });

    await renderAndEncode(decoded, 'jpeg', 0.92, { maxWidth: 50, maxHeight: 50, scale: 0.5 });

    expect(mockCtx.drawImage).toHaveBeenCalledWith(expect.any(Object), 0, 0, 100, 50);
  });

  it('should keep a 1x1 image at 1x1 when downscaled', async () => {
    const decoded = createMockDecodedImage(1, 1);
    const mockBlob = new Blob(['jpeg-data'], { type: 'image/jpeg' });
    mockCanvas.toBlob = vi.fn((callback: (blob: Blob | null) => void) => {
      callback(mockBlob);
    });

    await renderAndEncode(decoded, 'jpeg', 0.92, { scale: 0.5 });

    expect(mockCtx.drawImage).not.toHaveBeenCalled();
    expect(mockCtx.putImageData).toHaveBeenCalledTimes(1);
  });

  it('should encode PNG with resize', async () => {
    const decoded = createMockDecodedImage(100, 100);
    const mockBlob = new Blob(['png-data'], { type: 'image/png' });
    mockCanvas.toBlob = vi.fn((callback: (blob: Blob | null) => void) => {
      callback(mockBlob);
    });

    await renderAndEncode(decoded, 'png', 1, { scale: 0.5 });

    expect(mockCtx.drawImage).toHaveBeenCalledWith(expect.any(Object), 0, 0, 50, 50);
    expect(mockCanvas.toBlob).toHaveBeenCalledWith(expect.any(Function), 'image/png', undefined);
  });

  it('should normalize jpg format with resize', async () => {
    const decoded = createMockDecodedImage(100, 100);
    const mockBlob = new Blob(['jpeg-data'], { type: 'image/jpeg' });
    mockCanvas.toBlob = vi.fn((callback: (blob: Blob | null) => void) => {
      callback(mockBlob);
    });

    await renderAndEncode(decoded, 'jpg', 0.8, { scale: 0.5 });

    expect(mockCanvas.toBlob).toHaveBeenCalledWith(expect.any(Function), 'image/jpeg', 0.8);
  });

  it('should resize with OffscreenCanvas when available', async () => {
    const decoded = createMockDecodedImage(100, 100);
    const mockBlob = new Blob(['jpeg-data'], { type: 'image/jpeg' });

    const mockOffscreenCtx = {
      putImageData: vi.fn(),
      drawImage: vi.fn(),
    };
    const closeMock = vi.fn();
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
      close = closeMock;
    };

    global.OffscreenCanvas = MockOffscreenCanvasClass as unknown as typeof OffscreenCanvas;

    const result = await renderAndEncode(decoded, 'jpeg', 0.92, { scale: 0.5 });

    expect(result).toBeInstanceOf(Blob);
    expect(mockOffscreenCtx.drawImage).toHaveBeenCalledWith(expect.any(Object), 0, 0, 50, 50);
    expect(closeMock).toHaveBeenCalled();
    expect(convertToBlobMock).toHaveBeenCalledWith({ type: 'image/jpeg', quality: 0.92 });
  });

  it('should resize using the createImageData fallback when ImageData is unavailable', async () => {
    const decoded = createMockDecodedImage(100, 100);
    const mockBlob = new Blob(['jpeg-data'], { type: 'image/jpeg' });
    mockCanvas.toBlob = vi.fn((callback: (blob: Blob | null) => void) => {
      callback(mockBlob);
    });

    const createdImageData = new Uint8ClampedArray(100 * 100 * 4);
    mockCtx.createImageData = vi.fn().mockReturnValue({ data: createdImageData });
    global.ImageData = undefined as unknown as typeof ImageData;

    const result = await renderAndEncode(decoded, 'jpeg', 0.92, { scale: 0.5 });

    expect(result).toBeInstanceOf(Blob);
    expect(mockCtx.createImageData).toHaveBeenCalledWith(100, 100);
    expect(mockCtx.drawImage).toHaveBeenCalledWith(expect.any(Object), 0, 0, 50, 50);
  });

  it('should throw when the source canvas context is unavailable', async () => {
    const decoded = createMockDecodedImage(100, 100);
    // First getContext call (target canvas) succeeds, second (source canvas) returns null.
    mockCanvas.getContext = vi
      .fn()
      .mockReturnValueOnce(mockCtx)
      .mockReturnValueOnce(null);

    await expect(renderAndEncode(decoded, 'jpeg', 0.92, { scale: 0.5 })).rejects.toThrow(
      'Failed to acquire 2D rendering context from canvas'
    );
  });
});
