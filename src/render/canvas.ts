import type { DecodedImage, ImageFormat, ResizeOptions } from '../types';
import { SUPPORTED_FORMATS } from '../types';
import { Messages } from '../messages';
import { HeicConverterError } from '../errors';

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
 * Validates resize options. Throws if any value is not a positive finite number.
 */
export function validateResize(resize?: ResizeOptions): void {
  if (!resize) {
    return;
  }
  const { maxWidth, maxHeight, scale } = resize;
  if (scale !== undefined && (typeof scale !== 'number' || !Number.isFinite(scale) || scale <= 0)) {
    throw new HeicConverterError('invalid_resize', Messages.ScaleInvalid(scale));
  }
  if (
    maxWidth !== undefined &&
    (typeof maxWidth !== 'number' || !Number.isFinite(maxWidth) || maxWidth <= 0)
  ) {
    throw new HeicConverterError('invalid_resize', Messages.MaxWidthInvalid(maxWidth));
  }
  if (
    maxHeight !== undefined &&
    (typeof maxHeight !== 'number' || !Number.isFinite(maxHeight) || maxHeight <= 0)
  ) {
    throw new HeicConverterError('invalid_resize', Messages.MaxHeightInvalid(maxHeight));
  }
}

/**
 * Validates that a requested output format is supported (case-insensitive).
 */
export function validateFormat(format: ImageFormat): void {
  const normalized = String(format).toLowerCase();
  if (!(SUPPORTED_FORMATS as readonly string[]).includes(normalized)) {
    throw new HeicConverterError('invalid_format', Messages.UnsupportedFormat(String(format)));
  }
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
      reader.onerror = () => reject(reader.error);
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
 * Renders DecodedImage pixel data onto a canvas and encodes it into the target format.
 */
export async function renderAndEncode(
  decoded: DecodedImage,
  format: ImageFormat,
  quality: number,
  resize?: ResizeOptions,
  applyOrientation = true
): Promise<Blob> {
  // Reject unknown formats before any canvas/pixel work happens.
  validateFormat(format);

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
  const matrix = orientationMatrix(orientation, width, height);
  const swapsAxes = orientation >= 5;
  const displayWidth = swapsAxes ? height : width;
  const displayHeight = swapsAxes ? width : height;

  const target = computeTargetSize(displayWidth, displayHeight, resize);
  const needsResize = target.width !== displayWidth || target.height !== displayHeight;

  const canvas = createCanvas(target.width, target.height);
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  if (!ctx) {
    throw new HeicConverterError('render_encode_failed', Messages.ContextUnavailable);
  }

  if (needsResize || matrix) {
    // Pixels land on a full-resolution source canvas first; the browser's
    // high-quality resampling (and, when pending, the EXIF orientation) is
    // applied by scaling/transforming it into the target canvas.
    const sourceCanvas = createCanvas(width, height);
    const sourceCtx = sourceCanvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
    if (!sourceCtx) {
      throw new HeicConverterError('render_encode_failed', Messages.ContextUnavailable);
    }
    writeImageData(sourceCtx, data, width, height);
    if (matrix) {
      // Compose scale (resize) after the orientation matrix, then draw the
      // source through it with the canvas transform doing the work.
      const sx = target.width / displayWidth;
      const sy = target.height / displayHeight;
      ctx.setTransform(
        matrix[0] * sx,
        matrix[1] * sx,
        matrix[2] * sy,
        matrix[3] * sy,
        matrix[4] * sx,
        matrix[5] * sy
      );
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

  const normalizedFormat = format.toLowerCase();

  if (normalizedFormat === 'png') {
    const blob = await canvasToBlob(canvas, 'image/png');
    releaseCanvas(canvas);
    return blob;
  }
  if (normalizedFormat === 'jpeg' || normalizedFormat === 'jpg') {
    const blob = await canvasToBlob(canvas, 'image/jpeg', quality);
    releaseCanvas(canvas);
    return blob;
  }
  if (normalizedFormat === 'webp') {
    const blob = await canvasToBlob(canvas, 'image/webp', quality);
    releaseCanvas(canvas);
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
