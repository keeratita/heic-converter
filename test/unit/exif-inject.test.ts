import { describe, expect, it } from 'vitest';
import { injectExifIntoJpeg, injectExifIntoPng } from '../../src/render/exif';

// --- fixtures -------------------------------------------------------------

/** Minimal little-endian TIFF with an orientation (0x0112) = 6 entry. */
const TIFF = new Uint8Array([
  0x49, 0x49, 0x2a, 0x00, // II + magic 42
  0x08, 0x00, 0x00, 0x00, // IFD0 at 8
  0x01, 0x00, // 1 entry
  0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, 0x06, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, // next IFD: none
]);

/** JPEG APP1 payload form: "Exif\0\0" + TIFF. */
const EXIF_BLOCK = new Uint8Array([0x45, 0x78, 0x69, 0x66, 0x00, 0x00, ...TIFF]);

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};

const SOI = new Uint8Array([0xff, 0xd8]);
const EOI = new Uint8Array([0xff, 0xd9]);

/** A marker segment with a 16-bit length field covering itself. */
const segment = (marker: number, payload: number[]): Uint8Array =>
  new Uint8Array([0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 0xff, ...payload]);

const JFIF_APP0 = segment(0xe0, [0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01]);
const COM = segment(0xfe, [0x63, 0x6f, 0x6d, 0x6d, 0x65, 0x6e, 0x74]);
const SOF0 = segment(0xc0, [0x00, 0x01, 0x00, 0x01, 0x03]);
const SOS = segment(0xda, [0x00]);
const DQT = segment(0xdb, [0x00, 0x01]);

const jpeg = (...segments: Uint8Array[]): Uint8Array => concat(SOI, ...segments, EOI);

/** Bitwise CRC-32 (PNG polynomial) — deliberately independent of the
 * implementation under test (which uses a table). */
function crc32Bitwise(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngChunk(type: string, data: number[] | Uint8Array): Uint8Array {
  const body = data instanceof Uint8Array ? data : new Uint8Array(data);
  const chunk = new Uint8Array(12 + body.length);
  const len = body.length;
  chunk[0] = (len >>> 24) & 0xff;
  chunk[1] = (len >>> 16) & 0xff;
  chunk[2] = (len >>> 8) & 0xff;
  chunk[3] = len & 0xff;
  for (let i = 0; i < 4; i++) {
    chunk[4 + i] = type.charCodeAt(i);
  }
  chunk.set(body, 8);
  const crc = crc32Bitwise(chunk.subarray(4, 8 + body.length));
  chunk[8 + body.length] = (crc >>> 24) & 0xff;
  chunk[9 + body.length] = (crc >>> 16) & 0xff;
  chunk[10 + body.length] = (crc >>> 8) & 0xff;
  chunk[11 + body.length] = crc & 0xff;
  return chunk;
}

const IHDR = pngChunk('IHDR', new Uint8Array(13));
const IDAT = pngChunk('IDAT', [0x78, 0x9c, 0x01, 0x02]);
const IEND = pngChunk('IEND', []);
const TEXT_CHUNK = pngChunk('tEXt', [0x61, 0x00, 0x62]);

const png = (...chunks: Uint8Array[]): Uint8Array => concat(PNG_SIGNATURE, ...chunks);

function parseChunks(pngBytes: Uint8Array): Array<{ type: string; data: Uint8Array; crcOk: boolean }> {
  const out: Array<{ type: string; data: Uint8Array; crcOk: boolean }> = [];
  let pos = PNG_SIGNATURE.length;
  while (pos + 12 <= pngBytes.length) {
    const len =
      ((pngBytes[pos] << 24) | (pngBytes[pos + 1] << 16) | (pngBytes[pos + 2] << 8) | pngBytes[pos + 3]) >>> 0;
    const type = String.fromCharCode(...pngBytes.subarray(pos + 4, pos + 8));
    const data = pngBytes.subarray(pos + 8, pos + 8 + len);
    const crcAt = pos + 8 + len;
    const expected =
      ((pngBytes[crcAt] << 24) | (pngBytes[crcAt + 1] << 16) | (pngBytes[crcAt + 2] << 8) | pngBytes[crcAt + 3]) >>> 0;
    out.push({ type, data, crcOk: crc32Bitwise(pngBytes.subarray(pos + 4, pos + 8 + len)) === expected });
    pos += 12 + len;
  }
  return out;
}

const contains = (bytes: Uint8Array, needle: Uint8Array): boolean =>
  bytes
    .subarray(0, bytes.length - needle.length + 1)
    .some((_, i) => needle.every((b, j) => bytes[i + j] === b));

// --- JPEG ------------------------------------------------------------------

describe('injectExifIntoJpeg', () => {
  it('inserts the APP1 segment after SOI when no leading segments exist', () => {
    const out = injectExifIntoJpeg(jpeg(SOS), EXIF_BLOCK);

    expect(out[2]).toBe(0xff);
    expect(out[3]).toBe(0xe1);
    const segLen = (out[4] << 8) | out[5];
    expect(segLen).toBe(EXIF_BLOCK.length + 2);
    expect(contains(out, EXIF_BLOCK)).toBe(true);
    // Original content preserved: still ends with the SOS + EOI tail.
    expect(out.subarray(6 + EXIF_BLOCK.length)).toEqual(jpeg(SOS).subarray(2));
  });

  it('places APP1 after the JFIF APP0 (and COM) run', () => {
    const out = injectExifIntoJpeg(jpeg(JFIF_APP0, COM, SOS), EXIF_BLOCK);

    expect(out.subarray(0, 2)).toEqual(SOI);
    // Scan marker sequence: APP0, APP1(Exif), COM stays before APP1? No —
    // APP1 is inserted after the whole skippable run: APP0, COM, APP1, SOS.
    const markers: number[] = [];
    let pos = 2;
    while (pos + 2 <= out.length) {
      if (out[pos] !== 0xff) break;
      const marker = out[pos + 1];
      markers.push(marker);
      if (marker === 0xd9) break;
      const len = (out[pos + 2] << 8) | out[pos + 3];
      pos += 2 + len;
    }
    expect(markers).toEqual([0xe0, 0xfe, 0xe1, 0xda, 0xd9]);
  });

  it('inserts before SOF when the first non-skippable segment is SOF', () => {
    const out = injectExifIntoJpeg(jpeg(JFIF_APP0, SOF0, DQT, SOS), EXIF_BLOCK);

    const markers: number[] = [];
    let pos = 2;
    while (pos + 2 <= out.length) {
      if (out[pos] !== 0xff) break;
      const marker = out[pos + 1];
      markers.push(marker);
      if (marker === 0xd9) break;
      const len = (out[pos + 2] << 8) | out[pos + 3];
      pos += 2 + len;
    }
    // APP1 lands between APP0 and SOF0.
    expect(markers).toEqual([0xe0, 0xe1, 0xc0, 0xdb, 0xda, 0xd9]);
  });

  it('returns the input unchanged (same reference) for non-JPEG bytes', () => {
    const notJpeg = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(injectExifIntoJpeg(notJpeg, EXIF_BLOCK)).toBe(notJpeg);
  });

  it('returns the input unchanged when truncated or too short', () => {
    const tiny = new Uint8Array([0xff, 0xd8]);
    expect(injectExifIntoJpeg(tiny, EXIF_BLOCK)).toBe(tiny);

    const badLength = concat(SOI, new Uint8Array([0xff, 0xe0, 0xff, 0xff, 0x00]));
    expect(injectExifIntoJpeg(badLength, EXIF_BLOCK)).toBe(badLength);
  });

  it('returns the input unchanged when the marker stream desynchronizes', () => {
    const desynced = concat(SOI, new Uint8Array([0x00, 0x01, 0x02, 0x03]));
    expect(injectExifIntoJpeg(desynced, EXIF_BLOCK)).toBe(desynced);
  });

  it('rejects an EXIF block without the Exif\\0\\0 marker', () => {
    const jpegBytes = jpeg(SOS);
    expect(injectExifIntoJpeg(jpegBytes, TIFF)).toBe(jpegBytes);
  });

  it('refuses payloads that do not fit the 16-bit APP1 length field', () => {
    const huge = new Uint8Array(65534 - 2 + 1 + EXIF_BLOCK.length);
    huge.set(EXIF_BLOCK, 0); // still marker-prefixed and TIFF-headed
    // Pad so total length exceeds 65533 (segment length field limit).
    const jpegBytes = jpeg(SOS);
    expect(injectExifIntoJpeg(jpegBytes, huge)).toBe(jpegBytes);
  });
});

// --- PNG --------------------------------------------------------------------

describe('injectExifIntoPng', () => {
  it('inserts an eXIf chunk with the raw TIFF between IHDR and IDAT', () => {
    const out = injectExifIntoPng(png(IHDR, IDAT, IEND), EXIF_BLOCK);

    const chunks = parseChunks(out);
    expect(chunks.map((c) => c.type)).toEqual(['IHDR', 'eXIf', 'IDAT', 'IEND']);
    const exifChunk = chunks[1];
    // PNG eXIf carries the TIFF WITHOUT the JPEG "Exif\0\0" marker.
    expect(Array.from(exifChunk.data)).toEqual(Array.from(TIFF));
    expect(exifChunk.crcOk).toBe(true);
    // Other chunks survived intact.
    expect(chunks.every((c) => c.crcOk)).toBe(true);
  });

  it('computes a spec-correct CRC for a known chunk (independent cross-check)', () => {
    // Known-answer vector: CRC-32 of the bytes 'IHDR' for a zero-length
    // chunk data is 0xc4…? Use the bitwise helper as the oracle instead of
    // hardcoding, applied to the exact chunk the injector produced.
    const out = injectExifIntoPng(png(IHDR, IDAT, IEND), EXIF_BLOCK);
    const pos = PNG_SIGNATURE.length + IHDR.length;
    const lenField = (out[pos] << 24) | (out[pos + 1] << 16) | (out[pos + 2] << 8) | out[pos + 3];
    expect(lenField).toBe(TIFF.length);
    const expected = crc32Bitwise(out.subarray(pos + 4, pos + 8 + lenField));
    const written =
      ((out[pos + 8 + lenField] << 24) |
        (out[pos + 8 + lenField + 1] << 16) |
        (out[pos + 8 + lenField + 2] << 8) |
        out[pos + 8 + lenField + 3]) >>>
      0;
    expect(written).toBe(expected);
  });

  it('inserts before IEND when there is no IDAT', () => {
    const out = injectExifIntoPng(png(IHDR, IEND), EXIF_BLOCK);
    expect(parseChunks(out).map((c) => c.type)).toEqual(['IHDR', 'eXIf', 'IEND']);
  });

  it('skips ancillary chunks and still lands before IDAT', () => {
    const out = injectExifIntoPng(png(IHDR, TEXT_CHUNK, IDAT, IEND), EXIF_BLOCK);
    expect(parseChunks(out).map((c) => c.type)).toEqual(['IHDR', 'tEXt', 'eXIf', 'IDAT', 'IEND']);
  });

  it('never duplicates an existing eXIf chunk', () => {
    const existing = png(IHDR, pngChunk('eXIf', TIFF), IDAT, IEND);
    expect(injectExifIntoPng(existing, EXIF_BLOCK)).toBe(existing);
  });

  it('returns the input unchanged for malformed PNG containers', () => {
    const badSignature = concat(new Uint8Array([0x00]), PNG_SIGNATURE.subarray(1), IHDR, IDAT, IEND);
    expect(injectExifIntoPng(badSignature, EXIF_BLOCK)).toBe(badSignature);

    const short = PNG_SIGNATURE.subarray(0, 6);
    expect(injectExifIntoPng(short, EXIF_BLOCK)).toBe(short);

    const wrongIhdr = concat(PNG_SIGNATURE, pngChunk('IHDR'.replace('IHDR', 'IHDR'), new Uint8Array(12)));
    expect(injectExifIntoPng(wrongIhdr, EXIF_BLOCK)).toBe(wrongIhdr);

    // Chunk length claiming more bytes than the buffer holds.
    const lyingChunk = concat(
      PNG_SIGNATURE,
      IHDR,
      new Uint8Array([0x7f, 0xff, 0xff, 0xff, 0x74, 0x45, 0x58, 0x74, 0x00])
    );
    expect(injectExifIntoPng(lyingChunk, EXIF_BLOCK)).toBe(lyingChunk);

    // Mid-range lie: the length fits within png.length but pushes the walk
    // past the buffer, so the next "chunk boundary" lands beyond the end.
    const truncatedAncillary = concat(
      PNG_SIGNATURE,
      IHDR,
      new Uint8Array([0x00, 0x00, 0x00, 0x2e, 0x74, 0x45, 0x58, 0x74, 0xde, 0xad, 0xbe, 0xef])
    );
    expect(injectExifIntoPng(truncatedAncillary, EXIF_BLOCK)).toBe(truncatedAncillary);
  });

  it('rejects an EXIF block without the Exif\\0\\0 marker', () => {
    const pngBytes = png(IHDR, IDAT, IEND);
    expect(injectExifIntoPng(pngBytes, TIFF)).toBe(pngBytes);
  });
});
