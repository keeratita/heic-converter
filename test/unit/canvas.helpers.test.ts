import { describe, it, expect, afterEach, vi } from 'vitest';
import { assertEncodeEnvironment, blobToBase64, canvasToBlob } from '../../src/render/canvas';

describe('blobToBase64', () => {
  it('converts a Blob to a base64 data URL', async () => {
    const blob = new Blob(['hello world'], { type: 'text/plain' });

    const result = await blobToBase64(blob);
    expect(result).toBe('data:text/plain;base64,aGVsbG8gd29ybGQ=');
  });

  it('encodes bytes supplied via arrayBuffer()', async () => {
    const blob = new Blob(['test'], { type: 'image/png' });

    // Mock arrayBuffer to return known bytes
    const mockArrayBuffer = new ArrayBuffer(4);
    const view = new Uint8Array(mockArrayBuffer);
    view.set([116, 101, 115, 116]); // "test"
    blob.arrayBuffer = async () => mockArrayBuffer;

    const result = await blobToBase64(blob);
    expect(result).toMatch(/^data:image\/png;base64,/);
    expect(result).toContain('dGVzdA=='); // base64 of "test"
  });

  it('rejects with render_encode_failed and the cause when the blob cannot be read', async () => {
    const blob = new Blob(['test'], { type: 'image/png' });
    const boom = new Error('blob read failed');
    blob.arrayBuffer = () => Promise.reject(boom);

    const error = await blobToBase64(blob).catch((e) => e);
    expect(error.code).toBe('render_encode_failed');
    expect(error.message).toContain('blob read failed');
    expect(error.cause).toBe(boom);
  });

  it('wraps a non-Error rejection reason via its string form', async () => {
    const blob = new Blob(['test'], { type: 'image/png' });
    blob.arrayBuffer = () => Promise.reject('boom');

    await expect(blobToBase64(blob)).rejects.toThrow(
      'Failed to convert Blob to base64 string: boom'
    );
  });

  it('handles an empty Blob', async () => {
    const blob = new Blob([], { type: 'application/octet-stream' });
    blob.arrayBuffer = async () => new ArrayBuffer(0);

    const result = await blobToBase64(blob);
    expect(result).toBe('data:application/octet-stream;base64,');
  });

  it('handles binary data', async () => {
    const bytes = new Uint8Array([0, 255, 128, 64]);
    const blob = new Blob([bytes], { type: 'application/octet-stream' });

    const result = await blobToBase64(blob);
    expect(result).toMatch(/^data:application\/octet-stream;base64,/);
  });

  it('handles large binary data without stack overflow', async () => {
    const size = 1024 * 1024; // 1MB
    const bytes = new Uint8Array(size);
    for (let i = 0; i < size; i++) {
      bytes[i] = i % 256;
    }
    const blob = new Blob([bytes], { type: 'application/octet-stream' });

    const result = await blobToBase64(blob);
    expect(result).toMatch(/^data:application\/octet-stream;base64,/);

    // Verify the chunked encoding round-trips to the exact original bytes.
    const base64 = result.split(',')[1];
    const decoded = Buffer.from(base64, 'base64');
    expect(decoded.length).toBe(size);
    expect(Array.from(decoded)).toEqual(Array.from(bytes));
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

describe('assertEncodeEnvironment', () => {
  const defined = {
    OffscreenCanvas: Object.getOwnPropertyDescriptor(globalThis, 'OffscreenCanvas'),
    document: Object.getOwnPropertyDescriptor(globalThis, 'document'),
  };

  function setGlobal(name: 'OffscreenCanvas' | 'document', value: unknown): void {
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  }

  afterEach(() => {
    for (const name of ['OffscreenCanvas', 'document'] as const) {
      if (defined[name]) {
        Object.defineProperty(globalThis, name, defined[name]!);
      } else {
        delete (globalThis as Record<string, unknown>)[name];
      }
    }
  });

  it('does not throw when OffscreenCanvas exists', () => {
    setGlobal('OffscreenCanvas', class {});
    setGlobal('document', undefined);
    expect(() => assertEncodeEnvironment()).not.toThrow();
  });

  it('does not throw when only document exists', () => {
    setGlobal('OffscreenCanvas', undefined);
    setGlobal('document', {});
    expect(() => assertEncodeEnvironment()).not.toThrow();
  });

  it('throws unsupported_environment when neither exists', () => {
    setGlobal('OffscreenCanvas', undefined);
    setGlobal('document', undefined);
    const error = (() => {
      try {
        assertEncodeEnvironment();
        return null;
      } catch (e) {
        return e as Error & { code: string };
      }
    })();
    expect(error).not.toBeNull();
    expect(error!.code).toBe('unsupported_environment');
    expect(error!.message).toContain('Canvas is not supported');
  });
});
