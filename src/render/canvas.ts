import { DecodedImage, ImageFormat, ResizeOptions } from '../types';
import { Messages } from '../messages';

/**
 * Maximum supported canvas dimension per side. Browsers cap canvas sizes
 * (e.g. 16384px per side in Chrome); this guard turns absurd scale
 * factors into a clear error instead of an allocation failure.
 */
const MAX_CANVAS_DIMENSION = 16384;

/**
 * Validates resize options. Throws if any value is not a positive finite number.
 */
export function validateResize(resize?: ResizeOptions): void {
  if (!resize) {
    return;
  }
  const { maxWidth, maxHeight, scale } = resize;
  if (scale !== undefined && (typeof scale !== 'number' || !Number.isFinite(scale) || scale <= 0)) {
    throw new Error(Messages.ScaleInvalid(scale));
  }
  if (
    maxWidth !== undefined &&
    (typeof maxWidth !== 'number' || !Number.isFinite(maxWidth) || maxWidth <= 0)
  ) {
    throw new Error(Messages.MaxWidthInvalid(maxWidth));
  }
  if (
    maxHeight !== undefined &&
    (typeof maxHeight !== 'number' || !Number.isFinite(maxHeight) || maxHeight <= 0)
  ) {
    throw new Error(Messages.MaxHeightInvalid(maxHeight));
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
    throw new Error(Messages.TargetSizeTooLarge(width, height, MAX_CANVAS_DIMENSION));
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
          reject(new Error(Messages.BlobToBase64Failed));
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
    throw new Error(
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
          reject(new Error(Messages.CanvasToBlobFailed(type)));
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
  throw new Error(Messages.CanvasUnsupported);
}

/**
 * Releases the backing store of a canvas so its memory can be reclaimed
 * before a long-running encode step.
 */
function releaseCanvas(canvas: HTMLCanvasElement | OffscreenCanvas): void {
  if (typeof (canvas as OffscreenCanvas).close === 'function') {
    (canvas as OffscreenCanvas).close();
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
 * Renders DecodedImage pixel data onto a canvas and encodes it into the target format.
 */
export async function renderAndEncode(
  decoded: DecodedImage,
  format: ImageFormat,
  quality: number,
  resize?: ResizeOptions
): Promise<Blob> {
  const { width, height, data } = decoded;

  // Dimensions must be positive integers before they are used for buffer
  // sizing, canvas allocation, and SVG serialization.
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw new Error(Messages.InvalidDimensions(width, height));
  }

  // Validate data length matches expected dimensions
  const expectedLength = width * height * 4;
  if (data.length !== expectedLength) {
    throw new Error(Messages.DataLengthMismatch(expectedLength, width, height, data.length));
  }

  const target = computeTargetSize(width, height, resize);
  const needsResize = target.width !== width || target.height !== height;

  const canvas = createCanvas(target.width, target.height);
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  if (!ctx) {
    throw new Error(Messages.ContextUnavailable);
  }

  if (needsResize) {
    // Draw the full-resolution pixels onto a source canvas, then scale it
    // into the target canvas so the browser's high-quality resampling applies.
    const sourceCanvas = createCanvas(width, height);
    const sourceCtx = sourceCanvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
    if (!sourceCtx) {
      throw new Error(Messages.ContextUnavailable);
    }
    writeImageData(sourceCtx, data, width, height);
    ctx.drawImage(sourceCanvas, 0, 0, target.width, target.height);
    // The full-resolution source canvas is no longer needed; release it
    // before the (potentially slow) encode step to cap peak memory.
    releaseCanvas(sourceCanvas);
  } else {
    writeImageData(ctx, data, width, height);
  }

  const normalizedFormat = format.toLowerCase();

  if (normalizedFormat === 'png') {
    return canvasToBlob(canvas, 'image/png');
  } else if (normalizedFormat === 'jpeg' || normalizedFormat === 'jpg') {
    return canvasToBlob(canvas, 'image/jpeg', quality);
  } else if (normalizedFormat === 'webp') {
    return canvasToBlob(canvas, 'image/webp', quality);
  } else if (normalizedFormat === 'svg') {
    // SVG wrapping of raster image
    const pngBlob = await canvasToBlob(canvas, 'image/png');
    const base64Url = await blobToBase64(pngBlob);
    const svgString = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${target.width} ${target.height}" width="${target.width}" height="${target.height}">
  <image width="${target.width}" height="${target.height}" href="${base64Url}" />
</svg>`;
    return new Blob([svgString], { type: 'image/svg+xml' });
  } else {
    throw new Error(Messages.UnsupportedFormat(format));
  }
}
