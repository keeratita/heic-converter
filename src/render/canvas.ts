import type { CropOptions, DecodedImage, ImageFormat, ResizeOptions } from '../types';
import { Messages } from '../messages/core';
import { HeicConverterError } from '../errors';
import { validateCrop, validateFormat, validateResize } from '../validate';

// Option validators live in src/validate.ts (single source of truth shared
// with the orchestration layer); re-exported here for the render stage's own
// up-front re-checks.
export { validateCrop, validateFormat, validateResize } from '../validate';

/**
 * Maximum supported canvas dimension per side. Browsers cap canvas sizes
 * (e.g. 16384px per side in Chrome); this guard turns absurd scale
 * factors into a clear error instead of an allocation failure. The WASM
 * wrapper (build-wasm/wrapper/main.cpp) enforces the same per-side cap
 * before allocating decoded pixels — keep the two in sync.
 */
const MAX_CANVAS_DIMENSION = 16384;

/**
 * Cheap probe for canvas support, safe to call before an expensive decode.
 * Throws (unwrapped, with an actionable message) in environments with
 * neither OffscreenCanvas nor HTMLCanvasElement — notably plain Node.js,
 * where encoding is unsupported even though decoding works.
 */
export function assertEncodeEnvironment(): void {
  if (typeof OffscreenCanvas === 'undefined' && typeof document === 'undefined') {
    throw new HeicConverterError('unsupported_environment', Messages.CanvasUnsupported);
  }
}

/**
 * Environment probe: some browsers cannot encode AVIF via canvas (e.g.
 * Safari), and per spec `toBlob` silently falls back to PNG for unknown
 * types — so trusting the requested type would emit a PNG under an AVIF
 * label. Probed once (a 1×1 encode is cheap) and cached; `format_unsupported`
 * is thrown up front when the environment cannot produce AVIF bytes.
 */
let avifSupport: Promise<boolean> | null = null;

/** How long the probe's toBlob may take before the attempt is deemed indeterminate. */
const AVIF_PROBE_TIMEOUT_MS = 5000;

async function runAvifProbe(): Promise<boolean> {
  const probe = createCanvas(1, 1);
  const pending = canvasToBlob(probe, 'image/avif');
  // toBlob callbacks can be starved (backgrounded tabs, memory pressure):
  // race against a deadline so a wedged probe can neither hang every later
  // AVIF conversion nor poison the cache with a false negative.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), AVIF_PROBE_TIMEOUT_MS);
  });
  try {
    const result = await Promise.race([pending, deadline]);
    if (result === 'timeout') {
      // Indeterminate: leave the cache unset so the next call re-probes.
      avifSupport = null;
      return false;
    }
    return result.type === 'image/avif' && result.size > 0;
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    releaseCanvas(probe);
  }
}

export function canEncodeAvif(): Promise<boolean> {
  if (avifSupport === null) {
    avifSupport = runAvifProbe().catch(() => false);
  }
  return avifSupport;
}

/**
 * Up-front capability gate for the chosen output format, safe to call before
 * an expensive decode. `renderAndEncode` keeps a defensive re-check at
 * encode time (worker realms and engines that ignore unknown types).
 */
export async function assertEncodeCapability(format: ImageFormat): Promise<void> {
  validateFormat(format);
  if (String(format).toLowerCase() === 'avif' && !(await canEncodeAvif())) {
    throw new HeicConverterError('format_unsupported', Messages.FormatUnsupported('avif'));
  }
}

/** @internal Reset the cached AVIF capability probe (tests only). */
export function __resetAvifProbe(): void {
  avifSupport = null;
}

/**
 * Computes the target dimensions for the given resize options.
 * `scale` takes precedence over `maxWidth`/`maxHeight`; the latter only
 * downscale (never upscale) while preserving the aspect ratio.
 */
export function computeTargetSize(
  width: number,
  height: number,
  resize?: ResizeOptions
): { width: number; height: number } {
  validateResize(resize);
  if (!resize) {
    return { width, height };
  }

  const { maxWidth, maxHeight, scale } = resize;

  if (scale !== undefined) {
    const targetWidth = Math.max(1, Math.round(width * scale));
    const targetHeight = Math.max(1, Math.round(height * scale));
    validateTargetSize(targetWidth, targetHeight);
    return { width: targetWidth, height: targetHeight };
  }

  if (maxWidth === undefined && maxHeight === undefined) {
    return { width, height };
  }

  const ratio = Math.min(
    maxWidth !== undefined ? maxWidth / width : Number.POSITIVE_INFINITY,
    maxHeight !== undefined ? maxHeight / height : Number.POSITIVE_INFINITY
  );

  if (ratio >= 1) {
    return { width, height };
  }

  // Clamp the constrained dimension so rounding can never exceed the
  // requested bound (relevant for fractional bounds).
  const targetWidth = Math.min(
    Math.max(1, Math.round(width * ratio)),
    maxWidth !== undefined ? Math.floor(maxWidth) : Number.POSITIVE_INFINITY
  );
  const targetHeight = Math.min(
    Math.max(1, Math.round(height * ratio)),
    maxHeight !== undefined ? Math.floor(maxHeight) : Number.POSITIVE_INFINITY
  );

  validateTargetSize(targetWidth, targetHeight);
  return { width: targetWidth, height: targetHeight };
}

/**
 * Validates that computed target dimensions are finite and within the
 * supported canvas bounds.
 */
function validateTargetSize(width: number, height: number): void {
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width > MAX_CANVAS_DIMENSION ||
    height > MAX_CANVAS_DIMENSION
  ) {
    throw new HeicConverterError('invalid_resize', Messages.TargetSizeTooLarge(width, height, MAX_CANVAS_DIMENSION));
  }
}

/**
 * Converts a Blob to a base64 Data URL.
 * Supports both browser (FileReader) and Node.js (btoa) contexts.
 */
export async function blobToBase64(blob: Blob): Promise<string> {
  if (typeof FileReader !== 'undefined') {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        if (typeof reader.result === 'string') {
          resolve(reader.result);
        } else {
          reject(new HeicConverterError('render_encode_failed', Messages.BlobToBase64Failed));
        }
      };
      reader.onerror = () =>
      reject(
        new HeicConverterError(
          'render_encode_failed',
          Messages.BlobToBase64FailedWithCause(reader.error?.message ?? 'FileReader failed'),
          { cause: reader.error ?? undefined }
        )
      );
      reader.readAsDataURL(blob);
    });
  }

  // Node.js fallback if Blob is polyfilled or globally available but FileReader is not
  try {
    const arrayBuffer = await blob.arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);

    // Convert in chunks to avoid "Maximum call stack size exceeded" when
    // spreading large byte arrays (e.g. high-resolution HEIC photos).
    let binary = '';
    const chunkSize = 0x8000; // 32KB
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }

    const base64 = btoa(binary);
    return `data:${blob.type};base64,${base64}`;
  } catch (error) {
    throw new HeicConverterError(
      'render_encode_failed',
      Messages.BlobToBase64FailedWithCause(error instanceof Error ? error.message : String(error)),
      { cause: error }
    );
  }
}

/**
 * Converts a Canvas to a Blob with format-specific options.
 */
export function canvasToBlob(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  type: string,
  quality?: number
): Promise<Blob> {
  if ('convertToBlob' in canvas) {
    // OffscreenCanvas API
    return canvas.convertToBlob({ type, quality });
  }

  // HTMLCanvasElement API
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) {
          resolve(blob);
        } else {
          reject(new HeicConverterError('render_encode_failed', Messages.CanvasToBlobFailed(type)));
        }
      },
      type,
      quality
    );
  });
}

/**
 * Creates a canvas of the given size, preferring OffscreenCanvas.
 */
function createCanvas(width: number, height: number): HTMLCanvasElement | OffscreenCanvas {
  if (typeof OffscreenCanvas !== 'undefined') {
    return new OffscreenCanvas(width, height);
  }
  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }
  throw new HeicConverterError('unsupported_environment', Messages.CanvasUnsupported);
}

/**
 * Releases the backing store of a canvas so its memory can be reclaimed
 * before a long-running encode step.
 */
function releaseCanvas(canvas: HTMLCanvasElement | OffscreenCanvas): void {
  // OffscreenCanvas.close() exists at runtime but is missing from the
  // TypeScript DOM lib, so probe it structurally.
  const closable = canvas as OffscreenCanvas & { close?: () => void };
  if (typeof closable.close === 'function') {
    closable.close();
  } else {
    (canvas as HTMLCanvasElement).width = 0;
  }
}

/**
 * Writes RGBA pixel data onto a canvas context.
 */
function writeImageData(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  data: Uint8ClampedArray,
  width: number,
  height: number
): void {
  if (typeof ImageData !== 'undefined') {
    // TypeScript may complain about ArrayBufferLike vs ArrayBuffer, but at runtime
    // the WASM decoder produces a standard ArrayBuffer-backed Uint8ClampedArray.
    ctx.putImageData(
      new ImageData(data as unknown as Uint8ClampedArray<ArrayBuffer>, width, height),
      0,
      0
    );
  } else {
    // Fallback for environments where ImageData constructor isn't available but ctx.createImageData is
    const created = ctx.createImageData(width, height);
    created.data.set(data);
    ctx.putImageData(created, 0, 0);
  }
}

/**
 * Canvas transform matrices mapping stored `w×h` pixels into their
 * EXIF-orientation display space (orientations 2–8; 5–8 swap the axes).
 * Returns null for orientation 1 (identity). Composed with the resize scale
 * before `setTransform`, so rotation and downscale share one drawImage.
 */
function orientationMatrix(
  orientation: number,
  w: number,
  h: number
): readonly [number, number, number, number, number, number] | null {
  switch (orientation) {
    case 2:
      return [-1, 0, 0, 1, w, 0];
    case 3:
      return [-1, 0, 0, -1, w, h];
    case 4:
      return [1, 0, 0, -1, 0, h];
    case 5:
      return [0, 1, 1, 0, 0, 0];
    case 6:
      return [0, 1, -1, 0, h, 0];
    case 7:
      return [0, -1, -1, 0, h, w];
    case 8:
      return [0, -1, 1, 0, 0, w];
    default:
      return null;
  }
}

/**
 * Normalizes a DecodedImage orientation to a usable EXIF value (1-8).
 * Anything else (absent, injected decoder, garbage) means identity.
 */
function effectiveOrientation(orientation: number | undefined, apply: boolean): number {
  if (!apply || typeof orientation !== 'number' || !Number.isInteger(orientation)) {
    return 1;
  }
  return orientation >= 1 && orientation <= 8 ? orientation : 1;
}

/**
 * Re-inject the source EXIF block into freshly encoded JPEG/PNG bytes when
 * `preserveExif` is on. Fail-safe: returns the original blob when the flag
 * is off, no block was decoded, or the injector refused to modify
 * unparsable output (metadata loss beats a corrupt image, always).
 */
async function withExif(
  blob: Blob,
  decoded: DecodedImage,
  preserveExif: boolean,
  kind: 'jpeg' | 'png',
  normalizeOrientation: boolean
): Promise<Blob> {
  const rawExif = decoded.exif;
  if (!preserveExif || !rawExif || rawExif.length === 0) {
    return blob;
  }
  // EXIF injection is opt-in (default off — metadata can carry GPS), so the
  // JPEG APP1 / PNG eXIf writers and the orientation-tag normalizer are
  // fetched on demand rather than shipped in the render chunk every consumer
  // pays for.
  const { injectExifIntoJpeg, injectExifIntoPng, normalizeOrientationTag } = await import('./exif');
  // The rendered raster is already upright whenever the pending rotation was
  // applied (or none was pending): the orientation tag must then say "normal"
  // or consumers would rotate the image a second time. With
  // `applyOrientation: false` the stored geometry is preserved and the tag
  // legitimately describes it — keep it verbatim.
  const exif = normalizeOrientation ? normalizeOrientationTag(rawExif) : rawExif;
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const injected =
    kind === 'jpeg' ? injectExifIntoJpeg(bytes, exif) : injectExifIntoPng(bytes, exif);
  if (injected === bytes) {
    return blob;
  }
  // `injected` is only distinct from `bytes` when the injector built a fresh
  // whole-buffer Uint8Array, so `.buffer` is its complete payload.
  return new Blob([injected.buffer as ArrayBuffer], { type: blob.type });
}

/**
 * Renders DecodedImage pixel data onto a canvas and encodes it into the target format.
 */
export async function renderAndEncode(
  decoded: DecodedImage,
  format: ImageFormat,
  quality: number,
  resize?: ResizeOptions,
  applyOrientation = true,
  crop?: CropOptions,
  preserveExif = false
): Promise<Blob> {
  // Reject unknown formats before any canvas/pixel work happens.
  validateFormat(format);
  validateCrop(crop);

  const normalizedFormat = format.toLowerCase();
  // AVIF cannot be encoded by every canvas implementation and a failed
  // toBlob() would otherwise silently emit a PNG — probe before pixel work.
  if (normalizedFormat === 'avif' && !(await canEncodeAvif())) {
    throw new HeicConverterError('format_unsupported', Messages.FormatUnsupported('avif'));
  }

  const { width, height, data } = decoded;

  // Dimensions must be positive integers before they are used for buffer
  // sizing, canvas allocation, and SVG serialization.
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw new HeicConverterError('render_encode_failed', Messages.InvalidDimensions(width, height));
  }

  // Validate data length matches expected dimensions
  const expectedLength = width * height * 4;
  if (data.length !== expectedLength) {
    throw new HeicConverterError(
      'render_encode_failed',
      Messages.DataLengthMismatch(expectedLength, width, height, data.length)
    );
  }

  const orientation = effectiveOrientation(decoded.orientation, applyOrientation);
  // Whether the injected EXIF may keep its orientation tag verbatim: only
  // when a pending rotation was NOT applied (applyOrientation:false keeps the
  // stored geometry, which the tag describes). In every other case the
  // output raster is upright and tag 274 must be normalized to 1.
  const pendingRotation =
    decoded.orientation !== undefined && decoded.orientation >= 2 && decoded.orientation <= 8;
  const normalizeExifOrientation = !pendingRotation || applyOrientation;
  const matrix = orientationMatrix(orientation, width, height);
  const swapsAxes = orientation >= 5;
  const displayWidth = swapsAxes ? height : width;
  const displayHeight = swapsAxes ? width : height;

  // Crop operates on the display geometry (what the user sees); the crop
  // region then becomes the input space for resize.
  const cropX = crop?.x ?? 0;
  const cropY = crop?.y ?? 0;
  const regionWidth = crop ? crop.width : displayWidth;
  const regionHeight = crop ? crop.height : displayHeight;
  if (crop && (cropX + regionWidth > displayWidth || cropY + regionHeight > displayHeight)) {
    throw new HeicConverterError(
      'invalid_crop',
      Messages.CropOutOfBounds(cropX, cropY, regionWidth, regionHeight, displayWidth, displayHeight)
    );
  }

  const target = computeTargetSize(regionWidth, regionHeight, resize);
  const needsResize = target.width !== regionWidth || target.height !== regionHeight;
  const needsTransform = matrix !== null || crop !== undefined;

  const canvas = createCanvas(target.width, target.height);
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  if (!ctx) {
    throw new HeicConverterError('render_encode_failed', Messages.ContextUnavailable);
  }

  if (needsTransform || needsResize) {
    // Pixels land on a full-resolution source canvas first; the browser's
    // high-quality resampling (and, when pending, the EXIF orientation and
    // the crop translation) is applied by drawing it through a transform.
    const sourceCanvas = createCanvas(width, height);
    const sourceCtx = sourceCanvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
    if (!sourceCtx) {
      throw new HeicConverterError('render_encode_failed', Messages.ContextUnavailable);
    }
    writeImageData(sourceCtx, data, width, height);
    if (needsTransform) {
      // Compose stored → display (orientation matrix) → crop translate →
      // resize scale in one canvas transform: setTransform maps stored
      // pixel p=(px,py) to (A·px + C·py + E, B·px + D·py + F).
      const sx = target.width / regionWidth;
      const sy = target.height / regionHeight;
      const a = matrix ? matrix[0] : 1;
      const b = matrix ? matrix[1] : 0;
      const c = matrix ? matrix[2] : 0;
      const d = matrix ? matrix[3] : 1;
      const e = matrix ? matrix[4] : 0;
      const f = matrix ? matrix[5] : 0;
      ctx.setTransform(a * sx, b * sy, c * sx, d * sy, sx * (e - cropX), sy * (f - cropY));
      ctx.drawImage(sourceCanvas, 0, 0);
    } else {
      ctx.drawImage(sourceCanvas, 0, 0, target.width, target.height);
    }
    // The full-resolution source canvas is no longer needed; release it
    // before the (potentially slow) encode step to cap peak memory.
    releaseCanvas(sourceCanvas);
  } else {
    writeImageData(ctx, data, width, height);
  }

  if (normalizedFormat === 'png') {
    const blob = await canvasToBlob(canvas, 'image/png');
    releaseCanvas(canvas);
    return withExif(blob, decoded, preserveExif, 'png', normalizeExifOrientation);
  }
  if (normalizedFormat === 'jpeg' || normalizedFormat === 'jpg') {
    const blob = await canvasToBlob(canvas, 'image/jpeg', quality);
    releaseCanvas(canvas);
    return withExif(blob, decoded, preserveExif, 'jpeg', normalizeExifOrientation);
  }
  if (normalizedFormat === 'webp') {
    const blob = await canvasToBlob(canvas, 'image/webp', quality);
    releaseCanvas(canvas);
    return blob;
  }
  if (normalizedFormat === 'avif') {
    // Capability already probed before pixel work.
    const blob = await canvasToBlob(canvas, 'image/avif', quality);
    releaseCanvas(canvas);
    if (blob.type !== 'image/avif') {
      // Defensive: the probe passed but this encode fell back to another
      // type — never label the result AVIF when it is not.
      throw new HeicConverterError('format_unsupported', Messages.FormatUnsupported('avif'));
    }
    return blob;
  }
  if (normalizedFormat === 'svg') {
    // SVG wrapping of the raster image (an <image> element embedding a PNG —
    // note this is a wrapper format, not vector output; PNG is smaller).
    const pngBlob = await canvasToBlob(canvas, 'image/png');
    // The canvas is fully consumed by encode; release its backing store
    // before the base64/SVG assembly, which is the memory-heavy stage.
    releaseCanvas(canvas);
    const base64Url = await blobToBase64(pngBlob);
    const svgPrefix = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${target.width} ${target.height}" width="${target.width}" height="${target.height}">
  <image width="${target.width}" height="${target.height}" href="`;
    const svgSuffix = `" />
</svg>`;
    // Assemble the Blob from parts so the base64 payload is never copied
    // into an intermediate full-size concatenated string.
    return new Blob([svgPrefix, base64Url, svgSuffix], { type: 'image/svg+xml' });
  }
  // Unreachable: validateFormat rejected other formats above.
  throw new HeicConverterError('invalid_format', Messages.UnsupportedFormat(String(format)));
}
