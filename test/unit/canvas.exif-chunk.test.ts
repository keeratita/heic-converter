import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The EXIF writers are a lazy chunk. When it cannot be fetched the conversion must
// still succeed and carry no EXIF, not reject with a module-load error.
vi.mock('../../src/render/exif', () => {
  throw new Error('Failed to fetch dynamically imported module .../dist/exif-XXXX.js');
});

import { renderAndEncode, __resetExifChunkWarning } from '../../src/render/canvas';
import { CANVAS_JPEG, decodedImageWithExif } from './helpers/exif-fixtures';

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
    const blob = await renderAndEncode(decodedImageWithExif(), 'jpeg', 0.9, undefined, false, undefined, true);
    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe('image/jpeg');
    // Unchanged: the APP1 EXIF segment was never spliced in.
    const bytes = new Uint8Array(await blob.arrayBuffer());
    expect(bytes).toEqual(CANVAS_JPEG);
  });

  it('warns once that metadata was dropped, so a bad deploy is not silent success', async () => {
    // The equivalent worker failure surfaces as `worker_load_failed`; without
    // this, "no EXIF because the chunk 404s" looks like "no EXIF in the file".
    __resetExifChunkWarning();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await renderAndEncode(decodedImageWithExif(), 'jpeg', 0.9, undefined, false, undefined, true);
    await renderAndEncode(decodedImageWithExif(), 'jpeg', 0.9, undefined, false, undefined, true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain('dist/exif-');
    warn.mockRestore();
  });
});
