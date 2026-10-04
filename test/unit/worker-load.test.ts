import { describe, it, expect, vi } from 'vitest';

// When the lazy worker chunk cannot be fetched, these entry points must reject with
// a HeicConverterError carrying a machine-readable code, not a raw module-load error.
vi.mock('../../src/worker', () => {
  throw new Error('Failed to fetch dynamically imported module .../dist/worker-XXXX.js');
});

import { convertHeicInWorker, convertManyInWorker, HeicConverterError } from '../../src/index';

const INPUT = new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70]);

describe('worker entry points when the worker chunk cannot be loaded', () => {
  it('convertHeicInWorker rejects with HeicConverterError(worker_load_failed)', async () => {
    const error = await convertHeicInWorker(INPUT, { workerUrl: '/worker.js' }).catch((e) => e);
    expect(error).toBeInstanceOf(HeicConverterError);
    expect(error.code).toBe('worker_load_failed');
    expect(error.message).toContain('Web Worker implementation chunk');
    expect(error.message).toContain('dist/worker-');
    // The original failure stays reachable for diagnostics.
    expect(error.cause).toBeDefined();
  });

  it('convertManyInWorker rejects with the same typed error', async () => {
    const error = await convertManyInWorker([INPUT], { workerUrl: '/worker.js' }).catch((e) => e);
    expect(error).toBeInstanceOf(HeicConverterError);
    expect(error.code).toBe('worker_load_failed');
  });
});
