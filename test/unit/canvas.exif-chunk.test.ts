import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The EXIF writers are a lazy chunk. When it cannot be fetched the conversion must
// still succeed and carry no EXIF, not reject with a module-load error.
vi.mock('../../src/render/exif', () => {
  throw new Error('Failed to fetch dynamically imported module .../dist/exif-XXXX.js');
});

import { renderAndEncode } from '../../src/render/canvas';
import type { DecodedImage } from '../../src/types';

const TIFF = new Uint8Array([
  0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00, 0x12, 0x01,
  0x03, 0x00, 0x01, 0x00, 0x00, 0x00, 0x06, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
]);
const EXIF_BLOCK = new Uint8Array([0x45, 0x78, 0x69, 0x66, 0x00, 0x00, ...TIFF]);

// Structurally valid enough for the injector to accept, matching canvas.exif.test.ts.
const JFIF_PAYLOAD = [0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01];
const CANVAS_JPEG = new Uint8Array([
  0xff, 0xd8,
  0xff, 0xe0, (JFIF_PAYLOAD.length + 2) >> 8, (JFIF_PAYLOAD.length + 2) & 0xff, ...JFIF_PAYLOAD,
  0xff, 0xda, 0x00, 0x01, 0x00,
  0xff, 0xd9,
]);

const decodedImage = (): DecodedImage => ({
  width: 2,
  height: 2,
  data: new Uint8ClampedArray(2 * 2 * 4).fill(255),
  exif: EXIF_BLOCK,
});

/** A failed lazy `./exif` import degrades to "no metadata", like the other fail-safe paths. */
describe('renderAndEncode - preserveExif when the EXIF chunk cannot be loaded', () => {
  let originalDocument: typeof document;
  let originalOffscreenCanvas: typeof OffscreenCanvas;
  let originalImageData: typeof ImageData;

  beforeEach(() => {
    originalDocument = global.document;
    originalOffscreenCanvas = global.OffscreenCanvas;
    originalImageData = global.ImageData;
    const ctx = {
      putImageData: vi.fn(),
      createImageData: vi.fn(() => ({ data: new Uint8ClampedArray(4) })),
      drawImage: vi.fn(),
      setTransform: vi.fn(),
    };
    global.document = {
      createElement: vi.fn(() => ({
        width: 0,
        height: 0,
        getContext: vi.fn().mockReturnValue(ctx),
        toBlob: vi.fn((callback: (blob: Blob | null) => void, type?: string) => {
          const copy = CANVAS_JPEG.slice();
          callback(new Blob([copy.buffer as ArrayBuffer], { type: type ?? 'image/jpeg' }));
        }),
      })),
    } as unknown as typeof document;
    global.OffscreenCanvas = undefined as unknown as typeof OffscreenCanvas;
    global.ImageData = class {
      data: Uint8ClampedArray;
      constructor(w: number, h: number) {
        this.data = new Uint8ClampedArray(w * h * 4);
      }
    } as unknown as typeof ImageData;
  });

  afterEach(() => {
    global.document = originalDocument;
    global.OffscreenCanvas = originalOffscreenCanvas;
    global.ImageData = originalImageData;
  });

  it('resolves with the encoder bytes unchanged instead of rejecting', async () => {
    const blob = await renderAndEncode(decodedImage(), 'jpeg', 0.9, undefined, false, undefined, true);
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe('image/jpeg');
    // Unchanged: the APP1 EXIF segment was never spliced in.
    const bytes = new Uint8Array(await blob.arrayBuffer());
    expect(bytes).toEqual(CANVAS_JPEG);
  });
});
