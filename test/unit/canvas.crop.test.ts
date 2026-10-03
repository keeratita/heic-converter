import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderAndEncode } from '../../src/render/canvas';
import type { CropOptions, DecodedImage } from '../../src/types';

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

const decodedImage = (width: number, height: number, orientation?: number): DecodedImage => ({
  width,
  height,
  data: new Uint8ClampedArray(width * height * 4).fill(255),
  ...(orientation === undefined ? {} : { orientation }),
});

/**
 * setTransform composition (stored → display → crop translate → resize
 * scale): A=a·sx, B=b·sy, C=c·sx, D=d·sy, E=sx·(e−x), F=sy·(f−y).
 */
describe('renderAndEncode - Crop', () => {
  let mockCtx: MockContext;
  let createdCanvases: MockCanvasObject[];
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

  it('crop sizes the target to the crop box and translates the source by (-x, -y)', async () => {
    const crop: CropOptions = { x: 100, y: 50, width: 200, height: 150 };
    await renderAndEncode(decodedImage(1600, 1200), 'jpeg', 0.92, undefined, true, crop);

    expect(encodeDims).toEqual([{ w: 200, h: 150 }]);
    // Pixels are written at full stored resolution…
    expect(mockCtx.putImageData).toHaveBeenCalledWith(
      expect.objectContaining({ width: 1600, height: 1200 }),
      0,
      0
    );
    // …then drawn through the crop translation.
    expect(mockCtx.setTransform).toHaveBeenCalledWith(1, 0, 0, 1, -100, -50);
    expect(mockCtx.drawImage).toHaveBeenCalledWith(expect.any(Object), 0, 0);
  });

  it('x and y default to 0', async () => {
    await renderAndEncode(decodedImage(1600, 1200), 'jpeg', 0.92, undefined, true, {
      width: 100,
      height: 80,
    });

    expect(encodeDims).toEqual([{ w: 100, h: 80 }]);
    expect(mockCtx.setTransform).toHaveBeenCalledWith(1, 0, 0, 1, 0, 0);
  });

  it('resize downscale applies to the cropped region, not the full image', async () => {
    // Crop 600x400 out of 1200x800, then maxWidth 300 → ratio 0.5 on the
    // *crop* dimensions → target 300x200; sx=sy=0.5 and the translation is
    // scaled too: E = 0.5·(0 − 100) = −50.
    const crop: CropOptions = { x: 100, y: 50, width: 600, height: 400 };
    await renderAndEncode(decodedImage(1200, 800), 'jpeg', 0.92, { maxWidth: 300 }, true, crop);

    expect(encodeDims).toEqual([{ w: 300, h: 200 }]);
    expect(mockCtx.setTransform).toHaveBeenCalledWith(0.5, 0, 0, 0.5, -50, -25);
  });

  it('crop composes with orientation (display-space coordinates)', async () => {
    // Stored 1600x1200 landscape, orientation 6 → display 1200x1600. The
    // crop box lives in display space: (200, 400, 300, 400).
    // m6 = [0, 1, -1, 0, 1200, 0]; sx = sy = 1 →
    // A=0, B=1, C=-1, D=0, E=1200−200=1000, F=0−400=−400.
    const crop: CropOptions = { x: 200, y: 400, width: 300, height: 400 };
    await renderAndEncode(decodedImage(1600, 1200, 6), 'jpeg', 0.92, undefined, true, crop);

    expect(encodeDims).toEqual([{ w: 300, h: 400 }]);
    expect(mockCtx.setTransform).toHaveBeenCalledWith(0, 1, -1, 0, 1000, -400);
    expect(mockCtx.drawImage).toHaveBeenCalledWith(expect.any(Object), 0, 0);
  });

  it('crop + orientation + resize compose into a single transform', async () => {
    // Display 1200x1600; crop 600x800 at origin; maxHeight 400 → ratio 0.5
    // → target 300x400; sx = 0.5, sy = 0.5:
    // A=0, B=1·0.5, C=−1·0.5, D=0, E=0.5·(1200−0)=600, F=0.5·(0−0)=0.
    const crop: CropOptions = { x: 0, y: 0, width: 600, height: 800 };
    await renderAndEncode(decodedImage(1600, 1200, 6), 'jpeg', 0.92, { maxHeight: 400 }, true, crop);

    expect(encodeDims).toEqual([{ w: 300, h: 400 }]);
    expect(mockCtx.setTransform).toHaveBeenCalledWith(0, 0.5, -0.5, 0, 600, 0);
  });

  it('applyOrientation: false crops the stored geometry instead', async () => {
    // Orientation 6 pending but ignored: crop operates on stored 1600x1200.
    const crop: CropOptions = { x: 100, y: 50, width: 200, height: 150 };
    await renderAndEncode(decodedImage(1600, 1200, 6), 'jpeg', 0.92, undefined, false, crop);

    expect(encodeDims).toEqual([{ w: 200, h: 150 }]);
    expect(mockCtx.setTransform).toHaveBeenCalledWith(1, 0, 0, 1, -100, -50);
  });

  it('a full-frame crop is allowed and identity-transforms', async () => {
    await renderAndEncode(decodedImage(300, 200), 'jpeg', 0.92, undefined, true, {
      x: 0,
      y: 0,
      width: 300,
      height: 200,
    });

    expect(encodeDims).toEqual([{ w: 300, h: 200 }]);
    expect(mockCtx.setTransform).toHaveBeenCalledWith(1, 0, 0, 1, 0, 0);
  });

  it('rejects a crop wider than the image with invalid_crop', async () => {
    const error = await renderAndEncode(decodedImage(1600, 1200), 'jpeg', 0.92, undefined, true, {
      x: 1500,
      y: 0,
      width: 200,
      height: 100,
    }).catch((e) => e);

    expect(error).toMatchObject({ code: 'invalid_crop' });
    expect(error.message).toContain('exceeds the 1600x1200 image');
    expect(error.message).toContain('post-orientation display pixels');
  });

  it('rejects a crop taller than the image with invalid_crop', async () => {
    const error = await renderAndEncode(decodedImage(1600, 1200), 'jpeg', 0.92, undefined, true, {
      x: 0,
      y: 1150,
      width: 100,
      height: 100,
    }).catch((e) => e);

    expect(error).toMatchObject({ code: 'invalid_crop' });
    expect(error.message).toContain('at (0, 1150)');
    expect(error.message).toContain('exceeds the 1600x1200 image');
  });

  it('range checks run against display dimensions, not stored dimensions', async () => {
    // Stored 1600x1200 with orientation 6: display is 1200x1600, so a crop
    // 1300 wide exceeds the image even though it fits the stored landscape.
    const error = await renderAndEncode(decodedImage(1600, 1200, 6), 'jpeg', 0.92, undefined, true, {
      x: 0,
      y: 0,
      width: 1300,
      height: 100,
    }).catch((e) => e);

    expect(error).toMatchObject({ code: 'invalid_crop' });
    expect(error.message).toContain('exceeds the 1200x1600 image');
  });

  it('rejects malformed crop shapes up front, before any canvas is created', async () => {
    const badCrops: CropOptions[] = [
      { width: 0, height: 10 },
      { width: 1.5, height: 10 },
      { width: -10, height: 10 },
      { width: '100' as unknown as number, height: 10 },
      { width: 10, height: 0 },
      { width: 10, height: NaN },
      { x: -1, width: 10, height: 10 },
      { y: 2.5, width: 10, height: 10 },
    ];

    for (const crop of badCrops) {
      const error = await renderAndEncode(decodedImage(100, 80), 'jpeg', 0.92, undefined, true, crop).catch(
        (e) => e
      );
      expect(error).toMatchObject({ code: 'invalid_crop' });
    }
    // Shape validation happens before pixel/canvas work.
    expect(createdCanvases).toHaveLength(0);
    expect(mockCtx.putImageData).not.toHaveBeenCalled();
  });

  it('crop applies to the SVG wrapper at crop dimensions', async () => {
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
      const blob = await renderAndEncode(decodedImage(1600, 1200), 'svg', 0.92, undefined, true, {
        x: 0,
        y: 0,
        width: 300,
        height: 200,
      });
      expect(blob.type).toBe('image/svg+xml');
      expect(encodeDims).toEqual([{ w: 300, h: 200 }]);
      expect(mockCtx.setTransform).toHaveBeenCalledWith(1, 0, 0, 1, 0, 0);
    } finally {
      global.FileReader = originalFileReader;
    }
  });
});
