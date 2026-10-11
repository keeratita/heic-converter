import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HeicConverterError } from '../../src/errors';
import {
  NativeHeicDecoder,
  __resetNativeHeicProbe,
  getNativeHeicSupport,
  markNativeHeicUnsupported,
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
    expect(getNativeHeicSupport()).toBe(true); // success is the probe verdict

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
    expect(getNativeHeicSupport()).toBeUndefined(); // failure is not a verdict
    expect(bitmaps[0].close).toHaveBeenCalledOnce();
  });

  it('propagates a createImageBitmap refusal before any bitmap exists', async () => {
    createImageBitmapMock = vi.fn(async () => {
      throw new Error('unsupported image type');
    });
    vi.stubGlobal('createImageBitmap', createImageBitmapMock);

    await expect(new NativeHeicDecoder().decode(INPUT)).rejects.toThrow('unsupported image type');
    expect(bitmaps).toHaveLength(0);
    expect(getNativeHeicSupport()).toBeUndefined();
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
    const sab = new SharedArrayBuffer(8);
    const view = new Uint8Array(sab);
    view.set(INPUT);

    await expect(new NativeHeicDecoder().decode(view)).resolves.toMatchObject({ width: 10 });
    expect(createImageBitmapMock.mock.calls[0][0]).toBeInstanceOf(Blob);
  });

  it('free() is a no-op', () => {
    expect(() => new NativeHeicDecoder().free()).not.toThrow();
  });

  it('honours a pre-marked unsupported verdict until reset', () => {
    markNativeHeicUnsupported();
    expect(getNativeHeicSupport()).toBe(false);
    __resetNativeHeicProbe();
    expect(getNativeHeicSupport()).toBeUndefined();
  });
});
