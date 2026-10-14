import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HeicConverterError } from '../../src/errors';
import { MAX_CANVAS_DIMENSION } from '../../src/render/canvas';
import {
  MAX_NATIVE_DECODE_DIMENSION,
  MAX_NATIVE_DECODE_PIXELS,
  NativeHeicDecoder,
  __resetNativeHeicProbe,
  isNativeHeicRefused,
  markNativeHeicRefused,
} from '../../src/wasm/native';

/**
 * The native Strategy's host APIs (createImageBitmap, OffscreenCanvas) do
 * not exist in Node, so every case stubs them; the convert-level selection/
 * fallback behavior lives in convert.native.test.ts.
 */

interface FakeBitmap {
  width: number;
  height: number;
  close?: ReturnType<typeof vi.fn>;
}

let bitmaps: FakeBitmap[];
let createImageBitmapMock: ReturnType<typeof vi.fn>;
let getContextImpl: () => unknown;

const makeCtx = (rgba: Uint8ClampedArray) => ({
  drawImage: vi.fn(),
  getImageData: vi.fn((_x: number, _y: number, w: number, h: number) => ({
    width: w,
    height: h,
    data: rgba,
  })),
});

const INPUT = new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70]);

beforeEach(() => {
  __resetNativeHeicProbe();
  bitmaps = [];
  getContextImpl = () => makeCtx(new Uint8ClampedArray(10 * 8 * 4));
  createImageBitmapMock = vi.fn(async () => {
    const bitmap: FakeBitmap = { width: 10, height: 8, close: vi.fn() };
    bitmaps.push(bitmap);
    return bitmap;
  });
  vi.stubGlobal('createImageBitmap', createImageBitmapMock);
  vi.stubGlobal(
    'OffscreenCanvas',
    class {
      getContext = vi.fn(() => getContextImpl());
      constructor(
        public width: number,
        public height: number
      ) {}
    }
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('NativeHeicDecoder', () => {
  it('resolves initialize when the host APIs exist', async () => {
    await expect(new NativeHeicDecoder().initialize()).resolves.toBeUndefined();
  });

  it('initialize rejects when createImageBitmap is missing', async () => {
    vi.stubGlobal('createImageBitmap', undefined);
    const error = await new NativeHeicDecoder().initialize().catch((e) => e);
    expect(error).toBeInstanceOf(HeicConverterError);
    expect((error as HeicConverterError).code).toBe('decoder_init_failed');
  });

  it('initialize rejects when OffscreenCanvas is missing', async () => {
    vi.stubGlobal('OffscreenCanvas', undefined);
    const error = await new NativeHeicDecoder().initialize().catch((e) => e);
    expect((error as HeicConverterError).code).toBe('decoder_init_failed');
  });

  it('decodes via bitmap drawImage + getImageData readback', async () => {
    const rgba = new Uint8ClampedArray(10 * 8 * 4).fill(7);
    getContextImpl = () => makeCtx(rgba);

    const decoded = await new NativeHeicDecoder().decode(INPUT);
    expect(decoded).toEqual({ width: 10, height: 8, data: rgba });
    expect(isNativeHeicRefused()).toBe(false); // success does not cache a verdict

    const [blob, options] = createImageBitmapMock.mock.calls[0];
    expect(blob).toBeInstanceOf(Blob);
    expect((blob as Blob).type).toBe('image/heic');
    expect(options).toEqual({ imageOrientation: 'from-image' });
    expect(bitmaps[0].close).toHaveBeenCalledOnce();
  });

  it('passes orientation to the platform so the result is upright', async () => {
    await new NativeHeicDecoder().decode(INPUT);
    expect(createImageBitmapMock.mock.calls[0][1]).toMatchObject({ imageOrientation: 'from-image' });
  });

  it('closes the bitmap even when the 2D context is unavailable', async () => {
    getContextImpl = () => null;
    const error = await new NativeHeicDecoder().decode(INPUT).catch((e) => e);
    expect((error as HeicConverterError).code).toBe('decode_failed');
    expect(isNativeHeicRefused()).toBe(false); // a decode failure is not a realm verdict
    expect(bitmaps[0].close).toHaveBeenCalledOnce();
  });

  // Both cap tests stub a counting OffscreenCanvas + a createImageBitmap that
  // returns the given declared size, then assert no canvas was ever constructed.
  function stubCapProbe(width: number, height: number): { boots: number } {
    const counter = { boots: 0 };
    vi.stubGlobal(
      'OffscreenCanvas',
      class {
        getContext = vi.fn(() => makeCtx(new Uint8ClampedArray(4)));
        constructor(
          public width: number,
          public height: number
        ) {
          counter.boots += 1;
        }
      }
    );
    createImageBitmapMock = vi.fn(async () => {
      const bitmap: FakeBitmap = { width, height, close: vi.fn() };
      bitmaps.push(bitmap);
      return bitmap;
    });
    vi.stubGlobal('createImageBitmap', createImageBitmapMock);
    return counter;
  }

  it('bails on absurd declared dimensions before allocating a canvas', async () => {
    // Container-declared size is attacker-controlled: the canvas + ImageData
    // pair would allocate outside the WASM heap (uncatchable), so the cap
    // must fire before OffscreenCanvas is ever constructed.
    const probe = stubCapProbe(99999, 8);

    const error = await new NativeHeicDecoder().decode(INPUT).catch((e) => e);
    expect((error as HeicConverterError).code).toBe('decode_failed');
    expect((error as Error).message).toContain(`${MAX_NATIVE_DECODE_DIMENSION}px per side`);
    expect(probe.boots).toBe(0); // never allocated
    expect(bitmaps[0].close).toHaveBeenCalledOnce(); // the bitmap itself is released
    expect(isNativeHeicRefused()).toBe(false); // input property, not a realm verdict
  });

  it('bails on absurd declared total pixels before allocating a canvas', async () => {
    // 16384x4097 passes each side check but is 64.02MP: without the total
    // budget the canvas + ImageData pair would allocate ~256 MB outside the
    // WASM heap. Same budget as main.cpp's kMaxDecodePixels.
    const probe = stubCapProbe(16384, 4097);

    const error = await new NativeHeicDecoder().decode(INPUT).catch((e) => e);
    expect((error as HeicConverterError).code).toBe('decode_failed');
    expect((error as Error).message).toContain(
      `${MAX_NATIVE_DECODE_PIXELS / (1024 * 1024)}MP total`
    );
    expect(probe.boots).toBe(0); // never allocated
    expect(bitmaps[0].close).toHaveBeenCalledOnce();
    expect(isNativeHeicRefused()).toBe(false); // input property, not a realm verdict
  });

  it('propagates a createImageBitmap refusal before any bitmap exists', async () => {
    createImageBitmapMock = vi.fn(async () => {
      throw new Error('unsupported image type');
    });
    vi.stubGlobal('createImageBitmap', createImageBitmapMock);

    await expect(new NativeHeicDecoder().decode(INPUT)).rejects.toThrow('unsupported image type');
    expect(bitmaps).toHaveLength(0);
    expect(isNativeHeicRefused()).toBe(false);
  });

  it('tolerates a bitmap without close()', async () => {
    createImageBitmapMock = vi.fn(async () => {
      const bitmap: FakeBitmap = { width: 10, height: 8 }; // no close
      bitmaps.push(bitmap);
      return bitmap;
    });
    vi.stubGlobal('createImageBitmap', createImageBitmapMock);

    await expect(new NativeHeicDecoder().decode(INPUT)).resolves.toMatchObject({ width: 10 });
  });

  it('copies SharedArrayBuffer-backed input before Blob-ing it', async () => {
    // Browser Blob construction rejects SAB-backed parts (DataCloneError);
    // Node's does NOT throw, so reading the bytes back cannot prove the copy —
    // inspect the actual part handed to the Blob constructor instead.
    // A plain function returns the fake blob; `new` keeps the returned object.
    const blobCtor = vi.fn(function (this: unknown, parts: unknown[]) {
      return { __parts: parts };
    });
    vi.stubGlobal('Blob', blobCtor);
    const sab = new SharedArrayBuffer(8);
    const view = new Uint8Array(sab);
    view.set(INPUT);

    await expect(new NativeHeicDecoder().decode(view)).resolves.toMatchObject({ width: 10 });

    expect(blobCtor).toHaveBeenCalledTimes(1);
    const part = blobCtor.mock.calls[0][0][0] as Uint8Array;
    expect(part.buffer, 'the Blob part must be a plain-buffer copy, not the SAB view').not.toBe(sab);
    expect(Array.from(part)).toEqual(Array.from(INPUT));
  });

  it('skips the copy check entirely when the realm lacks SharedArrayBuffer', async () => {
    // Node always has it; browser realms without SAB must not pay an
    // instanceof against an undeclared global.
    vi.stubGlobal('SharedArrayBuffer', undefined);
    await expect(new NativeHeicDecoder().decode(INPUT)).resolves.toMatchObject({ width: 10 });
  });

  it('free() is a no-op', () => {
    expect(() => new NativeHeicDecoder().free()).not.toThrow();
  });

  it('keeps the decode caps in sync with the canvas and C++ caps', () => {
    // native.ts copies the numbers to stay out of the render module graph
    // (lazy-chunk purity); these are the sync gates for both duplications.
    expect(MAX_NATIVE_DECODE_DIMENSION).toBe(MAX_CANVAS_DIMENSION);

    const cpp = readFileSync(
      new URL('../../build-wasm/wrapper/main.cpp', import.meta.url),
      'utf8'
    );
    const pixels = cpp.match(/kMaxDecodePixels\s*=\s*(\d+)ULL\s*\*\s*1024\s*\*\s*1024/);
    expect(pixels, 'kMaxDecodePixels literal shape changed in main.cpp').not.toBeNull();
    expect(Number(pixels![1]) * 1024 * 1024).toBe(MAX_NATIVE_DECODE_PIXELS);
    const dimension = cpp.match(/kMaxDecodeDimension\s*=\s*(\d+)/);
    expect(dimension, 'kMaxDecodeDimension literal shape changed in main.cpp').not.toBeNull();
    expect(Number(dimension![1])).toBe(MAX_NATIVE_DECODE_DIMENSION);
  });

  it('refuses the realm only on mark, warns once, and clears on reset', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(isNativeHeicRefused()).toBe(false);
      markNativeHeicRefused();
      markNativeHeicRefused(); // second mark (later conversions) must not repeat the breadcrumb
      expect(isNativeHeicRefused()).toBe(true);
      expect(warn).toHaveBeenCalledOnce();
      expect(warn.mock.calls[0][0]).toContain('native HEIC decoding is unavailable');

      __resetNativeHeicProbe();
      expect(isNativeHeicRefused()).toBe(false);
      markNativeHeicRefused(); // fresh realm after reset warns again
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      warn.mockRestore();
    }
  });
});
