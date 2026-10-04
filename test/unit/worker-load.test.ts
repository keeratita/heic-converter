import { describe, it, expect, vi } from 'vitest';

// The Web Worker implementation is a lazily imported chunk. Simulate the case
// where it cannot be fetched (an incomplete dist/ deployment, or a bundler that
// did not emit the chunk): the public contract is that these entry points
// reject with a HeicConverterError carrying a machine-readable code, never with
// a raw bundler / ERR_MODULE_NOT_FOUND error.
vi.mock('../../src/worker', () => {
  throw new Error('Failed to fetch dynamically imported module .../dist/worker-XXXX.js');
});

import { convertHeicInWorker, convertManyInWorker, HeicConverterError } from '../../src/index';

const INPUT = new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70]);

describe('worker entry points when the worker chunk cannot be loaded', () => {
  it('convertHeicInWorker rejects with HeicConverterError(worker_load_failed)', async () => {
    const error = await convertHeicInWorker(INPUT, {}).catch((e) => e);
    expect(error).toBeInstanceOf(HeicConverterError);
    expect(error.code).toBe('worker_load_failed');
    expect(error.message).toContain('Web Worker implementation chunk');
    expect(error.message).toContain('dist/worker-');
    // The original failure stays reachable for diagnostics (its text is
    // vitest's mock-error placeholder here rather than the fetch message).
    expect(error.cause).toBeDefined();
  });

  it('convertManyInWorker rejects with the same typed error', async () => {
    const error = await convertManyInWorker([INPUT], {}).catch((e) => e);
    expect(error).toBeInstanceOf(HeicConverterError);
    expect(error.code).toBe('worker_load_failed');
  });
});
