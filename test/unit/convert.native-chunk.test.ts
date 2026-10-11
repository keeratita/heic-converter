import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockState, resetConvertMocks } from './helpers/convert-mocks';

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

// Simulate the deployment failure this suite exists for: the native chunk
// cannot be fetched (partial upload, wrong MIME type), so the dynamic import
// rejects. The conversion must degrade to libheif — typed, transparently,
// and without caching a platform refusal that the deploy has nothing to do
// with. Sequential conversions only: the module mocker mis-resolves racing
// dynamic imports of the same path.
vi.mock('../../src/wasm/native', async () => {
  throw new Error('Failed to fetch dynamically imported module: /dist/native-ABC123.mjs');
});

import { convertHeic } from '../../src/index';

const INPUT = new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70]);

describe('convertHeic - nativeDecode when the native chunk cannot be loaded', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resetConvertMocks();
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  it('degrades to libheif with a one-time warn naming the chunk, not a raw module-load error', async () => {
    await expect(convertHeic(INPUT, { nativeDecode: true })).resolves.toBeInstanceOf(Blob);
    await convertHeic(INPUT, { nativeDecode: true });

    expect(mockState.decoderInstances).toHaveLength(2); // the bundled decoder did the work, both times
    expect(warn).toHaveBeenCalledOnce(); // a deployment problem is named once, not per conversion
    expect(warn.mock.calls[0][0]).toContain('native-*.mjs');
    // The warn also carries the host's original reason; its exact wording is
    // host-dependent, so only the actionable part is asserted here.
    expect(warn.mock.calls[0][0]).toMatch(/could not be loaded/);
  });
});
