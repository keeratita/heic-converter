import { beforeEach, describe, expect, it, vi } from 'vitest';

// Stubs the lazily imported worker chunk so these tests exercise the *public*
// entry points in src/index.ts. worker.test.ts drives src/worker directly, so
// without this file the deferred wrappers themselves — the code every caller
// actually runs — would have no success-path coverage: forwarding, result
// pass-through and the "only import() failures are re-mapped" rule are exactly
// what a future edit to these three-line wrappers can silently break.
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

/**
 * The entry points are thin deferred wrappers, so the contract worth pinning is
 * that they stay thin: same arguments, same resolved value, same rejection.
 */
describe('convertHeicInWorker / convertManyInWorker pass the deferred module through', () => {
  it('forwards input and options unchanged and resolves with the module result', async () => {
    const result = { blob: decodedBlob, width: 10, height: 20, format: 'jpeg' };
    convertHeicSpy.mockResolvedValue(result);

    const actual = await convertHeicInWorker(INPUT, OPTIONS);

    expect(convertHeicSpy).toHaveBeenCalledTimes(1);
    // Identity, not a structural copy: options must not be cloned or defaulted here.
    expect(convertHeicSpy.mock.calls[0][0]).toBe(INPUT);
    expect(convertHeicSpy.mock.calls[0][1]).toBe(OPTIONS);
    expect(actual).toBe(result);
  });

  it('resolves every OutputShape value verbatim (no shape rewriting on the way out)', async () => {
    const shapes = [
      { blob: decodedBlob, width: 1, height: 1, format: 'jpeg' },
      'data:image/jpeg;base64,AAA=',
      new ArrayBuffer(3),
    ];
    for (const shape of shapes) {
      convertHeicSpy.mockResolvedValueOnce(shape);
      // The generic is what picks the public overload; the wrapper must not touch it.
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
    // Regression guard for the worker_load_failed mapping: only a failed chunk
    // *fetch* may be re-mapped. An error raised by the worker implementation
    // keeps its code and identity, or callers branching on error.code break.
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
    // Nothing in the wrapper should convert a genuine implementation bug into a
    // friendly code — that would hide defects behind a load-failure message.
    const bug = new TypeError('cannot read property blob of undefined');
    convertHeicSpy.mockRejectedValue(bug);

    const error = await convertHeicInWorker(INPUT, OPTIONS).catch((e) => e);
    expect(error).toBe(bug);
    expect(error).not.toBeInstanceOf(HeicConverterError);
  });
});
