import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HeicConverterError } from '../../src/errors';
// Real module on purpose: `vi.mock('../../src/wasm')` mocks the barrel, and the
// pool's fault handling is only meaningful against the actual registry.
import { markFaulted } from '../../src/wasm/fault';
import { mockState, resetConvertMocks, type DecodeImpl } from './helpers/convert-mocks';

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

import { convertMany } from '../../src/index';

// Input 1 is slow so conversions finish out of order; inputs 8 and 9 fail
// fast (with distinct messages) so failures win the race; inputs 5, 6, 7 and
// 18 fail synchronously (before the delay) so multi-failure counting and the
// other-errors cap are deterministic.
const active = { count: 0, max: 0 };
let rejectWithNull = false;

const batchDecodeImpl: DecodeImpl = async (data, onProgress) => {
  const value = data[0];
  if (value === 7 || value === 6 || value === 5 || value === 18) {
    throw new Error(`decode failed for input ${value}`);
  }
  if (rejectWithNull) {
    throw null;
  }
  active.count += 1;
  active.max = Math.max(active.max, active.count);
  const delay = value === 1 ? 50 : value === 8 || value === 9 ? 5 : 10;
  await new Promise((resolve) => setTimeout(resolve, delay));
  active.count -= 1;
  if (value === 8) {
    throw new Error('decode failed for input 8');
  }
  if (value === 9) {
    throw new Error('decode failed for input 9');
  }
  onProgress?.(100);
  return {
    width: 1,
    height: 1,
    data: new Uint8ClampedArray([value ?? 0, 0, 0, 255]),
  };
};

const renderFromPixel = async (decoded: { data: Uint8ClampedArray }): Promise<Blob> =>
  new Blob([String(decoded.data[0])], { type: 'image/png' });

describe('convertMany', () => {
  beforeEach(() => {
    resetConvertMocks({ renderAndEncode: renderFromPixel, decodeImpl: batchDecodeImpl });
    rejectWithNull = false;
    active.count = 0;
    active.max = 0;
  });

  it('should convert all inputs and return results in input order', async () => {
    const inputs = [new Uint8Array([1]), new Uint8Array([2]), new Uint8Array([3])];

    const results = await convertMany(inputs);

    expect(results).toHaveLength(3);
    for (const result of results) {
      expect(result).toBeInstanceOf(Blob);
    }
    expect(mockState.decoderInstances).toHaveLength(3);
  });

  it('should return results in input order even when conversions finish out of order', async () => {
    const inputs = [new Uint8Array([1]), new Uint8Array([2]), new Uint8Array([3])];

    const results = await convertMany(inputs, { concurrency: 2 });

    const contents = await Promise.all(results.map((result) => result.text()));
    expect(contents).toEqual(['1', '2', '3']);
  });

  it('should respect the concurrency limit', async () => {
    const inputs = Array.from({ length: 5 }, (_, i) => new Uint8Array([i]));

    await convertMany(inputs, { concurrency: 2 });

    expect(active.max).toBe(2);
    expect(mockState.decoderInstances).toHaveLength(5);
  });

  it('should default to concurrency of 4', async () => {
    // Values 10..17: avoids the 7/8/9 failure sentinels and the 1 slow value.
    const inputs = Array.from({ length: 8 }, (_, i) => new Uint8Array([i + 10]));

    await convertMany(inputs);

    expect(active.max).toBe(4);
  });

  it('should run sequentially with concurrency of 1', async () => {
    const inputs = Array.from({ length: 3 }, (_, i) => new Uint8Array([i]));

    await convertMany(inputs, { concurrency: 1 });

    expect(active.max).toBe(1);
  });

  it('should run all conversions at once when concurrency exceeds the input count', async () => {
    const inputs = Array.from({ length: 3 }, (_, i) => new Uint8Array([i]));

    await convertMany(inputs, { concurrency: 10 });

    expect(active.max).toBe(3);
  });

  it('should convert a single input', async () => {
    // Value 42: any byte value works as long as it is not a failure sentinel.
    const results = await convertMany([new Uint8Array([42])]);

    expect(results).toHaveLength(1);
    expect(await results[0].text()).toBe('42');
  });

  it('should not leak batch-only options into per-item conversion options', async () => {
    // `concurrency` is a batch knob and must not disturb per-item option
    // forwarding: item options still reach the encoder untouched.
    await convertMany([new Uint8Array([1])], { concurrency: 3, to: 'png', quality: 0.4 });

    expect(mockState.renderAndEncodeMock).toHaveBeenCalledWith(expect.any(Object), 'png', 0.4,
        undefined,
        true,
        undefined,
      false);
    expect(mockState.decoderInstances).toHaveLength(1);
  });

  it('should reuse one injected decoder across items and never free it', async () => {
    const injected = {
      initialize: vi.fn(async () => undefined),
      decode: vi.fn(async (data: Uint8Array) => ({
        width: 1,
        height: 1,
        data: new Uint8ClampedArray([data[0], 0, 0, 255]),
      })),
      free: vi.fn(),
    };

    const results = await convertMany([new Uint8Array([1]), new Uint8Array([2])], {
      decoder: injected,
      concurrency: 1,
    });

    expect(results).toHaveLength(2);
    expect(injected.initialize).toHaveBeenCalledTimes(2);
    expect(injected.decode).toHaveBeenCalledTimes(2);
    // The library never frees a user-injected decoder.
    expect(injected.free).not.toHaveBeenCalled();
    // And no default decoders were created.
    expect(mockState.decoderInstances).toHaveLength(0);
  });

  it('should pass through format and quality options', async () => {
    await convertMany([new Uint8Array([1])], { to: 'png', quality: 0.5 });

    expect(mockState.renderAndEncodeMock).toHaveBeenCalledWith(
      expect.any(Object),
      'png',
      0.5,
        undefined,
        true,
        undefined,
      false);
  });

  it('should pass through resize options', async () => {
    await convertMany([new Uint8Array([1])], { scale: 0.5 });

    expect(mockState.renderAndEncodeMock).toHaveBeenCalledWith(
      expect.any(Object),
      'jpeg',
      0.92,
      expect.objectContaining({ scale: 0.5 }),
      true,
      undefined,
    false);
  });

  it('should forward per-item progress with the item index', async () => {
    const onProgress = vi.fn();

    await convertMany([new Uint8Array([1]), new Uint8Array([2])], { onProgress });

    expect(onProgress).toHaveBeenCalledWith(0, 100);
    expect(onProgress).toHaveBeenCalledWith(1, 100);
  });

  it('should only report progress for successful items', async () => {
    const onProgress = vi.fn();

    await expect(
      convertMany([new Uint8Array([9]), new Uint8Array([2])], { onProgress })
    ).rejects.toThrow('decode failed for input 9');

    expect(onProgress).not.toHaveBeenCalledWith(0, 100);
    // The in-flight item finishes after the rejection; wait for its progress.
    await vi.waitFor(() => expect(onProgress).toHaveBeenCalledWith(1, 100));
  });

  it('should reject with the failing item index and the first error', async () => {
    const inputs = [new Uint8Array([1]), new Uint8Array([9]), new Uint8Array([3])];

    await expect(convertMany(inputs)).rejects.toThrow(
      'Conversion of item 2 of 3 failed: decode failed for input 9'
    );
  });

  it('should carry structured batch failure fields', async () => {
    const inputs = [new Uint8Array([1]), new Uint8Array([9]), new Uint8Array([3])];

    const error = await convertMany(inputs).catch((e) => e);
    expect(error.code).toBe('batch_item_failed');
    expect(error.itemIndex).toBe(1); // 0-based index of the failing item
    expect(error.itemTotal).toBe(3);
    expect(error.failedCount).toBe(1);
    expect(error.cause).toBeInstanceOf(Error);
    expect((error.cause as Error).message).toContain('decode failed for input 9');
  });

  it('should report the first failure in time, not the lowest index', async () => {
    // Item 1 (index 1) fails fast while item 0 is still decoding slowly.
    const inputs = [new Uint8Array([1]), new Uint8Array([8]), new Uint8Array([9])];

    await expect(convertMany(inputs, { concurrency: 2 })).rejects.toThrow(
      'Conversion of item 2 of 3 failed: decode failed for input 8'
    );
  });

  it('should reject with the first error when all conversions fail', async () => {
    const inputs = [new Uint8Array([9]), new Uint8Array([9])];

    await expect(convertMany(inputs)).rejects.toThrow(
      'Conversion of item 1 of 2 failed: decode failed for input 9'
    );
  });

  it('should summarize multiple failures in the message', async () => {
    // Value 7 fails synchronously, so both failures are recorded before the
    // race rejection continues and the summary is deterministic.
    const inputs = [new Uint8Array([7]), new Uint8Array([7])];

    const error = await convertMany(inputs, { concurrency: 2 }).catch((e) => e);
    expect(error.failedCount).toBe(2);
    expect(error.message).toContain('(2 of 2 items failed in total)');
    expect(error.message).toContain('other errors:');
  });

  it('should cap the other-errors list at two extra messages', async () => {
    // All four items fail synchronously: item 0 (value 7) is the first
    // failure; values 6 and 5 fill the other-errors list; value 18 must be
    // dropped so the message stays bounded.
    const inputs = [7, 6, 5, 18].map((v) => new Uint8Array([v]));

    const error = await convertMany(inputs, { concurrency: 4 }).catch((e) => e);
    expect(error.code).toBe('batch_item_failed');
    expect(error.itemIndex).toBe(0);
    expect(error.itemTotal).toBe(4);
    expect(error.failedCount).toBe(4);
    expect(error.message).toContain('(4 of 4 items failed in total)');
    expect(error.message).toContain(
      'other errors: decode failed for input 6 | decode failed for input 5'
    );
    expect(error.message).not.toContain('input 18');
  });

  it('should stringify non-Error rejections in the other-errors list', async () => {
    // Second failure rejects with a non-Error value; the summary must
    // stringify it instead of dropping it.
    rejectWithNull = true;
    const inputs = [new Uint8Array([7]), new Uint8Array([2])];

    const error = await convertMany(inputs, { concurrency: 2 }).catch((e) => e);
    expect(error.failedCount).toBe(2);
    expect(error.message).toContain('other errors: null');
  });

  it('should free decoders of in-flight items after an early batch rejection', async () => {
    // Item 0 fails fast; item 1 keeps decoding. After the batch rejects, the
    // in-flight conversion must still release its own decoder.
    const inputs = [new Uint8Array([9]), new Uint8Array([1])]; // value 1 = slow

    await expect(convertMany(inputs, { concurrency: 2 })).rejects.toThrow(
      'decode failed for input 9'
    );

    await vi.waitFor(() => {
      expect(mockState.decoderInstances).toHaveLength(2);
      mockState.decoderInstances.forEach((decoder) => {
        // Failed item's decoder is freed via finally; the in-flight item's
        // decoder is freed once its background conversion completes.
        expect(decoder.free).toHaveBeenCalledTimes(1);
      });
    });
  });

  it('should wrap a null rejection with the item index', async () => {
    rejectWithNull = true;

    await expect(convertMany([new Uint8Array([1])])).rejects.toThrow(
      'Conversion of item 1 of 1 failed: null'
    );
  });

  it('should reject invalid shared options at the top level, before any decode', async () => {
    const inputs = [new Uint8Array([1]), new Uint8Array([2])];

    const formatError = await convertMany(inputs, { to: 'gif' as never }).catch((e) => e);
    expect(formatError.code).toBe('invalid_format');
    const qualityError = await convertMany(inputs, { quality: 2 }).catch((e) => e);
    expect(qualityError.code).toBe('invalid_quality');
    const resizeError = await convertMany(inputs, { scale: 0 }).catch((e) => e);
    expect(resizeError.code).toBe('invalid_resize');
    expect(mockState.decoderInstances).toHaveLength(0);
  });

  it('should surface the canvas probe error instead of wrapping it per item', async () => {
    mockState.assertEncodeEnvironmentMock.mockImplementation(() => {
      throw new Error('Canvas is not supported');
    });

    const error = await convertMany([new Uint8Array([1])]).catch((e) => e);
    expect(error.message).toContain('Canvas is not supported');
    expect(mockState.decoderInstances).toHaveLength(0);
  });

  it('should return an empty array for empty inputs', async () => {
    const results = await convertMany([]);

    expect(results).toEqual([]);
    expect(mockState.decoderInstances).toHaveLength(0);
  });

  it('should throw a clear error for non-array inputs', async () => {
    await expect(convertMany(undefined as any)).rejects.toThrow(
      'Inputs must be an array of HEIC images'
    );
    await expect(convertMany('not-an-array' as any)).rejects.toThrow(
      'Inputs must be an array of HEIC images'
    );
  });

  it('should throw when concurrency is zero', async () => {
    await expect(convertMany([new Uint8Array([1])], { concurrency: 0 })).rejects.toThrow(
      'Concurrency must be a positive integer'
    );
  });

  it('should throw when concurrency is negative', async () => {
    await expect(convertMany([new Uint8Array([1])], { concurrency: -1 })).rejects.toThrow(
      'Concurrency must be a positive integer'
    );
  });

  it('should throw when concurrency is not an integer', async () => {
    await expect(convertMany([new Uint8Array([1])], { concurrency: 1.5 })).rejects.toThrow(
      'Concurrency must be a positive integer'
    );
  });

  it('should throw when concurrency is not a number', async () => {
    await expect(convertMany([new Uint8Array([1])], { concurrency: '2' as any })).rejects.toThrow(
      'Concurrency must be a positive integer'
    );
  });

  it('should throw when concurrency is Infinity or NaN', async () => {
    await expect(convertMany([new Uint8Array([1])], { concurrency: Infinity })).rejects.toThrow(
      'Concurrency must be a positive integer'
    );
    await expect(convertMany([new Uint8Array([1])], { concurrency: NaN })).rejects.toThrow(
      'Concurrency must be a positive integer'
    );
  });
});

describe('convertMany - continueOnError', () => {
  beforeEach(() => {
    resetConvertMocks({ renderAndEncode: renderFromPixel, decodeImpl: batchDecodeImpl });
  });

  it('resolves with per-item results for a mixed batch, in input order', async () => {
    const results = await convertMany(
      [new Uint8Array([5]), new Uint8Array([1]), new Uint8Array([6])],
      { continueOnError: true, concurrency: 3 }
    );

    expect(results).toHaveLength(3);
    expect(results[0]).toMatchObject({ index: 0, ok: false });
    expect((results[0] as { error: Error }).error.message).toContain('input 5');
    expect(results[1]).toMatchObject({ index: 1, ok: true });
    expect((results[1] as { result: Blob }).result).toBeInstanceOf(Blob);
    expect(results[2]).toMatchObject({ index: 2, ok: false });
    expect((results[2] as { error: Error }).error.message).toContain('input 6');
  });

  it('runs every item to completion even after failures', async () => {
    const results = await convertMany(
      [new Uint8Array([5]), new Uint8Array([2]), new Uint8Array([6])],
      { continueOnError: true, concurrency: 1 }
    );

    // No early stop: all three items were processed by their own decoder.
    expect(results).toHaveLength(3);
    expect(mockState.decoderInstances).toHaveLength(3);
    expect(results.map((entry) => entry.ok)).toEqual([false, true, false]);
  });

  it('preserves input order when items complete out of order', async () => {
    // Item 0 is slow (50ms), item 1 fast (10ms): results must still follow
    // input order.
    const results = await convertMany([new Uint8Array([1]), new Uint8Array([2])], {
      continueOnError: true,
      concurrency: 2,
    });

    const blobs = results.map((entry) => (entry.ok ? entry.result : null));
    expect(blobs[0]).toBeInstanceOf(Blob);
    expect(await (blobs[0] as Blob).text()).toBe('1');
    expect(await (blobs[1] as Blob).text()).toBe('2');
  });

  it('reports progress only for successful items, as (index, percent)', async () => {
    const onProgress = vi.fn();
    await convertMany([new Uint8Array([5]), new Uint8Array([2])], {
      continueOnError: true,
      concurrency: 2,
      onProgress,
    });

    expect(onProgress).toHaveBeenCalledWith(1, 100);
    expect(onProgress.mock.calls.length).toBe(1);
  });

  it('still rejects up-front validation failures', async () => {
    await expect(
      convertMany([new Uint8Array([1])], { continueOnError: true, concurrency: 0 })
    ).rejects.toMatchObject({ code: 'invalid_concurrency' });
    expect(mockState.decoderInstances).toHaveLength(0);
  });

  it.each<[unknown, string]>([['yes', 'string'], [1, 'number'], [{}, 'object']])(
    'rejects non-boolean continueOnError (%s as %s)',
    async (continueOnError) => {
      const error = await convertMany([new Uint8Array([2])], {
        continueOnError: continueOnError as unknown as boolean,
      }).catch((e) => e);
      expect(error).toMatchObject({ code: 'invalid_input' });
      expect(error.message).toContain('continueOnError must be a boolean');
    }
  );

  it('an all-failing batch still fulfills (with failure entries)', async () => {
    const results = await convertMany([new Uint8Array([5]), new Uint8Array([7])], {
      continueOnError: true,
    });
    expect(results.every((entry) => entry.ok === false)).toBe(true);
    expect(results.map((entry) => entry.index)).toEqual([0, 1]);
  });

  it('normalizes non-Error throws into Error instances on failure entries', async () => {
    mockState.decodeImpl = async () => {
      const raw: unknown = 'raw string failure';
      throw raw;
    };
    const results = await convertMany([new Uint8Array([1])], { continueOnError: true });
    const entry = results[0] as { ok: false; error: Error };
    expect(entry.ok).toBe(false);
    expect(entry.error).toBeInstanceOf(Error);
    expect(entry.error.message).toContain('raw string failure');
  });
});

describe('convertMany - reuseDecoders (pool)', () => {
  beforeEach(() => {
    resetConvertMocks({ renderAndEncode: renderFromPixel, decodeImpl: batchDecodeImpl });
  });

  // Values 10-17 never fail (failure values are 5, 6, 7, 8, 9, 18).
  const okInputs = (values: number[]) => values.map((v) => new Uint8Array([v]));

  it('creates one decoder per runner, decodes every item, and frees at batch end', async () => {
    const results = await convertMany(okInputs([10, 11, 12, 13, 14, 15, 16, 17]), {
      concurrency: 2,
      reuseDecoders: true,
    });

    expect(results).toHaveLength(8);
    // Pool bound by runner count, not item count.
    expect(mockState.decoderInstances).toHaveLength(2);
    for (const instance of mockState.decoderInstances) {
      expect(instance.decode).toHaveBeenCalledTimes(4);
      // dispose() frees exactly once per pooled instance.
      expect(instance.free).toHaveBeenCalledTimes(1);
    }
    expect(mockState.renderAndEncodeMock).toHaveBeenCalledTimes(8);
  });

  it('default path still creates a fresh decoder per item', async () => {
    await convertMany(okInputs([10, 11, 12, 13, 14, 15, 16, 17]), { concurrency: 2 });
    expect(mockState.decoderInstances).toHaveLength(8);
  });

  it('sequential concurrency reuses a single instance', async () => {
    await convertMany(okInputs([10, 11, 12]), { concurrency: 1, reuseDecoders: true });

    expect(mockState.decoderInstances).toHaveLength(1);
    expect(mockState.decoderInstances[0].decode).toHaveBeenCalledTimes(3);
    expect(mockState.decoderInstances[0].initialize).toHaveBeenCalledTimes(3);
    // The wrapper memoizes module loading, so re-initialize is cheap.
    expect(mockState.decoderInstances[0].free).toHaveBeenCalledTimes(1);
  });

  it('frees pooled decoders when the batch fails', async () => {
    await expect(
      convertMany(okInputs([10, 5]), { concurrency: 1, reuseDecoders: true })
    ).rejects.toMatchObject({ code: 'batch_item_failed' });

    expect(mockState.decoderInstances).toHaveLength(1);
    expect(mockState.decoderInstances[0].free).toHaveBeenCalledTimes(1);
  });

  it('discards a pooled decoder whose module faulted instead of re-leasing it', async () => {
    // A trap inside the module leaves emmalloc's arena unusable. An instance in
    // the fault registry must never be leased again — parking it would hand a
    // corrupted heap to the next item, which is undefined behaviour, not an error.
    resetConvertMocks({
      renderAndEncode: renderFromPixel,
      decodeImpl: async (data, _onProgress, self) => {
        if (data[0] === 11) {
          markFaulted(self as object);
          throw new WebAssembly.RuntimeError('unreachable');
        }
        return { width: 1, height: 1, data: new Uint8ClampedArray([data[0], 0, 0, 255]) };
      },
    });

    const results = await convertMany(okInputs([10, 11, 12]), {
      concurrency: 1,
      reuseDecoders: true,
      continueOnError: true,
    });

    expect(results.map((entry) => entry.ok)).toEqual([true, false, true]);
    const [faulted, replacement] = mockState.decoderInstances;
    expect(mockState.decoderInstances).toHaveLength(2);
    // The faulted instance served items 10 and 11, was freed by release() — and
    // was never leased a third time.
    expect(faulted!.decode).toHaveBeenCalledTimes(2);
    expect(faulted!.free).toHaveBeenCalledTimes(1);
    // The replacement served item 12, and dispose() frees it.
    expect(replacement!.decode).toHaveBeenCalledTimes(1);
    expect(replacement!.free).toHaveBeenCalledTimes(1);
  });

  it('keeps leasing after every pooled instance has faulted (waiters never park)', async () => {
    // A poisoned release frees the instance, so `leasedCount` must come back
    // down with it. If it stayed high, once `max` instances had faulted the pool
    // would be permanently full and the next item would wait for a slot that
    // nobody could ever hand back.
    resetConvertMocks({
      renderAndEncode: renderFromPixel,
      decodeImpl: async (_data, _onProgress, self) => {
        markFaulted(self as object);
        throw new WebAssembly.RuntimeError('unreachable');
      },
    });

    const results = await convertMany(okInputs([11, 11, 11, 11, 11, 11]), {
      concurrency: 2,
      reuseDecoders: true,
      continueOnError: true,
    });

    expect(results).toHaveLength(6);
    expect(results.every((entry) => entry.ok === false)).toBe(true);
    expect(mockState.decoderInstances).toHaveLength(6);
    for (const instance of mockState.decoderInstances) {
      expect(instance.decode).toHaveBeenCalledTimes(1);
      expect(instance.free).toHaveBeenCalledTimes(1);
    }
  });

  it('each pooled item decodes its own payload (leased instances are not cross-used)', async () => {
    await convertMany(okInputs([10, 11, 12, 13]), { concurrency: 2, reuseDecoders: true });

    // The default decode mock echoes the first input byte into the decoded
    // pixels: the renderer must have seen one distinct payload per item.
    const seen = mockState.renderAndEncodeMock.mock.calls
      .map((call) => (call[0] as { data: Uint8ClampedArray }).data[0])
      .sort((a, b) => a - b);
    expect(seen).toEqual([10, 11, 12, 13]);
  });

  it('an injected decoder disables the pool entirely', async () => {
    const injected = {
      initialize: vi.fn(async () => undefined),
      decode: vi.fn(async (data: Uint8Array) => ({
        width: 1,
        height: 1,
        data: new Uint8ClampedArray([data[0], 0, 0, 255]),
      })),
      free: vi.fn(),
    };

    await convertMany(okInputs([10, 11, 12]), {
      decoder: injected as never,
      reuseDecoders: true,
    });

    expect(mockState.decoderInstances).toHaveLength(0);
    expect(injected.decode).toHaveBeenCalledTimes(3);
    expect(injected.free).not.toHaveBeenCalled();
  });

  it.each<[unknown, string]>([['true', 'string'], [1, 'number'], [{}, 'object']])(
    'rejects non-boolean reuseDecoders (%s as %s)',
    async (reuseDecoders) => {
      const error = await convertMany(okInputs([10]), {
        reuseDecoders: reuseDecoders as unknown as boolean,
      }).catch((e) => e);
      expect(error).toMatchObject({ code: 'invalid_input' });
      expect(error.message).toContain('reuseDecoders must be a boolean');
      expect(mockState.decoderInstances).toHaveLength(0);
    }
  );
});

describe('convertMany - AbortSignal', () => {
  beforeEach(() => {
    resetConvertMocks({ renderAndEncode: renderFromPixel, decodeImpl: batchDecodeImpl });
  });

  it('a pre-aborted batch rejects with aborted (not batch_item_failed)', async () => {
    const controller = new AbortController();
    controller.abort();

    const error = await convertMany([new Uint8Array([10]), new Uint8Array([11])], {
      signal: controller.signal,
    }).catch((e) => e);

    expect(error).toMatchObject({ code: 'aborted' });
    expect(mockState.renderAndEncodeMock).not.toHaveBeenCalled();
  });

  it('aborting mid-batch rejects with aborted', async () => {
    const controller = new AbortController();
    let aborted = false;
    mockState.decodeImpl = async (data, onProgress) => {
      if (!aborted) {
        aborted = true;
        controller.abort();
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
      onProgress?.(100);
      return { width: 1, height: 1, data: new Uint8ClampedArray([data[0], 0, 0, 255]) };
    };

    const error = await convertMany(
      [new Uint8Array([10]), new Uint8Array([11]), new Uint8Array([12])],
      { signal: controller.signal, concurrency: 1 }
    ).catch((e) => e);

    expect(error).toMatchObject({ code: 'aborted' });
  });

  it('continueOnError with a pre-aborted signal fulfills with aborted error entries', async () => {
    const controller = new AbortController();
    controller.abort();

    const results = await convertMany([new Uint8Array([10]), new Uint8Array([11])], {
      signal: controller.signal,
      continueOnError: true,
    });

    expect(results).toHaveLength(2);
    for (const entry of results) {
      if (entry.ok) {
        throw new Error('expected every item to be aborted');
      }
      expect(entry.error).toBeInstanceOf(HeicConverterError);
      expect((entry.error as HeicConverterError).code).toBe('aborted');
    }
  });

  it('a post-completion abort still returns the results (completion wins)', async () => {
    const controller = new AbortController();
    const results = await convertMany([new Uint8Array([10]), new Uint8Array([11])], {
      signal: controller.signal,
    });
    controller.abort();
    expect(results).toHaveLength(2);
  });

  it('rejects a malformed signal before any item runs', async () => {
    await expect(
      convertMany([new Uint8Array([10])], { signal: {} as unknown as AbortSignal })
    ).rejects.toMatchObject({ code: 'invalid_input' });
    expect(mockState.decoderInstances).toHaveLength(0);
  });

  it('continueOnError stops launching items after an abort and fills the rest with aborted entries', async () => {
    const controller = new AbortController();
    let decodes = 0;
    mockState.decodeImpl = async (data) => {
      decodes += 1;
      if (decodes === 1) {
        controller.abort();
      }
      return { width: 1, height: 1, data: new Uint8ClampedArray([data[0], 0, 0, 255]) };
    };

    const results = await convertMany(
      [new Uint8Array([10]), new Uint8Array([11]), new Uint8Array([12]), new Uint8Array([13])],
      { signal: controller.signal, continueOnError: true, concurrency: 1 }
    );

    expect(results).toHaveLength(4);
    for (const entry of results) {
      if (entry.ok) {
        throw new Error('expected every item to be aborted');
      }
      expect(entry.error).toBeInstanceOf(HeicConverterError);
      expect((entry.error as HeicConverterError).code).toBe('aborted');
    }
    // The not-yet-started items were completed without being launched.
    expect(decodes).toBe(1);
  });

  it('continueOnError passed as a widened boolean still fulfills with per-item entries', async () => {
    const flag: boolean = true;
    const results = await convertMany([new Uint8Array([10]), new Uint8Array([5])], {
      continueOnError: flag,
      concurrency: 2,
    });
    expect(results).toHaveLength(2);
    expect((results[0] as { ok: boolean }).ok).toBe(true);
    expect((results[1] as { ok: boolean }).ok).toBe(false);
  });
});
