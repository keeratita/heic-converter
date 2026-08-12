import { DecodedImage, ImageFormat } from '../types';

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
          reject(new Error('Failed to convert Blob to base64 string'));
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
      `Failed to convert Blob to base64 string: ${error instanceof Error ? error.message : String(error)}`,
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
          reject(new Error(`Failed to convert canvas to blob (type: ${type})`));
        }
      },
      type,
      quality
    );
  });
}

/**
 * Renders DecodedImage pixel data onto a canvas and encodes it into the target format.
 */
export async function renderAndEncode(
  decoded: DecodedImage,
  format: ImageFormat,
  quality: number
): Promise<Blob> {
  const { width, height, data } = decoded;

  // Dimensions must be positive integers before they are used for buffer
  // sizing, canvas allocation, and SVG serialization.
  if (!Number.isInteger(width) || width <= 0 || !Number.isInteger(height) || height <= 0) {
    throw new Error(
      `Invalid image dimensions: ${width}x${height}. Width and height must be positive integers.`
    );
  }

  // Validate data length matches expected dimensions
  const expectedLength = width * height * 4;
  if (data.length !== expectedLength) {
    throw new Error(
      `Image data length mismatch. Expected ${expectedLength} bytes for ${width}x${height}, got ${data.length}`
    );
  }

  let canvas: HTMLCanvasElement | OffscreenCanvas;
  if (typeof OffscreenCanvas !== 'undefined') {
    canvas = new OffscreenCanvas(width, height);
  } else if (typeof document !== 'undefined') {
    canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
  } else {
    throw new Error(
      'Canvas is not supported in the current environment. ' +
      'Conversion requires a browser environment or canvas polyfills.'
    );
  }

  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  if (!ctx) {
    throw new Error('Failed to acquire 2D rendering context from canvas');
  }

  let imageData: ImageData;
  if (typeof ImageData !== 'undefined') {
    // TypeScript may complain about ArrayBufferLike vs ArrayBuffer, but at runtime
    // the WASM decoder produces a standard ArrayBuffer-backed Uint8ClampedArray.
    imageData = new ImageData(
      data as unknown as Uint8ClampedArray<ArrayBuffer>,
      width,
      height
    );
  } else {
    // Fallback for environments where ImageData constructor isn't available but ctx.createImageData is
    const created = ctx.createImageData(width, height);
    created.data.set(data);
    imageData = created;
  }

  ctx.putImageData(imageData, 0, 0);

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
    const svgString = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">
  <image width="${width}" height="${height}" href="${base64Url}" />
</svg>`;
    return new Blob([svgString], { type: 'image/svg+xml' });
  } else {
    throw new Error(`Unsupported output format: ${format}`);
  }
}
