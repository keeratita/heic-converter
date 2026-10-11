import { HeicConverterError } from '../errors';
import type { DecodedImage, IHeicDecoder } from '../types';

/**
 * Platform-native HEIC decoding — the Strategy behind `nativeDecode: true`.
 * On HEIC-capable hosts (Safari/iOS, Edge, Windows) ImageIO decodes in
 * hardware and the bundled libheif payload is never fetched. Dynamic-import
 * only, so hosts that never opt in never download this chunk.
 */

/**
 * Per-realm verdict: undefined = unprobed. There is no HEIC-support API, so
 * the first opted-in conversion doubles as the probe; failures are sticky
 * and successes stop later calls re-attempting.
 */
let nativeHeicSupport: boolean | undefined;

/** @internal Read the cached capability verdict (decoder selection). */
export function getNativeHeicSupport(): boolean | undefined {
  return nativeHeicSupport;
}

/** @internal Record a native success (the probe verdict). */
export function markNativeHeicSupported(): void {
  nativeHeicSupport = true;
}

/** @internal Record a native failure so later calls skip the attempt. */
export function markNativeHeicUnsupported(): void {
  nativeHeicSupport = false;
}

/** @internal Reset the capability verdict (tests only). */
export function __resetNativeHeicProbe(): void {
  nativeHeicSupport = undefined;
}

/**
 * createImageBitmap + OffscreenCanvas readback behind the same
 * `DecodedImage` contract as LibheifDecoder, so the render stage is shared.
 * `imageOrientation: 'from-image'` applies the display transform (EXIF and
 * irot/imir), so results are upright with no pending orientation — the
 * selection policy only picks this Strategy when `applyOrientation` is not
 * false. Errors here never reach a consumer: convertHeic marks the realm
 * unsupported and retries with libheif, which produces the typed error of
 * record, so these strings stay chunk-local (like worker-only messages).
 */
export class NativeHeicDecoder implements IHeicDecoder {
  async initialize(): Promise<void> {
    if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas === 'undefined') {
      throw new HeicConverterError(
        'decoder_init_failed',
        'Native HEIC decoding is unavailable in this environment.'
      );
    }
  }

  async decode(data: Uint8Array): Promise<DecodedImage> {
    // Blob rejects SharedArrayBuffer-backed input; copy to detach.
    const bytes = new Uint8Array(data);
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/heic' }), {
      imageOrientation: 'from-image',
    });
    try {
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) {
        throw new HeicConverterError(
          'decode_failed',
          'Could not acquire a 2D context for native HEIC pixel readback.'
        );
      }
      ctx.drawImage(bitmap, 0, 0);
      // ImageData.data is owned: pixels survive close(), like the WASM copy.
      const image = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
      markNativeHeicSupported();
      return { width: image.width, height: image.height, data: image.data };
    } finally {
      bitmap.close?.();
    }
  }

  free(): void {
    // Nothing WASM-side to release; the bitmap is closed in decode().
  }
}
