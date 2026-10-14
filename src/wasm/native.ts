import { HeicConverterError } from '../errors';
import type { DecodedImage, IHeicDecoder } from '../types';

/**
 * Platform-native HEIC decoding — the Strategy behind `nativeDecode: true`.
 * On HEIC-capable hosts (Safari/iOS, Edge, Windows) ImageIO decodes in
 * hardware and the bundled libheif payload is never fetched. Dynamic-import
 * only, so hosts that never opt in never download this chunk.
 */

/**
 * Decoded-dimension cap, a duplicate of `MAX_CANVAS_DIMENSION` in
 * render/canvas.ts (pinned equal by native-decoder.test.ts) so this lazy
 * chunk stays out of the render module graph.
 */
export const MAX_NATIVE_DECODE_DIMENSION = 16384;

/**
 * Total-pixel cap, a duplicate of `kMaxDecodePixels` in
 * build-wasm/wrapper/main.cpp (pinned equal by native-decoder.test.ts, same
 * lazy-chunk-purity reason as the dimension cap). Without it, a
 * container-declared 16384x16384 passes both side checks and the canvas +
 * ImageData pair below allocates ~1 GB outside the WASM heap — the libheif
 * path rejects that size, so native must not accept it.
 */
export const MAX_NATIVE_DECODE_PIXELS = 64 * 1024 * 1024;

/**
 * Per-realm refusal flag, sticky only for an environment-class failure
 * (missing platform APIs at initialize()). Decode-class failures — corrupt
 * file, absurd declared size, transient 2D pressure — are input properties,
 * so convertHeic retries them without caching: one bad upload must not cost
 * the page its native acceleration. Success is not cached: there is no
 * pre-decode API that tells a decodable file from a corrupt one.
 */
let nativeHeicRefused = false;
let refusedWarned = false;

/** @internal Whether this realm has refused native decoding (decoder selection). */
export function isNativeHeicRefused(): boolean {
  return nativeHeicRefused;
}

/**
 * @internal Record an environment-class native failure so later calls skip
 * the attempt. The once-only warn is the breadcrumb: without it the page
 * silently loses the opt-in with nothing naming the cause.
 */
export function markNativeHeicRefused(): void {
  nativeHeicRefused = true;
  if (!refusedWarned) {
    refusedWarned = true;
    console.warn(
      '@keeratita/heic-converter: native HEIC decoding is unavailable in this environment — ' +
        'nativeDecode conversions will use the bundled decoder on this page.'
    );
  }
}

/** @internal Clear the refusal verdict and its breadcrumb (tests only). */
export function __resetNativeHeicProbe(): void {
  nativeHeicRefused = false;
  refusedWarned = false;
}

/**
 * createImageBitmap + OffscreenCanvas readback behind the same
 * `DecodedImage` contract as LibheifDecoder, so the render stage is shared.
 * `imageOrientation: 'from-image'` applies the display transform (EXIF and
 * irot/imir), so results are upright with no pending orientation — the
 * selection policy only picks this Strategy when `applyOrientation` is not
 * false. Errors never reach a consumer: convertHeic retries with libheif,
 * which produces the typed error of record, so these strings stay chunk-local.
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
    // Per spec, browser Blob construction rejects SharedArrayBuffer-backed
    // parts (DataCloneError); only those need the detaching copy. Copying
    // unconditionally would put every input through memory twice to defend
    // one edge case. (Node's Blob does not throw, so the copy is pinned by
    // inspecting the constructor argument, not by bytes — native-decoder.test.ts.)
    const bytes: Uint8Array<ArrayBuffer> =
      typeof SharedArrayBuffer !== 'undefined' && data.buffer instanceof SharedArrayBuffer
        ? new Uint8Array(data)
        : (data as Uint8Array<ArrayBuffer>); // the guard above proves this is not SAB-backed
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/heic' }), {
      imageOrientation: 'from-image',
    });
    try {
      if (bitmap.width > MAX_NATIVE_DECODE_DIMENSION || bitmap.height > MAX_NATIVE_DECODE_DIMENSION) {
        // Container-declared dimensions are attacker-controlled: the canvas +
        // ImageData pair below would allocate outside the WASM heap (an
        // uncatchable tab crash). Bail to libheif's bounded-heap semantics;
        // the platform bitmap itself cannot be capped pre-decode.
        throw new HeicConverterError(
          'decode_failed',
          `Native HEIC decoding is limited to ${MAX_NATIVE_DECODE_DIMENSION}px per side, got ${bitmap.width}x${bitmap.height}.`
        );
      }
      if (bitmap.width * bitmap.height > MAX_NATIVE_DECODE_PIXELS) {
        // Both sides pass at up to 16384 each — a 16384x8192 container clears
        // the side cap but allocates ~512 MB here. Same budget as the WASM
        // path's kMaxDecodePixels; checked before any canvas/ImageData exists.
        throw new HeicConverterError(
          'decode_failed',
          `Native HEIC decoding is limited to ${MAX_NATIVE_DECODE_PIXELS / (1024 * 1024)}MP total, got ${bitmap.width}x${bitmap.height} (${bitmap.width * bitmap.height} pixels).`
        );
      }
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
      return { width: image.width, height: image.height, data: image.data };
    } finally {
      bitmap.close?.();
    }
  }

  free(): void {
    // Nothing WASM-side to release; the bitmap is closed in decode().
  }
}
