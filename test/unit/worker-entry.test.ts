import { beforeEach, describe, expect, it, vi } from 'vitest';

// Stubs the lazily imported worker chunk so these tests exercise the public
// entry points in src/index.ts; worker.test.ts drives src/worker directly,
// which leaves the deferred wrappers — what callers actually run — untested.
vi.mock('../../src/worker', () => ({
  convertHeicInWorker: vi.fn(),
  convertManyInWorker: vi.fn(),
}));

import * as workerChunk from '../../src/worker';
import { convertHeicInWorker, convertManyInWorker, HeicConverterError } from '../../src/index';

const convertHeicSpy = workerChunk.convertHeicInWorker as unknown as ReturnType<typeof vi.fn>;
const convertManySpy = workerChunk.convertManyInWorker as unknown as ReturnType<typeof vi.fn>;

const INPUT = new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70]);
const OPTIONS = { format: 'webp' as const, quality: 0.5, output: 'arraybuffer' as const };
const decodedBlob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/jpeg' });

beforeEach(() => {
  convertHeicSpy.mockReset();
  convertManySpy.mockReset();
});

describe('convertHeicInWorker / convertManyInWorker pass the deferred module through', () => {
  it('forwards input and options unchanged and resolves with the module result', async () => {
    const result = { blob: decodedBlob, width: 10, height: 20, format: 'jpeg' };
    convertHeicSpy.mockResolvedValue(result);

    const actual = await convertHeicInWorker(INPUT, OPTIONS);

    expect(convertHeicSpy).toHaveBeenCalledTimes(1);
    // Identity: options must not be cloned or defaulted on the way through.
    expect(convertHeicSpy.mock.calls[0][0]).toBe(INPUT);
    expect(convertHeicSpy.mock.calls[0][1]).toBe(OPTIONS);
    expect(actual).toBe(result);
  });

  it('resolves every OutputShape value verbatim', async () => {
    const shapes = [
      { blob: decodedBlob, width: 1, height: 1, format: 'jpeg' },
      'data:image/jpeg;base64,AAA=',
      new ArrayBuffer(3),
    ];
    for (const shape of shapes) {
      convertHeicSpy.mockResolvedValueOnce(shape);
      await expect(convertHeicInWorker(INPUT, { ...OPTIONS, output: 'blob' })).resolves.toBe(shape);
    }
  });

  it('forwards the batch inputs and options unchanged and resolves with the module result', async () => {
    const results = [{ ok: true, result: { blob: decodedBlob } }, { ok: false, error: 'x' }];
    convertManySpy.mockResolvedValue(results);
    const inputs = [INPUT, INPUT];
    const batchOptions = { maxConcurrentWorkers: 2, continueOnError: true };

    const actual = await convertManyInWorker(inputs, batchOptions);

    expect(convertManySpy).toHaveBeenCalledTimes(1);
    expect(convertManySpy.mock.calls[0][0]).toBe(inputs);
    expect(convertManySpy.mock.calls[0][1]).toBe(batchOptions);
    expect(actual).toBe(results);
  });

  it('propagates a HeicConverterError from the worker implementation untouched', async () => {
    // Only a failed chunk *fetch* may be re-mapped to worker_load_failed; an
    // error from the worker implementation keeps its code and identity.
    const timeout = new HeicConverterError('worker_timeout', 'timed out');
    convertHeicSpy.mockRejectedValue(timeout);
    const error = await convertHeicInWorker(INPUT, OPTIONS).catch((e) => e);
    expect(error).toBe(timeout);
    expect(error.code).toBe('worker_timeout');

    const failed = new HeicConverterError('decode_failed', 'bad heic');
    convertManySpy.mockRejectedValue(failed);
    const batchError = await convertManyInWorker([INPUT], {}).catch((e) => e);
    expect(batchError).toBe(failed);
    expect(batchError.code).toBe('decode_failed');
  });

  it('propagates a non-HeicConverterError from the worker implementation untouched', async () => {
    // A genuine implementation bug must not be hidden behind a load-failure code.
    const bug = new TypeError('cannot read property blob of undefined');
    convertHeicSpy.mockRejectedValue(bug);

    const error = await convertHeicInWorker(INPUT, OPTIONS).catch((e) => e);
    expect(error).toBe(bug);
    expect(error).not.toBeInstanceOf(HeicConverterError);
  });
});
