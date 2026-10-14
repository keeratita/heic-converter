import { expect, vi } from 'vitest';
import type { DecodedImage } from '../../../src/types';
import type { renderAndEncode } from '../../../src/render/canvas';

/**
 * Shared mock harness for the convert.* unit tests. Vitest isolates modules
 * per test file, so the module-level `mockState` below is fresh for each
 * suite. Test files wire it up like this (the vi.mock factories must use
 * dynamic imports because they are hoisted above static imports):
 *
 * ```ts
 * import { mockState, resetConvertMocks } from './helpers/convert-mocks';
 *
 * vi.mock('../../src/render/canvas', async (importOriginal) => {
 *   const actual = await importOriginal<typeof import('../../src/render/canvas')>();
 *   const { mockState } = await import('./helpers/convert-mocks');
 *   return {
 *     ...actual,
 *     renderAndEncode: mockState.renderAndEncodeMock,
 *     assertEncodeEnvironment: mockState.assertEncodeEnvironmentMock,
 *     assertEncodeCapability: mockState.assertEncodeCapabilityMock,
 *   };
 * });
 *
 * vi.mock('../../src/wasm', async () => {
 *   const { MockLibheifDecoder } = await import('./helpers/convert-mocks');
 *   return { LibheifDecoder: MockLibheifDecoder };
 * });
 * ```
 */

export type DecodeImpl = (
  data: Uint8Array,
  onProgress?: (percent: number) => void,
  /**
   * The mock decoder running this decode. A fault marks the *instance*, so a
   * test that wants to exercise the pool's fault handling needs this handle to
   * pass to the real `markFaulted` registry before throwing.
   */
  self?: MockDecoderInstance
) => Promise<DecodedImage>;

export interface MockDecoderInstance {
  initialize: ReturnType<typeof vi.fn>;
  decode: ReturnType<typeof vi.fn>;
  free: ReturnType<typeof vi.fn>;
}

interface ConvertMockState {
  renderAndEncodeMock: ReturnType<typeof vi.fn>;
  assertEncodeEnvironmentMock: ReturnType<typeof vi.fn>;
  assertEncodeCapabilityMock: ReturnType<typeof vi.fn>;
  defaultDecodedImage: DecodedImage;
  decoderInstances: MockDecoderInstance[];
  decodeImpl: DecodeImpl | null;
  initializeShouldThrow: boolean;
  initializeThrowValue: unknown;
}

const defaultBlob = (): Blob => new Blob(['converted'], { type: 'image/png' });

export const mockState: ConvertMockState = {
  renderAndEncodeMock: vi.fn(async () => defaultBlob()),
  assertEncodeEnvironmentMock: vi.fn(),
  assertEncodeCapabilityMock: vi.fn(),
  defaultDecodedImage: {
    width: 1,
    height: 1,
    data: new Uint8ClampedArray([0, 0, 0, 255]),
  },
  decoderInstances: [],
  decodeImpl: null,
  initializeShouldThrow: false,
  initializeThrowValue: null,
};

/** Mock of LibheifDecoder used by the vi.mock('../../src/wasm') factory. */
export class MockLibheifDecoder {
  initialize = vi.fn(async (): Promise<void> => {
    if (mockState.initializeThrowValue !== null) {
      throw mockState.initializeThrowValue;
    }
    if (mockState.initializeShouldThrow) {
      throw new Error('Init failed');
    }
  });
  decode = vi.fn(async (data: Uint8Array, onProgress?: (percent: number) => void) => {
    if (mockState.decodeImpl) {
      return mockState.decodeImpl(data, onProgress, this as unknown as MockDecoderInstance);
    }
    onProgress?.(100);
    return {
      ...mockState.defaultDecodedImage,
      data: new Uint8ClampedArray(mockState.defaultDecodedImage.data),
    } satisfies DecodedImage;
  });
  free = vi.fn(() => undefined);

  constructor() {
    mockState.decoderInstances.push(this as unknown as MockDecoderInstance);
  }
}

interface NativeMockState {
  refused: boolean;
  instances: MockDecoderInstance[];
  decodeShouldThrow: boolean;
  initializeShouldThrow: boolean;
  /** When set, replaces the mock initialize (abort-timing scenarios). */
  initializeImpl: (() => Promise<void>) | null;
  /** When set, replaces the mock decode entirely (abort/delay scenarios). */
  decodeImpl: (() => Promise<DecodedImage>) | null;
  isRefused: ReturnType<typeof vi.fn>;
  markRefused: ReturnType<typeof vi.fn>;
}

/** State for the vi.mock('../../src/wasm/native') factory; tests pre-seed `refused`. */
export const nativeMockState: NativeMockState = {
  refused: false,
  instances: [],
  decodeShouldThrow: false,
  initializeShouldThrow: false,
  initializeImpl: null,
  decodeImpl: null,
  isRefused: vi.fn(() => nativeMockState.refused),
  markRefused: vi.fn(() => {
    nativeMockState.refused = true;
  }),
};

/** Mock of NativeHeicDecoder used by the vi.mock('../../src/wasm/native') factory. */
export class MockNativeHeicDecoder {
  initialize = vi.fn(async (): Promise<void> => {
    if (nativeMockState.initializeImpl) {
      return nativeMockState.initializeImpl();
    }
    if (nativeMockState.initializeShouldThrow) {
      throw new Error('Native HEIC decoding is unavailable in this environment.');
    }
  });
  decode = vi.fn(async (): Promise<DecodedImage> => {
    if (nativeMockState.decodeImpl) {
      return nativeMockState.decodeImpl();
    }
    if (nativeMockState.decodeShouldThrow) {
      throw new Error('createImageBitmap refused the HEIC');
    }
    return {
      ...mockState.defaultDecodedImage,
      data: new Uint8ClampedArray(mockState.defaultDecodedImage.data),
    } satisfies DecodedImage;
  });
  free = vi.fn(() => undefined);

  constructor() {
    nativeMockState.instances.push(this as unknown as MockDecoderInstance);
  }
}

/**
 * Reset all mock state between tests. Pass `overrides` for suites with
 * custom render/decode behavior (the custom implementation becomes the
 * default for that suite's tests).
 */
export function resetConvertMocks(overrides?: {
  /** Typed as the real signature so a mock that drifts from it fails here. */
  renderAndEncode?: (...args: Parameters<typeof renderAndEncode>) => Promise<Blob>;
  decodeImpl?: DecodeImpl;
  decodedImage?: DecodedImage;
}): void {
  mockState.renderAndEncodeMock.mockReset();
  mockState.renderAndEncodeMock.mockImplementation(overrides?.renderAndEncode ?? (async () => defaultBlob()));
  mockState.assertEncodeEnvironmentMock.mockReset();
  mockState.assertEncodeCapabilityMock.mockReset();
  mockState.decoderInstances.length = 0;
  mockState.decodeImpl = overrides?.decodeImpl ?? null;
  mockState.initializeShouldThrow = false;
  mockState.initializeThrowValue = null;
  nativeMockState.refused = false;
  nativeMockState.instances.length = 0;
  nativeMockState.decodeShouldThrow = false;
  nativeMockState.initializeShouldThrow = false;
  nativeMockState.initializeImpl = null;
  nativeMockState.decodeImpl = null;
  nativeMockState.isRefused.mockClear();
  nativeMockState.markRefused.mockClear();
  if (overrides?.decodedImage) {
    mockState.defaultDecodedImage = overrides.decodedImage;
  }
}

/**
 * The caller's options object doubles as the resize carrier — src/index.ts
 * hands it to renderAndEncode as the 4th argument and `validateResize` reads
 * only maxWidth/maxHeight/scale. When no resize is requested, none of those
 * keys may carry an effective value. Check per key: expect.not.objectContaining
 * only fails when ALL three keys are present, so a single-knob leak slips
 * through it.
 */
export function expectNoEffectiveResize(carrier: unknown): void {
  const carrierObject = (carrier ?? {}) as Record<string, unknown>;
  for (const knob of ['maxWidth', 'maxHeight', 'scale'] as const) {
    expect(carrierObject[knob], `resize carrier must not carry an effective ${knob}`).toBeUndefined();
  }
}
