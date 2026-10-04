import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderAndEncode, canEncodeAvif, assertEncodeCapability, __resetAvifProbe } from '../../src/render/canvas';
import type { DecodedImage } from '../../src/types';

interface MockCanvasObject {
  width: number;
  height: number;
  getContext: ReturnType<typeof vi.fn>;
  toBlob: ReturnType<typeof vi.fn>;
}

const decodedImage = (width: number, height: number): DecodedImage => ({
  width,
  height,
  data: new Uint8ClampedArray(width * height * 4).fill(255),
});

/**
 * AVIF encoding is not universally available; a naive implementation would
 * silently emit PNG (the spec's fallback for unknown types), so the module
 * probes once and rejects with `format_unsupported` instead. The probe is a
 * 1×1 canvas encode, cached at module level — every test resets it.
 */
describe('renderAndEncode - AVIF capability probe', () => {
  let mockCtx: {
    putImageData: ReturnType<typeof vi.fn>;
    createImageData: ReturnType<typeof vi.fn>;
    drawImage: ReturnType<typeof vi.fn>;
    setTransform: ReturnType<typeof vi.fn>;
  };
  let createdCanvases: MockCanvasObject[];
  let toBlobCalls: Array<{ type?: string; quality?: number }>;
  let toBlobImpl: (
    index: number,
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
    __resetAvifProbe();

    mockCtx = {
      putImageData: vi.fn(),
      createImageData: vi.fn(),
      drawImage: vi.fn(),
      setTransform: vi.fn(),
    };
    createdCanvases = [];
    toBlobCalls = [];
    // Type-faithful default: every requested type is "supported".
    toBlobImpl = (_index, callback, type) => {
      callback(new Blob(['blobby'], { type: type ?? 'image/png' }));
    };

    global.document = {
      createElement: vi.fn(() => {
        const index = createdCanvases.length;
        const canvas: MockCanvasObject = {
          width: 0,
          height: 0,
          getContext: vi.fn().mockReturnValue(mockCtx),
          toBlob: vi.fn((callback, type?, quality?) => {
            toBlobCalls.push({ type, quality });
            toBlobImpl(index, callback, type, quality);
          }),
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
    __resetAvifProbe();
  });

  it('encodes AVIF when the canvas supports it, probing once and encoding with quality', async () => {
    const blob = await renderAndEncode(decodedImage(100, 80), 'avif', 0.92);

    expect(blob.type).toBe('image/avif');
    // Call 1: probe (no quality); call 2: target encode with quality.
    expect(toBlobCalls).toEqual([
      { type: 'image/avif', quality: undefined },
      { type: 'image/avif', quality: 0.92 },
    ]);
    // Probe canvas (1×1) + target canvas.
    expect(createdCanvases).toHaveLength(2);
  });

  it('rejects with format_unsupported when the environment falls back to PNG', async () => {
    toBlobImpl = (_index, callback) => {
      callback(new Blob(['fake'], { type: 'image/png' }));
    };

    const error = await renderAndEncode(decodedImage(100, 80), 'avif', 0.92).catch((e) => e);

    expect(error).toMatchObject({ code: 'format_unsupported' });
    expect(error.message).toContain('avif');
    // The probe runs before any pixel work: only the probe canvas exists and
    // exactly one toBlob happened.
    expect(toBlobCalls).toHaveLength(1);
    expect(createdCanvases).toHaveLength(1);
    expect(mockCtx.putImageData).not.toHaveBeenCalled();
  });

  it('rejects with format_unsupported when toBlob yields a null blob', async () => {
    toBlobImpl = (_index, callback) => callback(null);

    const error = await renderAndEncode(decodedImage(100, 80), 'avif', 0.92).catch((e) => e);
    expect(error).toMatchObject({ code: 'format_unsupported' });
  });

  it('rejects with format_unsupported when the probe encode throws', async () => {
    toBlobImpl = () => {
      throw new Error('NotSupportedError');
    };

    const error = await renderAndEncode(decodedImage(100, 80), 'avif', 0.92).catch((e) => e);
    expect(error).toMatchObject({ code: 'format_unsupported' });
  });

  it('caches the probe across conversions', async () => {
    await renderAndEncode(decodedImage(100, 80), 'avif', 0.92);
    await renderAndEncode(decodedImage(50, 50), 'avif', 0.92);

    // One probe canvas total + two target canvases.
    expect(createdCanvases).toHaveLength(3);
    // Probe once + two target encodes.
    expect(toBlobCalls).toHaveLength(3);
  });

  it('never probes for other formats', async () => {
    await renderAndEncode(decodedImage(100, 80), 'jpeg', 0.92);

    expect(createdCanvases).toHaveLength(1);
    expect(toBlobCalls).toEqual([{ type: 'image/jpeg', quality: 0.92 }]);
  });

  it('defensively rejects when the final encode falls back despite a passed probe', async () => {
    let calls = 0;
    toBlobImpl = (_index, callback, type) => {
      calls += 1;
      // Probe (first call) says yes; the real encode lies and returns PNG.
      const effective = calls === 1 ? type : 'image/png';
      callback(new Blob(['blobby'], { type: effective ?? 'image/png' }));
    };

    const error = await renderAndEncode(decodedImage(100, 80), 'avif', 0.92).catch((e) => e);
    expect(error).toMatchObject({ code: 'format_unsupported' });
  });

  it('re-probes after a wedged (timed-out) probe instead of caching a false negative', async () => {
    vi.useFakeTimers();
    try {
      toBlobImpl = () => {
        // Wedged engine: the toBlob callback never fires (backgrounded tab,
        // memory pressure). The deadline must unblock the probe.
      };
      const first = canEncodeAvif();
      await vi.advanceTimersByTimeAsync(5000);
      // Indeterminate, not `false`: every awaiter of the wedged probe must not
      // be told the browser cannot encode AVIF.
      expect(await first).toBeUndefined();

      // Indeterminate results are NOT cached — a healthy next probe succeeds.
      toBlobImpl = (_index, callback) => callback(new Blob(['ok'], { type: 'image/avif' }));
      expect(await canEncodeAvif()).toBe(true);
      expect(toBlobCalls.filter((call) => call.type === 'image/avif')).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('caches a definitive probe result (no re-probing on repeated calls)', async () => {
    await canEncodeAvif();
    await canEncodeAvif();
    expect(toBlobCalls).toHaveLength(1);
  });

  it('assertEncodeCapability gates avif up-front and passes other formats through', async () => {
    toBlobImpl = (_index, callback) => callback(new Blob(['x'], { type: 'image/png' }));

    const error = await assertEncodeCapability('avif').catch((e) => e);
    expect(error).toMatchObject({ code: 'format_unsupported' });
    expect(await assertEncodeCapability('jpeg')).toBeUndefined();
    // A non-avif format never triggers a probe; only the rejected avif call did.
    expect(toBlobCalls).toHaveLength(1);
  });

  it('does not reject assertEncodeCapability on an indeterminate probe', async () => {
    // A starved 1×1 encode must not fail a batch with "AVIF is not supported"
    // on a browser that supports it; the encode-time blob.type check decides.
    vi.useFakeTimers();
    try {
      toBlobImpl = () => {
        // Wedged engine: no callback, no rejection.
      };
      const check = assertEncodeCapability('avif');
      await vi.advanceTimersByTimeAsync(5000);
      expect(await check).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not cache a canvas-creation failure as unsupported', async () => {
    // createCanvas can fail transiently under memory pressure; caching that as
    // "unsupported" would deny AVIF for the rest of the page's life.
    (global.document.createElement as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error('canvas allocation failed');
    });
    expect(await canEncodeAvif()).toBeUndefined();

    expect(await canEncodeAvif()).toBe(true);
    expect(toBlobCalls.filter((call) => call.type === 'image/avif')).toHaveLength(1);
  });
});
