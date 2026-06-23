import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { blobToBase64, canvasToBlob } from '../../src/render/canvas';

describe('blobToBase64', () => {
  let originalFileReader: typeof FileReader;

  beforeEach(() => {
    originalFileReader = global.FileReader;
  });

  afterEach(() => {
    global.FileReader = originalFileReader;
  });

  it('should convert a Blob to a base64 data URL using FileReader', async () => {
    const blob = new Blob(['hello world'], { type: 'text/plain' });

    class MockFileReader {
      result: string | null = null;
      onloadend: (() => void) | null = null;
      onerror: (() => void) | null = null;

      readAsDataURL(): void {
        setTimeout(() => {
          this.result = 'data:text/plain;base64,SGVsbG8gV29ybGQ=';
          this.onloadend?.();
        }, 0);
      }
    }

    global.FileReader = MockFileReader as unknown as typeof FileReader;

    const result = await blobToBase64(blob);
    expect(result).toBe('data:text/plain;base64,SGVsbG8gV29ybGQ=');
  });

  it('should use btoa fallback when FileReader is unavailable', async () => {
    const blob = new Blob(['test'], { type: 'image/png' });

    // Mock arrayBuffer to return known bytes
    const mockArrayBuffer = new ArrayBuffer(4);
    const view = new Uint8Array(mockArrayBuffer);
    view.set([116, 101, 115, 116]); // "test"
    blob.arrayBuffer = async () => mockArrayBuffer;

    global.FileReader = undefined as unknown as typeof FileReader;

    const result = await blobToBase64(blob);
    expect(result).toMatch(/^data:image\/png;base64,/);
    expect(result).toContain('dGVzdA=='); // base64 of "test"
  });

  it('should reject when FileReader result is not a string', async () => {
    const blob = new Blob(['test'], { type: 'image/png' });

    class MockFileReaderError {
      result: unknown = null;
      onloadend: (() => void) | null = null;
      onerror: (() => void) | null = null;

      readAsDataURL(): void {
        setTimeout(() => {
          this.onloadend?.();
        }, 0);
      }
    }

    global.FileReader = MockFileReaderError as unknown as typeof FileReader;

    await expect(blobToBase64(blob)).rejects.toThrow(
      'Failed to convert Blob to base64 string'
    );
  });

  it('should reject when FileReader encounters an error', async () => {
    const blob = new Blob(['test'], { type: 'image/png' });

    class MockFileReaderOnError {
      result: string | null = null;
      onloadend: (() => void) | null = null;
      onerror: (() => void) | null = null;
      error: Error = new Error('FileReader error');

      readAsDataURL(): void {
        setTimeout(() => {
          this.onerror?.();
        }, 0);
      }
    }

    global.FileReader = MockFileReaderOnError as unknown as typeof FileReader;

    await expect(blobToBase64(blob)).rejects.toThrow('FileReader error');
  });

  it('should handle empty Blob in btoa fallback', async () => {
    const blob = new Blob([], { type: 'application/octet-stream' });
    blob.arrayBuffer = async () => new ArrayBuffer(0);

    global.FileReader = undefined as unknown as typeof FileReader;

    const result = await blobToBase64(blob);
    expect(result).toBe('data:application/octet-stream;base64,');
  });

  it('should handle binary data in btoa fallback', async () => {
    const bytes = new Uint8Array([0, 255, 128, 64]);
    const blob = new Blob([bytes], { type: 'application/octet-stream' });

    global.FileReader = undefined as unknown as typeof FileReader;

    const result = await blobToBase64(blob);
    expect(result).toMatch(/^data:application\/octet-stream;base64,/);
  });
});

describe('canvasToBlob', () => {
  describe('HTMLCanvasElement', () => {
    it('should convert HTMLCanvasElement to Blob using toBlob', async () => {
      const mockBlob = new Blob(['jpeg-data'], { type: 'image/jpeg' });

      const mockCanvas = {
        toBlob: (callback: (blob: Blob | null) => void) => {
          callback(mockBlob);
        },
      } as unknown as HTMLCanvasElement;

      const result = await canvasToBlob(mockCanvas, 'image/jpeg', 0.92);
      expect(result).toBe(mockBlob);
    });

    it('should reject when toBlob returns null', async () => {
      const mockCanvas = {
        toBlob: (callback: (blob: Blob | null) => void) => {
          callback(null);
        },
      } as unknown as HTMLCanvasElement;

      await expect(canvasToBlob(mockCanvas, 'image/jpeg', 0.92))
        .rejects.toThrow('Failed to convert canvas to blob');
    });

    it('should pass quality parameter to toBlob', async () => {
      let capturedQuality: number | undefined;
      const mockBlob = new Blob(['data'], { type: 'image/jpeg' });

      const mockCanvas = {
        toBlob: (callback: (blob: Blob | null) => void, type: string, quality?: number) => {
          capturedQuality = quality;
          callback(mockBlob);
        },
      } as unknown as HTMLCanvasElement;

      await canvasToBlob(mockCanvas, 'image/jpeg', 0.5);
      expect(capturedQuality).toBe(0.5);
    });
  });

  describe('OffscreenCanvas', () => {
    it('should use convertToBlob when available', async () => {
      const mockBlob = new Blob(['webp-data'], { type: 'image/webp' });

      const mockOffscreenCanvas = {
        convertToBlob: vi.fn().mockResolvedValue(mockBlob),
      } as unknown as OffscreenCanvas;

      const result = await canvasToBlob(mockOffscreenCanvas, 'image/webp', 0.9);
      expect(result).toBe(mockBlob);
      expect((mockOffscreenCanvas as any).convertToBlob).toHaveBeenCalledWith({
        type: 'image/webp',
        quality: 0.9,
      });
    });
  });
});
