import { vi } from 'vitest';
import type { DecodedImage } from '../../../src/types';

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
  onProgress?: (percent: number) => void
) => Promise<DecodedImage>;

export interface MockDecoderInstance {
  initialize: ReturnType<typeof vi.fn>;
  decode: ReturnType<typeof vi.fn>;
  free: ReturnType<typeof vi.fn>;
}

interface ConvertMockState {
  renderAndEncodeMock: ReturnType<typeof vi.fn>;
  assertEncodeEnvironmentMock: ReturnType<typeof vi.fn>;
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
      return mockState.decodeImpl(data, onProgress);
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

/**
 * Reset all mock state between tests. Pass `overrides` for suites with
 * custom render/decode behavior (the custom implementation becomes the
 * default for that suite's tests).
 */
export function resetConvertMocks(overrides?: {
  renderAndEncode?: (...args: unknown[]) => Promise<Blob>;
  decodeImpl?: DecodeImpl;
  decodedImage?: DecodedImage;
}): void {
  mockState.renderAndEncodeMock.mockReset();
  mockState.renderAndEncodeMock.mockImplementation(overrides?.renderAndEncode ?? (async () => defaultBlob()));
  mockState.assertEncodeEnvironmentMock.mockReset();
  mockState.decoderInstances.length = 0;
  mockState.decodeImpl = overrides?.decodeImpl ?? null;
  mockState.initializeShouldThrow = false;
  mockState.initializeThrowValue = null;
  if (overrides?.decodedImage) {
    mockState.defaultDecodedImage = overrides.decodedImage;
  }
}
