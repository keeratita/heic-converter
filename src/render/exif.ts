/**
 * Post-encode EXIF re-injection for JPEG (APP1 segment) and PNG (eXIf chunk).
 *
 * Canvas encoding drops all source metadata; when `preserveExif: true` these
 * helpers splice the decoded `DecodedImage.exif` block back into the encoded
 * bytes. Both injectors are fail-safe by design: any surprise while parsing
 * the encoded output (or a malformed EXIF block) returns the original bytes
 * untouched — losing metadata is always preferable to emitting a corrupt
 * image.
 */

/** "Exif\0\0" — the marker preceding the TIFF structure in JPEG APP1. */
const EXIF_MARKER = new Uint8Array([0x45, 0x78, 0x69, 0x66, 0x00, 0x00]);

const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function hasExifMarker(block: Uint8Array): boolean {
  if (block.length < EXIF_MARKER.length + 8) {
    return false;
  }
  for (let i = 0; i < EXIF_MARKER.length; i++) {
    if (block[i] !== EXIF_MARKER[i]) {
      return false;
    }
  }
  return isTiffHeader(block, EXIF_MARKER.length);
}

function isTiffHeader(bytes: Uint8Array, at: number): boolean {
  if (at + 8 > bytes.length) {
    return false;
  }
  const le = bytes[at] === 0x49 && bytes[at + 1] === 0x49; // 'II'
  const be = bytes[at] === 0x4d && bytes[at + 1] === 0x4d; // 'MM'
  if (!le && !be) {
    return false;
  }
  const magic = le
    ? bytes[at + 2] | (bytes[at + 3] << 8)
    : (bytes[at + 2] << 8) | bytes[at + 3];
  return magic === 42;
}

function readU16BE(bytes: Uint8Array, at: number): number {
  return (bytes[at] << 8) | bytes[at + 1];
}

function readU32BE(bytes: Uint8Array, at: number): number {
  return ((bytes[at] << 24) | (bytes[at + 1] << 16) | (bytes[at + 2] << 8) | bytes[at + 3]) >>> 0;
}

/**
 * Rewrite the TIFF orientation tag (274) in a `"Exif\0\0" + TIFF` block to
 * `1` (normal) and return a modified copy. Needed because the converted
 * raster is already upright — the EXIF/orientation transform was applied at
 * render (or by libheif for `irot`/`imir` files) — so carrying the source
 * tag verbatim would tell EXIF-respecting consumers to rotate the image a
 * second time. Fail-safe: anything malformed returns the block untouched,
 * and the input array is never mutated.
 */
export function normalizeOrientationTag(block: Uint8Array): Uint8Array {
  try {
    if (!hasExifMarker(block)) {
      return block;
    }
    const tiff = EXIF_MARKER.length;
    const littleEndian = block[tiff] === 0x49; // 'II' (MM handled by hasExifMarker)
    const u16 = (at: number): number =>
      littleEndian
        ? block[at] | (block[at + 1] << 8)
        : (block[at] << 8) | block[at + 1];
    const u32 = (at: number): number =>
      littleEndian
        ? ((block[at + 3] << 24) | (block[at + 2] << 16) | (block[at + 1] << 8) | block[at]) >>> 0
        : ((block[at] << 24) | (block[at + 1] << 16) | (block[at + 2] << 8) | block[at + 3]) >>> 0;

    const ifd0Off = u32(tiff + 4);
    // IFD0 must sit inside the block; entry count is its first field.
    if (ifd0Off < 8 || tiff + ifd0Off + 2 > block.length) {
      return block;
    }
    const ifd0 = tiff + ifd0Off;
    const entries = u16(ifd0);
    for (let i = 0; i < entries; i++) {
      const entry = ifd0 + 2 + i * 12;
      if (entry + 12 > block.length) {
        return block; // truncated entry table — do not touch
      }
      if (u16(entry) !== 0x0112) {
        continue;
      }
      const type = u16(entry + 2);
      const count = u32(entry + 4);
      if (type !== 3 || count !== 1) {
        return block; // non-standard encoding of orientation — leave as-is
      }
      const value = littleEndian
        ? block[entry + 8] | (block[entry + 9] << 8)
        : (block[entry + 8] << 8) | block[entry + 9];
      if (value === 1) {
        return block; // already normal
      }
      const out = block.slice();
      out[entry + 8] = littleEndian ? 1 : 0;
      out[entry + 9] = littleEndian ? 0 : 1;
      out[entry + 10] = 0;
      out[entry + 11] = 0;
      return out;
    }
    return block; // no orientation entry
  } catch {
    return block;
  }
}

/**
 * Insert the EXIF block as a JPEG APP1 segment, positioned after SOI and any
 * leading APPn/COM segments (the conventional slot right after the JFIF
 * APP0). Returns the original bytes unchanged when the JPEG does not parse,
 * the block is malformed, or the block exceeds the 16-bit segment length
 * field (EXIF payloads >64 KB are rare in HEIC items and splitting across
 * multiple APP1 segments is out of scope).
 */
export function injectExifIntoJpeg(jpeg: Uint8Array, exifBlock: Uint8Array): Uint8Array {
  try {
    if (jpeg.length < 4 || jpeg[0] !== 0xff || jpeg[1] !== 0xd8) {
      return jpeg;
    }
    if (!hasExifMarker(exifBlock)) {
      return jpeg;
    }
    const segmentLength = exifBlock.length + 2; // length field covers itself
    if (segmentLength > 0xffff) {
      return jpeg;
    }

    // Walk over the leading APPn/COM segments; insert before everything else
    // (SOF/DHT/DQT/SOS/EOI all act as the stop marker).
    let pos = 2;
    while (pos < jpeg.length) {
      if (pos + 4 > jpeg.length) {
        return jpeg; // truncated segment header
      }
      if (jpeg[pos] !== 0xff) {
        return jpeg; // desynchronized segment stream — do not touch
      }
      const marker = jpeg[pos + 1];
      if (marker === 0xff) {
        pos += 1; // fill/stuff byte between markers
        continue;
      }
      const isSkippable = (marker >= 0xe0 && marker <= 0xef) || marker === 0xfe;
      if (!isSkippable) {
        break;
      }
      const length = readU16BE(jpeg, pos + 2);
      if (length < 2 || pos + 2 + length > jpeg.length) {
        return jpeg;
      }
      pos += 2 + length;
    }

    const out = new Uint8Array(jpeg.length + 4 + exifBlock.length);
    out.set(jpeg.subarray(0, pos), 0);
    out[pos] = 0xff;
    out[pos + 1] = 0xe1;
    out[pos + 2] = (segmentLength >> 8) & 0xff;
    out[pos + 3] = segmentLength & 0xff;
    out.set(exifBlock, pos + 4);
    out.set(jpeg.subarray(pos), pos + 4 + exifBlock.length);
    return out;
  } catch {
    return jpeg;
  }
}

let crcTable: Uint32Array | undefined;

function getCrcTable(): Uint32Array {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      crcTable[n] = c >>> 0;
    }
  }
  return crcTable;
}

/** CRC-32 (PNG polynomial), computed over type+data as the spec requires. */
function crc32(bytes: Uint8Array): number {
  const table = getCrcTable();
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = table[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunkTypeEquals(bytes: Uint8Array, at: number, type: string): boolean {
  return (
    bytes[at] === type.charCodeAt(0) &&
    bytes[at + 1] === type.charCodeAt(1) &&
    bytes[at + 2] === type.charCodeAt(2) &&
    bytes[at + 3] === type.charCodeAt(3)
  );
}

/**
 * Insert the EXIF TIFF structure as a PNG `eXIf` chunk (PNG Extensions
 * registry: chunk data is the raw TIFF without the "Exif\0\0" JPEG marker).
 * Positioned after IHDR and before the first IDAT (or IEND when there is no
 * IDAT); an existing eXIf chunk wins untouched. Fail-safe: unparsable PNG
 * input is returned unchanged.
 */
export function injectExifIntoPng(png: Uint8Array, exifBlock: Uint8Array): Uint8Array {
  try {
    // 8-byte signature + minimal IHDR chunk (12 overhead + 13 data).
    if (png.length < 33) {
      return png;
    }
    for (let i = 0; i < PNG_SIGNATURE.length; i++) {
      if (png[i] !== PNG_SIGNATURE[i]) {
        return png;
      }
    }
    if (readU32BE(png, 8) !== 13 || !chunkTypeEquals(png, 12, 'IHDR')) {
      return png;
    }
    if (!hasExifMarker(exifBlock)) {
      return png;
    }
    const tiff = exifBlock.subarray(EXIF_MARKER.length);

    // Walk chunks from after IHDR to the insertion point.
    let pos = 8 + 12 + 13;
    while (pos + 8 <= png.length) {
      const length = readU32BE(png, pos);
      if (length > png.length || pos + 12 + length > png.length) {
        return png; // chunk data runs past the buffer — not a chunk boundary, bail out
      }
      if (chunkTypeEquals(png, pos + 4, 'IDAT') || chunkTypeEquals(png, pos + 4, 'IEND')) {
        break;
      }
      if (chunkTypeEquals(png, pos + 4, 'eXIf')) {
        return png; // already carries EXIF — never duplicate
      }
      pos += 12 + length;
    }

    const chunk = new Uint8Array(12 + tiff.length);
    chunk[0] = (tiff.length >>> 24) & 0xff;
    chunk[1] = (tiff.length >>> 16) & 0xff;
    chunk[2] = (tiff.length >>> 8) & 0xff;
    chunk[3] = tiff.length & 0xff;
    chunk.set([0x65, 0x58, 0x49, 0x66], 4); // 'eXIf'
    chunk.set(tiff, 8);
    const crc = crc32(chunk.subarray(4, 8 + tiff.length));
    chunk[8 + tiff.length] = (crc >>> 24) & 0xff;
    chunk[9 + tiff.length] = (crc >>> 16) & 0xff;
    chunk[10 + tiff.length] = (crc >>> 8) & 0xff;
    chunk[11 + tiff.length] = crc & 0xff;

    const out = new Uint8Array(png.length + chunk.length);
    out.set(png.subarray(0, pos), 0);
    out.set(chunk, pos);
    out.set(png.subarray(pos), pos + chunk.length);
    return out;
  } catch {
    return png;
  }
}
