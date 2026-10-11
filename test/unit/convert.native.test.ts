import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HeicConverterError } from '../../src/errors';
import { mockState, nativeMockState, resetConvertMocks } from './helpers/convert-mocks';

vi.mock('../../src/render/canvas', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/render/canvas')>();
  const { mockState } = await import('./helpers/convert-mocks');
  return {
    ...actual,
    renderAndEncode: mockState.renderAndEncodeMock,
    assertEncodeEnvironment: mockState.assertEncodeEnvironmentMock,
    assertEncodeCapability: mockState.assertEncodeCapabilityMock,
  };
});

vi.mock('../../src/wasm', async () => {
  const { MockLibheifDecoder } = await import('./helpers/convert-mocks');
  return { LibheifDecoder: MockLibheifDecoder };
});

// Mock the dynamically imported chunk: Strategy class + capability cache.
vi.mock('../../src/wasm/native', async () => {
  const h = await import('./helpers/convert-mocks');
  return {
    NativeHeicDecoder: h.MockNativeHeicDecoder,
    getNativeHeicSupport: h.nativeMockState.getSupport,
    markNativeHeicSupported: h.nativeMockState.markSupported,
    markNativeHeicUnsupported: h.nativeMockState.markUnsupported,
    __resetNativeHeicProbe: vi.fn(),
  };
});

import { convertHeic, convertMany } from '../../src/index';

const INPUT = new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70]);

describe('convertHeic - native decode strategy', () => {
  beforeEach(() => {
    resetConvertMocks();
  });

  it('decodes via the native strategy when opted in and capable', async () => {
    await expect(convertHeic(INPUT, { nativeDecode: true })).resolves.toBeInstanceOf(Blob);
    expect(nativeMockState.instances).toHaveLength(1);
    expect(nativeMockState.instances[0].initialize).toHaveBeenCalledOnce();
    expect(nativeMockState.instances[0].free).toHaveBeenCalledOnce();
    // libheif was never paid for.
    expect(mockState.decoderInstances).toHaveLength(0);
  });

  it('falls back to libheif when the native decode fails, and caches the refusal', async () => {
    nativeMockState.decodeShouldThrow = true;

    await expect(convertHeic(INPUT, { nativeDecode: true })).resolves.toBeInstanceOf(Blob);
    expect(nativeMockState.markUnsupported).toHaveBeenCalledOnce();
    expect(mockState.decoderInstances).toHaveLength(1); // libheif did the work
    expect(mockState.decoderInstances[0].decode).toHaveBeenCalledOnce();
  });

  it('falls back to libheif when the native decoder cannot initialize', async () => {
    nativeMockState.initializeShouldThrow = true;

    await expect(convertHeic(INPUT, { nativeDecode: true })).resolves.toBeInstanceOf(Blob);
    expect(nativeMockState.markUnsupported).toHaveBeenCalledOnce();
    expect(mockState.decoderInstances).toHaveLength(1);
  });

  it('skips the native attempt entirely once the realm is marked unsupported', async () => {
    nativeMockState.support = false;

    await expect(convertHeic(INPUT, { nativeDecode: true })).resolves.toBeInstanceOf(Blob);
    expect(nativeMockState.instances).toHaveLength(0);
    expect(mockState.decoderInstances).toHaveLength(1);
  });

  it('surfaces the libheif error when the fallback decode fails too', async () => {
    nativeMockState.decodeShouldThrow = true;
    mockState.decodeImpl = async () => {
      throw new HeicConverterError('decode_failed', 'libheif refused this file');
    };

    const error = await convertHeic(INPUT, { nativeDecode: true }).catch((e) => e);
    expect(error).toBeInstanceOf(HeicConverterError);
    expect((error as HeicConverterError).code).toBe('decode_failed');
    expect((error as Error).message).toContain('libheif refused this file');
  });

  it.each([
    ['preserveExif (native yields no Exif item)', { preserveExif: true }],
    ['applyOrientation: false (native cannot report stored geometry)', { applyOrientation: false }],
  ])('pins the libheif path for %s even when opted in', async (_label, options) => {
    await expect(convertHeic(INPUT, { nativeDecode: true, ...options })).resolves.toBeInstanceOf(Blob);
    // Policy short-circuits before the capability chunk.
    expect(nativeMockState.getSupport).not.toHaveBeenCalled();
    expect(nativeMockState.instances).toHaveLength(0);
    expect(mockState.decoderInstances).toHaveLength(1);
  });

  it('lets an injected decoder win over nativeDecode', async () => {
    const injected = {
      initialize: vi.fn(async () => undefined),
      decode: vi.fn(async () => ({ width: 1, height: 1, data: new Uint8ClampedArray([0, 0, 0, 255]) })),
      free: vi.fn(),
    };

    await convertHeic(INPUT, { nativeDecode: true, decoder: injected });
    expect(injected.decode).toHaveBeenCalledOnce();
    expect(nativeMockState.instances).toHaveLength(0);
    expect(mockState.decoderInstances).toHaveLength(0);
    expect(injected.free).not.toHaveBeenCalled(); // never free an injected decoder
  });

  it('never touches the native chunk when the flag is off', async () => {
    await convertHeic(INPUT);
    await convertHeic(INPUT, { nativeDecode: false });
    expect(nativeMockState.getSupport).not.toHaveBeenCalled();
    expect(nativeMockState.instances).toHaveLength(0);
    expect(mockState.decoderInstances).toHaveLength(2);
  });

  it('rejects a non-boolean nativeDecode with invalid_input', async () => {
    const error = await convertHeic(INPUT, { nativeDecode: 'yes' as unknown as boolean }).catch((e) => e);
    expect(error).toBeInstanceOf(HeicConverterError);
    expect((error as HeicConverterError).code).toBe('invalid_input');
    expect((error as Error).message).toContain('nativeDecode must be a boolean');
  });

  it('bypasses the reuseDecoders pool so nativeDecode is not silently defeated', async () => {
    // If the pool captured native batches, libheif would decode despite the opt-in.
    // concurrency: 1 because the module mocker mis-resolves concurrent dynamic
    // imports of the same path (runner concurrency is covered in convert.many).
    await expect(
      convertMany([new Uint8Array([1]), new Uint8Array([2])], {
        reuseDecoders: true,
        nativeDecode: true,
        concurrency: 1,
      })
    ).resolves.toHaveLength(2);
    expect(nativeMockState.instances).toHaveLength(2); // one Strategy per item
    expect(mockState.decoderInstances).toHaveLength(0); // pool never leased
  });

  it('frees the native decoder after decode and again on failure paths', async () => {
    nativeMockState.decodeShouldThrow = true;
    mockState.decodeImpl = async () => {
      throw new HeicConverterError('decode_failed', 'both failed');
    };

    await convertHeic(INPUT, { nativeDecode: true }).catch(() => undefined);
    expect(nativeMockState.instances).toHaveLength(1);
    // Freed before the fallback is constructed; finally is idempotent.
    expect(nativeMockState.instances[0].free).toHaveBeenCalled();
    expect(mockState.decoderInstances).toHaveLength(1);
    expect(mockState.decoderInstances[0].free).toHaveBeenCalled(); // fallback freed too
  });
});
