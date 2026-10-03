import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderAndEncode } from '../../src/render/canvas';
import type { DecodedImage } from '../../src/types';

interface MockContext {
  putImageData: ReturnType<typeof vi.fn>;
  createImageData: ReturnType<typeof vi.fn>;
  drawImage: ReturnType<typeof vi.fn>;
  setTransform: ReturnType<typeof vi.fn>;
}

interface MockCanvasObject {
  width: number;
  height: number;
  getContext: ReturnType<typeof vi.fn>;
  toBlob: ReturnType<typeof vi.fn>;
}

/** Stored-pixel fixture image; orientation is added only when requested. */
const decodedImage = (width: number, height: number, orientation?: number): DecodedImage => ({
  width,
  height,
  data: new Uint8ClampedArray(width * height * 4).fill(255),
  ...(orientation === undefined ? {} : { orientation }),
});

describe('renderAndEncode - Orientation', () => {
  let mockCtx: MockContext;
  let createdCanvases: MockCanvasObject[];
  // Canvas geometry captured at encode time: releaseCanvas() zeroes the
  // target after toBlob, so post-await width/height reads would be 0.
  let encodeDims: Array<{ w: number; h: number }>;
  let toBlobImpl: (
    callback: (blob: Blob | null) => void,
    type?: string,
    quality?: number
  ) => void;
  let originalDocument: typeof document;
  let originalOffscreenCanvas: typeof OffscreenCanvas;
  let originalImageData: typeof ImageData;

  beforeEach(() => {
    originalDocument = global.document;
    originalOffscreenCanvas = global.OffscreenCanvas;
    originalImageData = global.ImageData;

    mockCtx = {
      putImageData: vi.fn(),
      createImageData: vi.fn(),
      drawImage: vi.fn(),
      setTransform: vi.fn(),
    };
    createdCanvases = [];
    encodeDims = [];
    toBlobImpl = (callback) => {
      const target = createdCanvases[0];
      encodeDims.push({ w: target.width, h: target.height });
      callback(new Blob(['blob'], { type: 'image/jpeg' }));
    };

    // Same per-canvas stub strategy as canvas.resize.test.ts: target canvas
    // is created first, the full-resolution source canvas second.
    global.document = {
      createElement: vi.fn(() => {
        const canvas: MockCanvasObject = {
          width: 0,
          height: 0,
          getContext: vi.fn().mockReturnValue(mockCtx),
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
  });

  it('orientation 6 swaps output axes and applies the rotate-90-CW transform', async () => {
    const result = await renderAndEncode(decodedImage(1600, 1200, 6), 'jpeg', 0.92);

    expect(result.type).toBe('image/jpeg');
    // Target canvas is sized to the *display* geometry (portrait).
    expect(encodeDims).toEqual([{ w: 1200, h: 1600 }]);
    // Pixels were written at the stored (landscape) geometry…
    expect(mockCtx.putImageData).toHaveBeenCalledWith(
      expect.objectContaining({ width: 1600, height: 1200 }),
      0,
      0
    );
    // …and drawn into the target through the orientation transform.
    expect(mockCtx.setTransform).toHaveBeenCalledWith(0, 1, -1, 0, 1200, 0);
    expect(mockCtx.drawImage).toHaveBeenCalledWith(expect.any(Object), 0, 0);
  });

  it.each([
    [2, [-1, 0, 0, 1, 1600, 0]],
    [3, [-1, 0, 0, -1, 1600, 1200]],
    [4, [1, 0, 0, -1, 0, 1200]],
    [5, [0, 1, 1, 0, 0, 0]],
    [6, [0, 1, -1, 0, 1200, 0]],
    [7, [0, -1, -1, 0, 1200, 1600]],
    [8, [0, -1, 1, 0, 0, 1600]],
  ])('orientation %i maps to matrix %j', async (orientation, matrix) => {
    await renderAndEncode(decodedImage(1600, 1200, orientation), 'png', 1);
    expect(mockCtx.setTransform).toHaveBeenCalledWith(
      ...(matrix as [number, number, number, number, number, number])
    );
  });

  it('composes the orientation transform with resize scaling', async () => {
    await renderAndEncode(decodedImage(1600, 1200, 6), 'jpeg', 0.92, { scale: 0.5 });

    // Display is 1200x1600; scale 0.5 → target 600x800; sx=sy=0.5 applied
    // row-wise to the orientation-6 matrix.
    expect(encodeDims).toEqual([{ w: 600, h: 800 }]);
    expect(mockCtx.setTransform).toHaveBeenCalledWith(0, 0.5, -0.5, 0, 600, 0);
    expect(mockCtx.drawImage).toHaveBeenCalledWith(expect.any(Object), 0, 0);
  });

  it('applyOrientation: false keeps the stored geometry and never transforms', async () => {
    await renderAndEncode(decodedImage(1600, 1200, 6), 'jpeg', 0.92, undefined, false);

    expect(encodeDims).toEqual([{ w: 1600, h: 1200 }]);
    expect(mockCtx.setTransform).not.toHaveBeenCalled();
    expect(mockCtx.drawImage).not.toHaveBeenCalled();
    expect(mockCtx.putImageData).toHaveBeenCalledTimes(1);
  });

  it('orientation-free decoded images (and invalid values) stay on the identity path', async () => {
    const values: Array<number | undefined> = [undefined, 1, 0, 9, 1.5];
    for (const orientation of values) {
      mockCtx.setTransform.mockClear();
      mockCtx.drawImage.mockClear();
      mockCtx.putImageData.mockClear();
      createdCanvases.length = 0;
      encodeDims.length = 0;

      await renderAndEncode(decodedImage(100, 80, orientation), 'jpeg', 0.92);

      expect(encodeDims).toEqual([{ w: 100, h: 80 }]);
      expect(mockCtx.setTransform).not.toHaveBeenCalled();
      expect(mockCtx.drawImage).not.toHaveBeenCalled();
      expect(mockCtx.putImageData).toHaveBeenCalledTimes(1);
    }
  });

  it('orientation 7 with a resize bound scales the swapped display size', async () => {
    // Stored 1600x1200 landscape, orientation 7 (swaps): display 1200x1600;
    // maxHeight 800 → ratio 0.5 → target 600x800.
    await renderAndEncode(decodedImage(1600, 1200, 7), 'jpeg', 0.92, { maxHeight: 800 });

    expect(encodeDims).toEqual([{ w: 600, h: 800 }]);
    expect(mockCtx.setTransform).toHaveBeenCalledWith(0, -0.5, -0.5, 0, 600, 800);
  });

  it('orientation applies to the SVG wrapper at display dimensions', async () => {
    const originalFileReader = global.FileReader;
    global.FileReader = class {
      result = 'data:image/png;base64,AAAA';
      error = null;
      readAsDataURL(): void {
        setTimeout(() => this.onloadend?.(), 0);
      }
      onloadend?: () => void;
      onerror?: () => void;
    } as unknown as typeof FileReader;

    toBlobImpl = (callback, type) => {
      const target = createdCanvases[0];
      encodeDims.push({ w: target.width, h: target.height });
      callback(new Blob(['x'], { type: (type as string) ?? 'image/png' }));
    };

    try {
      const blob = await renderAndEncode(decodedImage(1600, 1200, 6), 'svg', 0.92);
      expect(blob.type).toBe('image/svg+xml');
      expect(encodeDims).toEqual([{ w: 1200, h: 1600 }]);
      expect(mockCtx.setTransform).toHaveBeenCalledWith(0, 1, -1, 0, 1200, 0);
    } finally {
      global.FileReader = originalFileReader;
    }
  });
});
