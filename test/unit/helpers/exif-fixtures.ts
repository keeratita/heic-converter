import type { DecodedImage } from '../../../src/types';

// Shared by the EXIF injector and render-stage tests: the same block must be
// accepted by both, so the fixtures live in one place.

/**
 * Minimal little-endian TIFF with one IFD0 entry: tag 0x0112 (Orientation) = 6,
 * i.e. the pixels need a 90° CW rotation for display. Shared by the injector,
 * render-stage and chunk-failure tests: the same block must be accepted by all
 * of them, so it lives in one place.
 */
export const TIFF = new Uint8Array([
  0x49, 0x49, 0x2a, 0x00, // II + magic 42
  0x08, 0x00, 0x00, 0x00, // IFD0 at 8
  0x01, 0x00, // 1 entry
  0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00, 0x06, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, // next IFD: none
]);

/** JPEG APP1 payload form the C++ wrapper normalizes to: "Exif\0\0" + TIFF. */
export const EXIF_BLOCK = new Uint8Array([0x45, 0x78, 0x69, 0x66, 0x00, 0x00, ...TIFF]);

// A tiny but structurally valid JPEG (SOI, APP0/JFIF, SOS, EOI) that the
// injector will accept, standing in for what the canvas encoder "produced".
export const JFIF_PAYLOAD = [0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01];
export const CANVAS_JPEG = new Uint8Array([
  0xff, 0xd8,
  0xff, 0xe0, (JFIF_PAYLOAD.length + 2) >> 8, (JFIF_PAYLOAD.length + 2) & 0xff, ...JFIF_PAYLOAD,
  0xff, 0xda, 0x00, 0x01, 0x00,
  0xff, 0xd9,
]);

export const decodedImageWithExif = (): DecodedImage => ({
  width: 2,
  height: 2,
  data: new Uint8ClampedArray(2 * 2 * 4).fill(255),
  exif: EXIF_BLOCK,
});
