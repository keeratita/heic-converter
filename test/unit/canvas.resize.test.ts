import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderAndEncode } from '../../src/render/canvas';
import { DecodedImage } from '../../src/types';

interface MockContext {
  putImageData: ReturnType<typeof vi.fn>;
  createImageData: ReturnType<typeof vi.fn>;
  drawImage: ReturnType<typeof vi.fn>;
}

interface MockCanvasObject {
  width: number;
  height: number;
  getContext: ReturnType<typeof vi.fn>;
  toBlob: ReturnType<typeof vi.fn>;
}

const createMockDecodedImage = (width: number, height: number): DecodedImage => ({
  width,
  height,
  data: new Uint8ClampedArray(width * height * 4).fill(255),
});

describe('renderAndEncode - Resize', () => {
  let mockCtx: MockContext;
  let createdCanvases: MockCanvasObject[];
  // Queued getContext() results (one per canvas creation); when exhausted,
  // the shared mockCtx is returned. Lets tests fail the source-canvas
  // context lookup specifically.
  let contextResults: unknown[];
  // Per-test toBlob behaviour, shared by every canvas created in that test.
  let toBlobImpl: (
    callback: (blob: Blob | null) => void,
    type?: string,
    quality?: number
  ) => void;
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
    };
    createdCanvases = [];
    contextResults = [];
    toBlobImpl = (callback) => callback(new Blob(['blob'], { type: 'image/jpeg' }));

    // Each createElement() yields an independent canvas: the resize path
    // creates a target canvas first and a full-resolution source canvas
    // second, and releaseCanvas() zeroes them at different times — sharing
    // one stub between them would hide that.
    global.document = {
      createElement: vi.fn(() => {
        const results = contextResults;
        const canvas: MockCanvasObject = {
          width: 0,
          height: 0,
          getContext: vi.fn().mockImplementation(() => {
            if (results.length > 0) {
              return results.shift();
            }
            return mockCtx;
          }),
          toBlob: vi.fn((callback, type?, quality?) => toBlobImpl(callback, type, quality)),
        };
        createdCanvases.push(canvas);
        return canvas as unknown as HTMLCanvasElement;
      }),
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

  /** Canvas the encoded blob comes from: created first. */
  const targetCanvas = (): MockCanvasObject => createdCanvases[0];
  /** Full-resolution canvas the resize path draws from: created second. */
  const sourceCanvas = (): MockCanvasObject => createdCanvases[1];

  it('should downscale with scale factor and draw the source canvas scaled', async () => {
    const decoded = createMockDecodedImage(100, 100);
    const mockBlob = new Blob(['jpeg-data'], { type: 'image/jpeg' });
    toBlobImpl = (callback) => callback(mockBlob);

    const result = await renderAndEncode(decoded, 'jpeg', 0.92, { scale: 0.5 });

    expect(result.type).toBe('image/jpeg');
    expect(mockCtx.drawImage).toHaveBeenCalledWith(expect.any(Object), 0, 0, 50, 50);
    expect(targetCanvas().toBlob).toHaveBeenCalledWith(expect.any(Function), 'image/jpeg', 0.92);
  });

  it('should release the full-resolution source canvas before encoding', async () => {
    const decoded = createMockDecodedImage(100, 100);
    const mockBlob = new Blob(['jpeg-data'], { type: 'image/jpeg' });
    const stateAtEncode: Array<{ sourceWidth: number; target: [number, number] }> = [];
    toBlobImpl = (callback) => {
      // Peak-memory fix: the full-res source must be released before the
      // encode runs, while the target is still alive at its scaled size.
      // releaseCanvas() frees the HTMLCanvasElement backing store via width=0.
      stateAtEncode.push({
        sourceWidth: sourceCanvas().width,
        target: [targetCanvas().width, targetCanvas().height],
      });
      callback(mockBlob);
    };

    await renderAndEncode(decoded, 'jpeg', 0.92, { scale: 0.5 });

    expect(stateAtEncode).toEqual([{ sourceWidth: 0, target: [50, 50] }]);
  });

  it('should upscale with a scale factor greater than 1', async () => {
    const decoded = createMockDecodedImage(10, 10);
    const mockBlob = new Blob(['png-data'], { type: 'image/png' });
    toBlobImpl = (callback) => callback(mockBlob);

    await renderAndEncode(decoded, 'png', 1, { scale: 2 });

    expect(mockCtx.drawImage).toHaveBeenCalledWith(expect.any(Object), 0, 0, 20, 20);
  });

  it('should downscale to fit within maxWidth while preserving aspect ratio', async () => {
    const decoded = createMockDecodedImage(200, 100);
    toBlobImpl = (callback) => callback(new Blob(['jpeg-data'], { type: 'image/jpeg' }));

    await renderAndEncode(decoded, 'jpeg', 0.92, { maxWidth: 100 });

    expect(mockCtx.drawImage).toHaveBeenCalledWith(expect.any(Object), 0, 0, 100, 50);
  });

  it('should downscale to fit within maxHeight while preserving aspect ratio', async () => {
    const decoded = createMockDecodedImage(200, 100);
    toBlobImpl = (callback) => callback(new Blob(['jpeg-data'], { type: 'image/jpeg' }));

    await renderAndEncode(decoded, 'jpeg', 0.92, { maxHeight: 50 });

    expect(mockCtx.drawImage).toHaveBeenCalledWith(expect.any(Object), 0, 0, 100, 50);
  });

  it('should not upscale when maxWidth is larger than the image', async () => {
    const decoded = createMockDecodedImage(100, 100);
    const mockBlob = new Blob(['jpeg-data'], { type: 'image/jpeg' });
    toBlobImpl = (callback) => callback(mockBlob);

    await renderAndEncode(decoded, 'jpeg', 0.92, { maxWidth: 1000 });

    expect(mockCtx.drawImage).not.toHaveBeenCalled();
    expect(targetCanvas().toBlob).toHaveBeenCalledWith(expect.any(Function), 'image/jpeg', 0.92);
    // No resize: only the target canvas exists.
    expect(createdCanvases).toHaveLength(1);
  });

  it('should not resize when no resize options are provided', async () => {
    const decoded = createMockDecodedImage(100, 100);
    toBlobImpl = (callback) => callback(new Blob(['jpeg-data'], { type: 'image/jpeg' }));

    await renderAndEncode(decoded, 'jpeg', 0.92);

    expect(mockCtx.drawImage).not.toHaveBeenCalled();
    expect(mockCtx.putImageData).toHaveBeenCalledTimes(1);
    expect(createdCanvases).toHaveLength(1);
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
    toBlobImpl = (callback) => callback(mockPngBlob);

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
    toBlobImpl = (callback) => callback(mockBlob);

    await renderAndEncode(decoded, 'webp', 0.5, { scale: 0.5 });

    expect(targetCanvas().toBlob).toHaveBeenCalledWith(expect.any(Function), 'image/webp', 0.5);
  });

  it('should not resize when scale is exactly 1', async () => {
    const decoded = createMockDecodedImage(100, 100);
    toBlobImpl = (callback) => callback(new Blob(['jpeg-data'], { type: 'image/jpeg' }));

    await renderAndEncode(decoded, 'jpeg', 0.92, { scale: 1 });

    expect(mockCtx.drawImage).not.toHaveBeenCalled();
    expect(mockCtx.putImageData).toHaveBeenCalledTimes(1);
    expect(createdCanvases).toHaveLength(1);
  });

  it('should let scale take precedence over maxWidth and maxHeight', async () => {
    const decoded = createMockDecodedImage(200, 100);
    toBlobImpl = (callback) => callback(new Blob(['jpeg-data'], { type: 'image/jpeg' }));

    await renderAndEncode(decoded, 'jpeg', 0.92, { maxWidth: 50, maxHeight: 50, scale: 0.5 });

    expect(mockCtx.drawImage).toHaveBeenCalledWith(expect.any(Object), 0, 0, 100, 50);
  });

  it('should keep a 1x1 image at 1x1 when downscaled', async () => {
    const decoded = createMockDecodedImage(1, 1);
    toBlobImpl = (callback) => callback(new Blob(['jpeg-data'], { type: 'image/jpeg' }));

    await renderAndEncode(decoded, 'jpeg', 0.92, { scale: 0.5 });

    expect(mockCtx.drawImage).not.toHaveBeenCalled();
    expect(mockCtx.putImageData).toHaveBeenCalledTimes(1);
  });

  it('should encode PNG with resize', async () => {
    const decoded = createMockDecodedImage(100, 100);
    const mockBlob = new Blob(['png-data'], { type: 'image/png' });
    toBlobImpl = (callback) => callback(mockBlob);

    await renderAndEncode(decoded, 'png', 1, { scale: 0.5 });

    expect(mockCtx.drawImage).toHaveBeenCalledWith(expect.any(Object), 0, 0, 50, 50);
    expect(targetCanvas().toBlob).toHaveBeenCalledWith(expect.any(Function), 'image/png', undefined);
  });

  it('should normalize jpg format with resize', async () => {
    const decoded = createMockDecodedImage(100, 100);
    const mockBlob = new Blob(['jpeg-data'], { type: 'image/jpeg' });
    toBlobImpl = (callback) => callback(mockBlob);

    await renderAndEncode(decoded, 'jpg', 0.8, { scale: 0.5 });

    expect(targetCanvas().toBlob).toHaveBeenCalledWith(expect.any(Function), 'image/jpeg', 0.8);
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
    // Both the released source and the encoded target are closed.
    expect(closeMock).toHaveBeenCalledTimes(2);
    expect(convertToBlobMock).toHaveBeenCalledWith({ type: 'image/jpeg', quality: 0.92 });
  });

  it('should resize using the createImageData fallback when ImageData is unavailable', async () => {
    const decoded = createMockDecodedImage(100, 100);
    const mockBlob = new Blob(['jpeg-data'], { type: 'image/jpeg' });
    toBlobImpl = (callback) => callback(mockBlob);

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
    // First canvas (target) gets a context, second (source) gets null.
    contextResults = [mockCtx, null];

    await expect(renderAndEncode(decoded, 'jpeg', 0.92, { scale: 0.5 })).rejects.toThrow(
      'Failed to acquire 2D rendering context from canvas'
    );
  });
});
