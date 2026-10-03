import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderAndEncode } from '../../src/render/canvas';
import type { DecodedImage } from '../../src/types';

interface MockCanvasObject {
  width: number;
  height: number;
  getContext: ReturnType<typeof vi.fn>;
  toBlob: ReturnType<typeof vi.fn>;
}

const TIFF = new Uint8Array([
  0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00, 0x12, 0x01,
  0x03, 0x00, 0x01, 0x00, 0x00, 0x00, 0x06, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
]);
const EXIF_BLOCK = new Uint8Array([0x45, 0x78, 0x69, 0x66, 0x00, 0x00, ...TIFF]);

// A tiny but structurally valid JPEG (SOI, APP0/JFIF, SOS, EOI) that the
// injector will accept, standing in for what the canvas encoder "produced".
const JFIF_PAYLOAD = [0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01];
const CANVAS_JPEG = new Uint8Array([
  0xff, 0xd8,
  0xff, 0xe0, (JFIF_PAYLOAD.length + 2) >> 8, (JFIF_PAYLOAD.length + 2) & 0xff, ...JFIF_PAYLOAD,
  0xff, 0xda, 0x00, 0x01, 0x00,
  0xff, 0xd9,
]);

const PNG_CRC = (bytes: Uint8Array): number => {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
};

const pngChunk = (type: string, data: number[]): Uint8Array => {
  const chunk = new Uint8Array(12 + data.length);
  chunk[3] = data.length;
  for (let i = 0; i < 4; i++) chunk[4 + i] = type.charCodeAt(i);
  chunk.set(new Uint8Array(data), 8);
  const crc = PNG_CRC(chunk.subarray(4, 8 + data.length));
  chunk[8 + data.length] = (crc >>> 24) & 0xff;
  chunk[9 + data.length] = (crc >>> 16) & 0xff;
  chunk[10 + data.length] = (crc >>> 8) & 0xff;
  chunk[11 + data.length] = crc & 0xff;
  return chunk;
};

const CANVAS_PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  ...pngChunk('IHDR', new Array(13).fill(0)),
  ...pngChunk('IDAT', [0x78, 0x9c, 0x63, 0x00]),
  ...pngChunk('IEND', []),
]);

const decodedImage = (exif?: Uint8Array): DecodedImage => ({
  width: 2,
  height: 2,
  data: new Uint8ClampedArray(2 * 2 * 4).fill(255),
  ...(exif ? { exif } : {}),
});

/**
 * preserveExif wiring at the render layer: the mocked canvas "encoder"
 * returns fixed JPEG/PNG bytes; renderAndEncode must splice the decoded
 * EXIF block into them (and leave them alone when the flag is off or the
 * bytes do not parse).
 */
describe('renderAndEncode - preserveExif', () => {
  let createdCanvases: MockCanvasObject[];
  let encodedBytes: Uint8Array;
  let encodedType: string;
  let originalDocument: typeof document;
  let originalOffscreenCanvas: typeof OffscreenCanvas;
  let originalImageData: typeof ImageData;

  beforeEach(() => {
    originalDocument = global.document;
    originalOffscreenCanvas = global.OffscreenCanvas;
    originalImageData = global.ImageData;
    createdCanvases = [];
    encodedBytes = CANVAS_JPEG;
    encodedType = 'image/jpeg';

    const ctx = {
      putImageData: vi.fn(),
      createImageData: vi.fn(() => ({ data: new Uint8ClampedArray(4) })),
      drawImage: vi.fn(),
      setTransform: vi.fn(),
    };

    global.document = {
      createElement: vi.fn(() => {
        const canvas: MockCanvasObject = {
          width: 0,
          height: 0,
          getContext: vi.fn().mockReturnValue(ctx),
          toBlob: vi.fn((callback: (blob: Blob | null) => void, type?: string) => {
            callback(new Blob([encodedBytes.slice().buffer as ArrayBuffer], { type: type ?? encodedType }));
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
  });

  const containsSequence = (bytes: Uint8Array, needle: number[]): boolean => {
    outer: for (let i = 0; i + needle.length <= bytes.length; i++) {
      for (let j = 0; j < needle.length; j++) {
        if (bytes[i + j] !== needle[j]) continue outer;
      }
      return true;
    }
    return false;
  };

  const APP1_EXIF = [0xff, 0xe1];
  const EXIF_MARKER = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00];

  it('re-injects the EXIF APP1 segment into JPEG output when preserveExif is on', async () => {
    const blob = await renderAndEncode(decodedImage(EXIF_BLOCK), 'jpeg', 0.92, undefined, true, undefined, true);
    const bytes = new Uint8Array(await blob.arrayBuffer());

    expect(containsSequence(bytes, APP1_EXIF)).toBe(true);
    expect(containsSequence(bytes, EXIF_MARKER)).toBe(true);
    expect(containsSequence(bytes, Array.from(TIFF.subarray(0, 4)))).toBe(true);
    expect(bytes[0]).toBe(0xff);
    expect(bytes[1]).toBe(0xd8); // still a valid-looking JPEG head
  });

  it('leaves JPEG output untouched by default (opt-in), even with a decoded block', async () => {
    const blob = await renderAndEncode(decodedImage(EXIF_BLOCK), 'jpeg', 0.92);
    const bytes = new Uint8Array(await blob.arrayBuffer());

    expect(containsSequence(bytes, APP1_EXIF)).toBe(false);
    expect(bytes.length).toBe(CANVAS_JPEG.length);
  });

  it('re-injects an eXIf chunk into PNG output when preserveExif is on', async () => {
    encodedBytes = CANVAS_PNG;
    const blob = await renderAndEncode(decodedImage(EXIF_BLOCK), 'png', 1, undefined, true, undefined, true);
    const bytes = new Uint8Array(await blob.arrayBuffer());

    const hasEIfChunk = containsSequence(bytes, [0x65, 0x58, 0x49, 0x66]); // 'eXIf'
    expect(hasEIfChunk).toBe(true);
    // PNG carries the TIFF without the JPEG marker; the TIFF header is there.
    expect(containsSequence(bytes, [0x49, 0x49, 0x2a, 0x00])).toBe(true);
  });

  it('is a no-op when the decode produced no EXIF block', async () => {
    const blob = await renderAndEncode(decodedImage(), 'jpeg', 0.92, undefined, true, undefined, true);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    expect(containsSequence(bytes, APP1_EXIF)).toBe(false);
    expect(bytes.length).toBe(CANVAS_JPEG.length);
  });

  it('fails safe when the encoded bytes do not parse (returns them unchanged)', async () => {
    encodedBytes = new TextEncoder().encode('this is not a jpeg');
    const blob = await renderAndEncode(decodedImage(EXIF_BLOCK), 'jpeg', 0.92, undefined, true, undefined, true);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    expect(new TextDecoder().decode(bytes)).toBe('this is not a jpeg');
  });

  it('keeps the blob MIME type on the re-injected output', async () => {
    const blob = await renderAndEncode(decodedImage(EXIF_BLOCK), 'jpeg', 0.92, undefined, true, undefined, true);
    expect(blob.type).toBe('image/jpeg');
  });

  // --- orientation-tag normalization (double-rotation prevention) ----------

  const indexOfSequence = (bytes: Uint8Array, needle: number[]): number => {
    outer: for (let i = 0; i + needle.length <= bytes.length; i++) {
      for (let j = 0; j < needle.length; j++) {
        if (bytes[i + j] !== needle[j]) continue outer;
      }
      return i;
    }
    return -1;
  };

  /** Little-endian orientation value inside the APP1 block spliced into bytes. */
  const injectedOrientation = async (blob: Blob): Promise<number> => {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const at = indexOfSequence(bytes, EXIF_MARKER);
    expect(at).toBeGreaterThan(-1);
    const valueAt = at + 6 + 18; // marker + TIFF IFD0 entry value field
    return bytes[valueAt] | (bytes[valueAt + 1] << 8);
  };

  it('normalizes the orientation tag to 1 when the pending rotation was applied', async () => {
    const blob = await renderAndEncode(
      { ...decodedImage(EXIF_BLOCK), orientation: 6 },
      'jpeg',
      0.92,
      undefined,
      true,
      undefined,
      true
    );
    expect(await injectedOrientation(blob)).toBe(1);
    expect(EXIF_BLOCK[24]).toBe(6); // decoded block never mutated
  });

  it('normalizes the orientation tag when no pending orientation was reported (irot already applied)', async () => {
    // No decoded.orientation: libheif applied irot/imir at decode, so the
    // raster is already upright — the stale tag must not survive injection.
    const blob = await renderAndEncode(decodedImage(EXIF_BLOCK), 'jpeg', 0.92, undefined, true, undefined, true);
    expect(await injectedOrientation(blob)).toBe(1);
  });

  it('keeps the orientation tag verbatim when applyOrientation is false', async () => {
    // applyOrientation:false keeps stored geometry — the tag legitimately
    // describes it and consumers must still rotate.
    const blob = await renderAndEncode(
      { ...decodedImage(EXIF_BLOCK), orientation: 6 },
      'jpeg',
      0.92,
      undefined,
      false,
      undefined,
      true
    );
    expect(await injectedOrientation(blob)).toBe(6);
  });
});
