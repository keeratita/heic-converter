import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  convertHeicInWorker,
  convertManyInWorker,
  __semaphoreTestHooks,
} from '../../src/worker';

class MockWorker {
  static instances: MockWorker[] = [];
  static constructionError: unknown = null;
  static postError: unknown = null;

  url: string | URL;
  options?: WorkerOptions;
  posted: unknown[] = [];
  listeners: Record<string, Array<(event: any) => void>> = {};
  terminated = false;

  constructor(url: string | URL, options?: WorkerOptions) {
    if (MockWorker.constructionError !== null) {
      throw MockWorker.constructionError;
    }
    this.url = url;
    this.options = options;
    MockWorker.instances.push(this);
  }

  addEventListener(type: string, listener: (event: any) => void): void {
    (this.listeners[type] ??= []).push(listener);
  }

  removeEventListener(type: string, listener: (event: any) => void): void {
    this.listeners[type] = (this.listeners[type] ?? []).filter((l) => l !== listener);
  }

  postMessage(data: unknown): void {
    if (MockWorker.postError !== null) {
      throw MockWorker.postError;
    }
    this.posted.push(data);
  }

  terminate(): void {
    this.terminated = true;
  }

  emit(type: string, event: any): void {
    for (const listener of this.listeners[type] ?? []) {
      listener(event);
    }
  }
}

describe('convertHeicInWorker', () => {
  let originalWorker: typeof Worker;

  beforeEach(() => {
    originalWorker = globalThis.Worker;
    MockWorker.instances.length = 0;
    MockWorker.constructionError = null;
    MockWorker.postError = null;
    globalThis.Worker = MockWorker as unknown as typeof Worker;
  });

  afterEach(() => {
    globalThis.Worker = originalWorker;
  });

  it('should resolve with the blob when the worker reports success', async () => {
    const blob = new Blob(['converted'], { type: 'image/jpeg' });
    const promise = convertHeicInWorker(new Uint8Array([1]), { workerUrl: '/worker.js' });

    const worker = MockWorker.instances[0];
    worker.emit('message', { data: { type: 'result', ok: true, blob } });

    await expect(promise).resolves.toBe(blob);
    expect(worker.terminated).toBe(true);
  });

  it('should reject when the worker reports an error', async () => {
    const promise = convertHeicInWorker(new Uint8Array([1]), { workerUrl: '/worker.js' });

    const worker = MockWorker.instances[0];
    worker.emit('message', { data: { type: 'result', ok: false, error: 'boom' } });

    const error = await promise.catch((e) => e);
    expect(error.code).toBe('worker_failed');
    expect(error.message).toContain('boom');
    expect(worker.terminated).toBe(true);
  });

  it('should reject with a generic message when the worker reports failure without details', async () => {
    const promise = convertHeicInWorker(new Uint8Array([1]), { workerUrl: '/worker.js' });

    const worker = MockWorker.instances[0];
    worker.emit('message', { data: { type: 'result', ok: false } });

    await expect(promise).rejects.toThrow('Worker conversion failed');
  });

  it('should reject when the worker emits an error event', async () => {
    const promise = convertHeicInWorker(new Uint8Array([1]), { workerUrl: '/worker.js' });

    const worker = MockWorker.instances[0];
    worker.emit('error', { message: 'worker crashed' });

    await expect(promise).rejects.toThrow('worker crashed');
    expect(worker.terminated).toBe(true);
  });

  it('should reject when Worker is not supported', async () => {
    globalThis.Worker = undefined as unknown as typeof Worker;

    await expect(
      convertHeicInWorker(new Uint8Array([1]), { workerUrl: '/worker.js' })
    ).rejects.toThrow('Web Worker is not supported');
  });

  it('should post the input and cloneable options to the worker', async () => {
    const input = new Uint8Array([1, 2, 3]);
    const promise = convertHeicInWorker(input, {
      workerUrl: '/worker.js',
      to: 'png',
      quality: 0.5,
      maxWidth: 800,
    });

    const worker = MockWorker.instances[0];
    expect(worker.posted).toHaveLength(1);
    const posted = worker.posted[0] as { input: Uint8Array; options: Record<string, unknown> };
    expect(posted.input).toBe(input);
    expect(posted.options).toEqual({ to: 'png', quality: 0.5, maxWidth: 800 });

    worker.emit('message', { data: { type: 'result', ok: true, blob: new Blob() } });
    await promise;
  });

  it('should reject when a decoder is injected (cannot cross the worker boundary)', async () => {
    const decoder = { initialize: vi.fn(), decode: vi.fn(), free: vi.fn() };

    const error = await convertHeicInWorker(new Uint8Array([1]), {
      workerUrl: '/worker.js',
      decoder: decoder as any,
      onProgress: vi.fn(),
      scale: 0.5,
    }).catch((e) => e);

    expect(error).toBeInstanceOf(Error);
    expect(error.code).toBe('invalid_input');
    expect(error.message).toContain('decoder option is not supported');
    // Fails before any worker is even constructed.
    expect(MockWorker.instances).toHaveLength(0);
  });

  it('should forward progress messages to the onProgress callback', async () => {
    const onProgress = vi.fn();
    const promise = convertHeicInWorker(new Uint8Array([1]), {
      workerUrl: '/worker.js',
      onProgress,
    });

    const worker = MockWorker.instances[0];
    worker.emit('message', { data: { type: 'progress', percent: 42 } });
    worker.emit('message', { data: { type: 'progress', percent: 100 } });
    worker.emit('message', { data: { type: 'result', ok: true, blob: new Blob() } });

    await promise;
    expect(onProgress).toHaveBeenCalledWith(42);
    expect(onProgress).toHaveBeenCalledWith(100);
    expect(worker.terminated).toBe(true);
  });

  it('should not terminate the worker on progress messages', async () => {
    const promise = convertHeicInWorker(new Uint8Array([1]), { workerUrl: '/worker.js' });

    const worker = MockWorker.instances[0];
    worker.emit('message', { data: { type: 'progress', percent: 10 } });

    expect(worker.terminated).toBe(false);

    worker.emit('message', { data: { type: 'result', ok: true, blob: new Blob() } });
    await promise;
  });

  it('should create a classic worker by default', async () => {
    const promise = convertHeicInWorker(new Uint8Array([1]), { workerUrl: '/worker.js' });

    const worker = MockWorker.instances[0];
    expect(worker.options).toBeUndefined();

    worker.emit('message', { data: { type: 'result', ok: true, blob: new Blob() } });
    await promise;
  });

  it('should create a module worker when workerType is module', async () => {
    const promise = convertHeicInWorker(new Uint8Array([1]), {
      workerUrl: '/worker.js',
      workerType: 'module',
    });

    const worker = MockWorker.instances[0];
    expect(worker.options).toEqual({ type: 'module' });

    worker.emit('message', { data: { type: 'result', ok: true, blob: new Blob() } });
    await promise;
  });

  it('should reject when the Worker constructor throws', async () => {
    MockWorker.constructionError = new Error('worker script not found');

    await expect(
      convertHeicInWorker(new Uint8Array([1]), { workerUrl: '/missing.js' })
    ).rejects.toThrow('Failed to create Web Worker: worker script not found');
  });

  it('should reject when the Worker constructor throws a non-Error value', async () => {
    MockWorker.constructionError = 'boom';

    await expect(
      convertHeicInWorker(new Uint8Array([1]), { workerUrl: '/missing.js' })
    ).rejects.toThrow('Failed to create Web Worker: boom');
  });

  it('should reject when the worker posts a result without ok', async () => {
    const promise = convertHeicInWorker(new Uint8Array([1]), { workerUrl: '/worker.js' });

    const worker = MockWorker.instances[0];
    worker.emit('message', { data: { type: 'result', ok: false } });

    await expect(promise).rejects.toThrow('Worker conversion failed');
    expect(worker.terminated).toBe(true);
  });

  it('should ignore messages that are not progress or result', async () => {
    const promise = convertHeicInWorker(new Uint8Array([1]), { workerUrl: '/worker.js' });

    const worker = MockWorker.instances[0];
    worker.emit('message', { data: undefined });
    worker.emit('message', { data: { type: 'log', text: 'hello' } });
    worker.emit('message', { data: { type: 'init' } });

    expect(worker.terminated).toBe(false);

    worker.emit('message', { data: { type: 'result', ok: true, blob: new Blob() } });
    await promise;
  });

  it('should reject with a timeout when no result arrives', async () => {
    const promise = convertHeicInWorker(new Uint8Array([1]), {
      workerUrl: '/worker.js',
      timeoutMs: 10,
    });

    await expect(promise).rejects.toThrow('Web Worker conversion timed out');
    expect(MockWorker.instances[0].terminated).toBe(true);
  });

  it('should work with the timeout disabled', async () => {
    const blob = new Blob(['converted'], { type: 'image/jpeg' });
    const promise = convertHeicInWorker(new Uint8Array([1]), {
      workerUrl: '/worker.js',
      timeoutMs: 0,
    });

    const worker = MockWorker.instances[0];
    worker.emit('message', { data: { type: 'result', ok: true, blob } });

    await expect(promise).resolves.toBe(blob);
    expect(worker.terminated).toBe(true);
  });

  it('should reject when the worker emits a messageerror event', async () => {
    const promise = convertHeicInWorker(new Uint8Array([1]), { workerUrl: '/worker.js' });

    const worker = MockWorker.instances[0];
    worker.emit('messageerror', { data: new Error('deserialization failed') });

    const error = await promise.catch((e) => e);
    expect(error.code).toBe('worker_failed');
    expect(error.message).toContain('deserialization failed');
    expect((error.cause as Error).message).toBe('deserialization failed');
    expect(worker.terminated).toBe(true);
  });

  it('should reject with the detail message when messageerror carries a non-Error value', async () => {
    const promise = convertHeicInWorker(new Uint8Array([1]), { workerUrl: '/worker.js' });

    const worker = MockWorker.instances[0];
    worker.emit('messageerror', { data: 'clone failed' });

    await expect(promise).rejects.toThrow('clone failed');
    expect(worker.terminated).toBe(true);
  });

  it('should reject with the generic message when messageerror carries no detail', async () => {
    const promise = convertHeicInWorker(new Uint8Array([1]), { workerUrl: '/worker.js' });

    const worker = MockWorker.instances[0];
    worker.emit('messageerror', { data: undefined });

    await expect(promise).rejects.toThrow('Worker failed');
    expect(worker.terminated).toBe(true);
  });

  it('should include the file and line in the error event message', async () => {
    const promise = convertHeicInWorker(new Uint8Array([1]), { workerUrl: '/worker.js' });

    const worker = MockWorker.instances[0];
    worker.emit('error', { message: 'boom', filename: 'worker.js', lineno: 42 });

    await expect(promise).rejects.toThrow('boom (worker.js:42)');
    expect(worker.terminated).toBe(true);
  });

  it('should clamp progress percentages to 0-100', async () => {
    const onProgress = vi.fn();
    const promise = convertHeicInWorker(new Uint8Array([1]), {
      workerUrl: '/worker.js',
      onProgress,
    });

    const worker = MockWorker.instances[0];
    worker.emit('message', { data: { type: 'progress', percent: 150 } });
    worker.emit('message', { data: { type: 'progress', percent: -5 } });
    worker.emit('message', { data: { type: 'progress', percent: '50' } });
    worker.emit('message', { data: { type: 'progress', percent: NaN } });

    // 150 clamps to 100, which is withheld until success; -5 and NaN clamp
    // to 0, '50' coerces to 50.
    expect(onProgress).not.toHaveBeenCalledWith(100);
    expect(onProgress).toHaveBeenCalledWith(0);
    expect(onProgress).toHaveBeenCalledWith(50);

    worker.emit('message', { data: { type: 'result', ok: true, blob: new Blob() } });
    await promise;
    expect(onProgress).toHaveBeenLastCalledWith(100);
  });

  it('should reject with progress_callback_failed when onProgress throws on the final 100', async () => {
    const onProgress = vi.fn((percent: number) => {
      if (percent >= 100) {
        throw new Error('late crash');
      }
    });
    const promise = convertHeicInWorker(new Uint8Array([1]), {
      workerUrl: '/worker.js',
      onProgress,
    });

    const worker = MockWorker.instances[0];
    worker.emit('message', { data: { type: 'result', ok: true, blob: new Blob() } });

    const error = await promise.catch((e) => e);
    expect(error.code).toBe('progress_callback_failed');
    expect(error.message).toContain('late crash');
  });

  it('should ignore progress messages after the result', async () => {
    const onProgress = vi.fn();
    const promise = convertHeicInWorker(new Uint8Array([1]), {
      workerUrl: '/worker.js',
      onProgress,
    });

    const worker = MockWorker.instances[0];
    worker.emit('message', { data: { type: 'result', ok: true, blob: new Blob() } });
    await promise;

    worker.emit('message', { data: { type: 'progress', percent: 99 } });
    expect(onProgress).not.toHaveBeenCalledWith(99);
  });

  it('should ignore a second result message after the first', async () => {
    const firstBlob = new Blob(['first']);
    const secondBlob = new Blob(['second']);
    const promise = convertHeicInWorker(new Uint8Array([1]), { workerUrl: '/worker.js' });

    const worker = MockWorker.instances[0];
    worker.emit('message', { data: { type: 'result', ok: true, blob: firstBlob } });
    await expect(promise).resolves.toBe(firstBlob);

    worker.emit('message', { data: { type: 'result', ok: true, blob: secondBlob } });
    await expect(promise).resolves.toBe(firstBlob);
  });

  it('should reject and terminate the worker when onProgress throws', async () => {
    const onProgress = vi.fn(() => {
      throw new Error('progress handler crashed');
    });
    const promise = convertHeicInWorker(new Uint8Array([1]), {
      workerUrl: '/worker.js',
      onProgress,
    });

    const worker = MockWorker.instances[0];
    worker.emit('message', { data: { type: 'progress', percent: 50 } });

    const error = await promise.catch((e) => e);
    expect(error.code).toBe('progress_callback_failed');
    expect(error.message).toContain('progress handler crashed');
    expect(worker.terminated).toBe(true);
  });

  it('should reject and terminate the worker when onProgress throws a non-Error value', async () => {
    const onProgress = vi.fn(() => {
      throw 'boom';
    });
    const promise = convertHeicInWorker(new Uint8Array([1]), {
      workerUrl: '/worker.js',
      onProgress,
    });

    const worker = MockWorker.instances[0];
    worker.emit('message', { data: { type: 'progress', percent: 50 } });

    const error = await promise.catch((e) => e);
    expect(error.code).toBe('progress_callback_failed');
    expect(error.message).toContain('boom');
    expect(error.cause).toBe('boom');
    expect(worker.terminated).toBe(true);
  });

  it('should ignore progress messages when no onProgress callback is provided', async () => {
    const promise = convertHeicInWorker(new Uint8Array([1]), { workerUrl: '/worker.js' });

    const worker = MockWorker.instances[0];
    worker.emit('message', { data: { type: 'progress' } });
    worker.emit('message', { data: { type: 'progress', percent: 50 } });

    expect(worker.terminated).toBe(false);

    worker.emit('message', { data: { type: 'result', ok: true, blob: new Blob() } });
    await promise;
  });

  it('should forward progress with 0 when the percent is missing', async () => {
    const onProgress = vi.fn();
    const promise = convertHeicInWorker(new Uint8Array([1]), {
      workerUrl: '/worker.js',
      onProgress,
    });

    const worker = MockWorker.instances[0];
    worker.emit('message', { data: { type: 'progress' } });

    expect(onProgress).toHaveBeenCalledWith(0);

    worker.emit('message', { data: { type: 'result', ok: true, blob: new Blob() } });
    await promise;
  });

  it('should reject with the generic message when the worker emits an error event without a message', async () => {
    const promise = convertHeicInWorker(new Uint8Array([1]), { workerUrl: '/worker.js' });

    const worker = MockWorker.instances[0];
    worker.emit('error', {});

    await expect(promise).rejects.toThrow('Worker failed');
    expect(worker.terminated).toBe(true);
  });

  it('should reject and terminate the worker when postMessage throws', async () => {
    MockWorker.postError = new Error('clone error');

    const promise = convertHeicInWorker(new Uint8Array([1]), { workerUrl: '/worker.js' });

    await expect(promise).rejects.toThrow('Failed to post message to Web Worker: clone error');
    expect(MockWorker.instances[0].terminated).toBe(true);
  });

  it('should reject and terminate the worker when postMessage throws a non-Error value', async () => {
    MockWorker.postError = 'boom';

    const promise = convertHeicInWorker(new Uint8Array([1]), { workerUrl: '/worker.js' });

    await expect(promise).rejects.toThrow('Failed to post message to Web Worker: boom');
    expect(MockWorker.instances[0].terminated).toBe(true);
  });

  describe('Structured error codes', () => {
    it('should tag worker construction failures with worker_create_failed', async () => {
      MockWorker.constructionError = new Error('worker script not found');

      const error = await convertHeicInWorker(new Uint8Array([1]), {
        workerUrl: '/missing.js',
      }).catch((e) => e);
      expect(error.code).toBe('worker_create_failed');
    });

    it('should tag postMessage failures with worker_post_failed', async () => {
      MockWorker.postError = new Error('clone error');

      const error = await convertHeicInWorker(new Uint8Array([1]), {
        workerUrl: '/worker.js',
      }).catch((e) => e);
      expect(error.code).toBe('worker_post_failed');
    });

    it('should tag timeouts with worker_timeout', async () => {
      const error = await convertHeicInWorker(new Uint8Array([1]), {
        workerUrl: '/worker.js',
        timeoutMs: 5,
      }).catch((e) => e);
      expect(error.code).toBe('worker_timeout');
    });

    it('should tag failed results with worker_failed', async () => {
      const promise = convertHeicInWorker(new Uint8Array([1]), { workerUrl: '/worker.js' });
      MockWorker.instances[0].emit('message', { data: { type: 'result', ok: false, error: 'x' } });

      const error = await promise.catch((e) => e);
      expect(error.code).toBe('worker_failed');
    });

    it('should name the worker script in the timeout diagnostic and hint at the protocol', async () => {
      const promise = convertHeicInWorker(new Uint8Array([1]), {
        workerUrl: '/slow-worker.js',
        timeoutMs: 5,
      });

      const worker = MockWorker.instances[0];
      worker.emit('message', { data: { type: 'progress', percent: 40 } });
      worker.emit('message', { data: { type: 'log', text: 'chatty' } });

      const error = await promise.catch((e) => e);
      expect(error.message).toContain('1 progress message(s) received');
      expect(error.message).toContain('last percent 40');
      expect(error.message).toContain("unknown message type 'log'");
      expect(error.message).toContain('/slow-worker.js');
      expect(error.message).toContain('progress/result protocol');
      expect(worker.terminated).toBe(true);
    });

    it('should hint at the worker URL and MIME type for messageless error events', async () => {
      const promise = convertHeicInWorker(new Uint8Array([1]), { workerUrl: '/broken.js' });
      MockWorker.instances[0].emit('error', {});

      await expect(promise).rejects.toThrow('could not load worker script at /broken.js');
    });
  });

  describe('Bounded worker concurrency', () => {
    it('should queue calls beyond maxConcurrentWorkers and reuse free slots', async () => {
      const firstBlob = new Blob(['a']);
      const secondBlob = new Blob(['b']);

      const p1 = convertHeicInWorker(new Uint8Array([1]), {
        workerUrl: '/worker.js',
        maxConcurrentWorkers: 1,
      });
      const p2 = convertHeicInWorker(new Uint8Array([2]), {
        workerUrl: '/worker.js',
        maxConcurrentWorkers: 1,
      });

      // Second call must wait for the only slot instead of spawning a worker.
      expect(MockWorker.instances).toHaveLength(1);

      MockWorker.instances[0].emit('message', { data: { type: 'result', ok: true, blob: firstBlob } });
      await expect(p1).resolves.toBe(firstBlob);

      // Slot freed: the queued call now constructs its worker.
      await vi.waitFor(() => expect(MockWorker.instances).toHaveLength(2));
      MockWorker.instances[1].emit('message', {
        data: { type: 'result', ok: true, blob: secondBlob },
      });
      await expect(p2).resolves.toBe(secondBlob);
    });

    it('should release the slot when a queued call times out before it was granted', async () => {
      const p1 = convertHeicInWorker(new Uint8Array([1]), {
        workerUrl: '/worker.js',
        maxConcurrentWorkers: 1,
      });
      const p2 = convertHeicInWorker(new Uint8Array([2]), {
        workerUrl: '/worker.js',
        maxConcurrentWorkers: 1,
        timeoutMs: 5,
      });

      // p2 times out while still queued behind p1.
      await expect(p2).rejects.toThrow('timed out');

      // p3 queues behind p1; when p1 settles, the slot must go to p3 (a
      // leaked cancelled queue entry would hang it instead).
      const p3 = convertHeicInWorker(new Uint8Array([3]), {
        workerUrl: '/worker.js',
        maxConcurrentWorkers: 1,
        timeoutMs: 100,
      });
      expect(MockWorker.instances).toHaveLength(1); // p3 still queued

      MockWorker.instances[0].emit('message', { data: { type: 'result', ok: true, blob: new Blob(['y']) } });
      await expect(p1).resolves.toBeInstanceOf(Blob);

      await vi.waitFor(() => expect(MockWorker.instances).toHaveLength(2));
      MockWorker.instances[1].emit('message', { data: { type: 'result', ok: true, blob: new Blob(['x']) } });
      await expect(p3).resolves.toBeInstanceOf(Blob);
    });
  });

  describe('Default timeout', () => {
    it('should apply a 60s default timeout', async () => {
      vi.useFakeTimers();
      try {
        const promise = convertHeicInWorker(new Uint8Array([1]), { workerUrl: '/worker.js' });
        // Attach the rejection handler immediately: the fake-timer flush
        // rejects the promise before the assertion below would attach one,
        // which Node reports as an unhandled rejection in the meantime.
        const settled = promise.then(
          () => null,
          (error: Error) => error
        );

        await vi.advanceTimersByTimeAsync(59_000);
        expect(MockWorker.instances[0].terminated).toBe(false);

        await vi.advanceTimersByTimeAsync(2_000);
        expect(await settled).toBeInstanceOf(Error);
        expect((await settled)!.message).toContain('timed out after 60000ms');
        expect(MockWorker.instances[0].terminated).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});

/**
 * Direct unit tests for the per-URL worker-slot semaphore. These exercise
 * state-machine branches (double release, cancelled/ignored grants) that the
 * public API cannot reach, via the @internal test hooks.
 */
describe('worker slot semaphore (internal hooks)', () => {
  const { reserveWorkerSlot, workerSlots } = __semaphoreTestHooks;
  const KEY = 'semaphore-test-key';

  afterEach(() => {
    workerSlots.clear();
  });

  it('grants immediately when below the cap and prunes the entry when idle', () => {
    let captured: (() => void) | undefined;
    reserveWorkerSlot(KEY, 1, (release) => {
      captured = release;
    });
    expect(workerSlots.get(KEY)?.active).toBe(1);

    captured!();
    expect(workerSlots.has(KEY)).toBe(false);
  });

  it('is a no-op on double release', () => {
    const releases: Array<() => void> = [];
    reserveWorkerSlot(KEY, 2, (release) => releases.push(release));
    reserveWorkerSlot(KEY, 2, (release) => releases.push(release));
    expect(workerSlots.get(KEY)?.active).toBe(2);

    releases[0]();
    releases[0](); // second release must not decrement again
    expect(workerSlots.get(KEY)?.active).toBe(1);
  });

  it('queues beyond the cap and drains in order', () => {
    const order: number[] = [];
    const releases: Array<() => void> = [];
    reserveWorkerSlot(KEY, 1, (release) => {
      order.push(0);
      releases.push(release);
    });
    reserveWorkerSlot(KEY, 1, (release) => {
      order.push(1);
      releases.push(release);
    });
    expect(order).toEqual([0]);

    releases[0](); // drains the queued reservation synchronously
    expect(order).toEqual([0, 1]);
    releases[1]();
    expect(workerSlots.has(KEY)).toBe(false);
  });

  it('drops a queued reservation released before it starts', () => {
    const releases: Array<() => void> = [];
    reserveWorkerSlot(KEY, 1, (release) => releases.push(release));
    const releaseQueued = reserveWorkerSlot(KEY, 1, (release) => releases.push(release));
    expect(workerSlots.get(KEY)?.waiters).toHaveLength(1);

    releaseQueued(); // cancelled while still queued
    expect(workerSlots.get(KEY)?.waiters).toHaveLength(0);

    releases[0](); // queued reservation must not start
    expect(releases).toHaveLength(1);
    expect(workerSlots.has(KEY)).toBe(false);
  });

  it('tolerates release after its grant was already dequeued', () => {
    let releaseFirst: (() => void) | undefined;
    reserveWorkerSlot(KEY, 1, (release) => {
      releaseFirst = release;
    });
    const releaseQueued = reserveWorkerSlot(KEY, 1, () => {
      throw new Error('must not start');
    });
    workerSlots.get(KEY)!.waiters.length = 0; // grant no longer in line
    expect(() => releaseQueued()).not.toThrow();
    expect(workerSlots.get(KEY)?.active).toBe(1);
    releaseFirst!();
  });

  it('ignores a grant invoked after its release', () => {
    let started = false;
    const release = reserveWorkerSlot(KEY, 0, () => {
      started = true;
    });
    const queuedGrant = workerSlots.get(KEY)!.waiters[0];

    release();
    queuedGrant(); // must be ignored
    expect(started).toBe(false);
  });
});

describe('defaultMaxWorkers', () => {
  const { defaultMaxWorkers } = __semaphoreTestHooks;
  let originalNavigator: PropertyDescriptor | undefined;

  beforeEach(() => {
    originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  });

  afterEach(() => {
    if (originalNavigator) {
      Object.defineProperty(globalThis, 'navigator', originalNavigator);
    } else {
      delete (globalThis as { navigator?: unknown }).navigator;
    }
  });

  function withNavigator(value: unknown, assert: () => void): void {
    Object.defineProperty(globalThis, 'navigator', { value, configurable: true });
    try {
      assert();
    } finally {
      if (originalNavigator) {
        Object.defineProperty(globalThis, 'navigator', originalNavigator);
      } else {
        delete (globalThis as { navigator?: unknown }).navigator;
      }
    }
  }

  it('clamps hardwareConcurrency to 1-8', () => {
    withNavigator({ hardwareConcurrency: 2 }, () => expect(defaultMaxWorkers()).toBe(2));
    withNavigator({ hardwareConcurrency: 99 }, () => expect(defaultMaxWorkers()).toBe(8));
    withNavigator({ hardwareConcurrency: 0 }, () => expect(defaultMaxWorkers()).toBe(1));
  });

  it('falls back to 4 without a numeric core count', () => {
    withNavigator({}, () => expect(defaultMaxWorkers()).toBe(4));
    withNavigator({ hardwareConcurrency: 'many' }, () => expect(defaultMaxWorkers()).toBe(4));
    withNavigator(undefined, () => expect(defaultMaxWorkers()).toBe(4));
  });
});

describe('convertHeicInWorker - cancellation and output shapes', () => {
  let originalWorker: typeof Worker;

  beforeEach(() => {
    originalWorker = globalThis.Worker;
    MockWorker.instances.length = 0;
    MockWorker.constructionError = null;
    MockWorker.postError = null;
    globalThis.Worker = MockWorker as unknown as typeof Worker;
  });

  afterEach(() => {
    globalThis.Worker = originalWorker;
  });

  it('rejects an already-aborted signal with aborted and never constructs a worker', async () => {
    const controller = new AbortController();
    controller.abort();

    const error = await convertHeicInWorker(new Uint8Array([1]), {
      workerUrl: '/abort-early.js',
      signal: controller.signal,
    }).catch((e) => e);

    expect(error).toMatchObject({ code: 'aborted' });
    expect(MockWorker.instances).toHaveLength(0);
  });

  it('rejects a malformed signal with invalid_input before constructing a worker', async () => {
    const error = await convertHeicInWorker(new Uint8Array([1]), {
      workerUrl: '/abort-badsignal.js',
      signal: {} as unknown as AbortSignal,
    }).catch((e) => e);

    expect(error).toMatchObject({ code: 'invalid_input' });
    expect(MockWorker.instances).toHaveLength(0);
  });

  it('terminates the worker and rejects with aborted when the signal fires mid-flight', async () => {
    const controller = new AbortController();
    const promise = convertHeicInWorker(new Uint8Array([1]), {
      workerUrl: '/abort-mid.js',
      signal: controller.signal,
    });

    controller.abort();

    const error = await promise.catch((e) => e);
    expect(error).toMatchObject({ code: 'aborted' });
    expect(MockWorker.instances[0].terminated).toBe(true);
  });

  it('does not post the (non-cloneable) signal to the worker', async () => {
    const controller = new AbortController();
    const promise = convertHeicInWorker(new Uint8Array([1]), {
      workerUrl: '/abort-post.js',
      signal: controller.signal,
      to: 'png',
    });

    const worker = MockWorker.instances[0];
    const posted = worker.posted[0] as { options: Record<string, unknown> };
    expect(posted.options).toEqual({ to: 'png' });

    worker.emit('message', { data: { type: 'result', ok: true, blob: new Blob() } });
    await promise;
  });

  it('resolves with a data URL string when the worker was told to emit dataUrl', async () => {
    const promise = convertHeicInWorker(new Uint8Array([1]), {
      workerUrl: '/out-dataurl.js',
      output: 'dataUrl',
    });

    MockWorker.instances[0].emit('message', {
      data: { type: 'result', ok: true, blob: 'data:image/png;base64,AAAA' },
    });

    await expect(promise).resolves.toBe('data:image/png;base64,AAAA');
  });

  it('resolves with an ArrayBuffer when the worker was told to emit arrayBuffer', async () => {
    const promise = convertHeicInWorker(new Uint8Array([1]), {
      workerUrl: '/out-arraybuffer.js',
      output: 'arrayBuffer',
    });

    const bytes = new ArrayBuffer(4);
    MockWorker.instances[0].emit('message', {
      data: { type: 'result', ok: true, blob: bytes },
    });

    await expect(promise).resolves.toBe(bytes);
  });
});

describe('convertManyInWorker', () => {
  let originalWorker: typeof Worker;
  let urlSeq = 0;

  const uniqueUrl = () => `/many-${urlSeq++}.js`;

  const emitResult = (worker: MockWorker, blob: Blob) =>
    worker.emit('message', { data: { type: 'result', ok: true, blob } });
  const emitFailure = (worker: MockWorker, error: string) =>
    worker.emit('message', { data: { type: 'result', ok: false, error } });

  beforeEach(() => {
    originalWorker = globalThis.Worker;
    MockWorker.instances.length = 0;
    MockWorker.constructionError = null;
    MockWorker.postError = null;
    globalThis.Worker = MockWorker as unknown as typeof Worker;
  });

  afterEach(() => {
    globalThis.Worker = originalWorker;
  });

  it('converts all inputs in input order with bounded concurrency', async () => {
    const blob = new Blob(['x'], { type: 'image/png' });
    const promise = convertManyInWorker(
      [new Uint8Array([1]), new Uint8Array([2]), new Uint8Array([3])],
      { workerUrl: uniqueUrl(), maxConcurrentWorkers: 2 }
    );

    // Two items start immediately; the third waits for a runner to free up.
    expect(MockWorker.instances).toHaveLength(2);

    emitResult(MockWorker.instances[0], blob);
    // The runner claims the queued item after the awaited promise settles
    // (microtask hops), so flush before observing the third worker.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(MockWorker.instances).toHaveLength(3);
    emitResult(MockWorker.instances[1], blob);
    emitResult(MockWorker.instances[2], blob);

    const results = await promise;
    expect(results).toHaveLength(3);
    expect(results[0]).toBe(blob);
    expect(results[2]).toBe(blob);
  });

  it('rejects with batch_item_failed naming the failing item', async () => {
    const promise = convertManyInWorker([new Uint8Array([1]), new Uint8Array([2])], {
      workerUrl: uniqueUrl(),
      maxConcurrentWorkers: 2,
    });

    emitResult(MockWorker.instances[0], new Blob(['a']));
    emitFailure(MockWorker.instances[1], 'corrupt HEIC');

    const error = await promise.catch((e) => e);
    expect(error).toMatchObject({ code: 'batch_item_failed', itemIndex: 1, itemTotal: 2 });
    expect(error.message).toContain('corrupt HEIC');
    expect(MockWorker.instances[1].terminated).toBe(true);
  });

  it('continueOnError fulfills with per-item ok/error entries', async () => {
    const blob = new Blob(['a'], { type: 'image/png' });
    const onProgress = vi.fn();
    const promise = convertManyInWorker([new Uint8Array([1]), new Uint8Array([2])], {
      workerUrl: uniqueUrl(),
      maxConcurrentWorkers: 2,
      continueOnError: true,
      onProgress,
    });

    emitResult(MockWorker.instances[0], blob);
    emitFailure(MockWorker.instances[1], 'one bad file');

    const results = await promise;
    expect(results[0]).toMatchObject({ index: 0, ok: true });
    expect((results[0] as { result: Blob }).result).toBe(blob);
    expect(results[1]).toMatchObject({ index: 1, ok: false });
    expect((results[1] as { error: { code: string } }).error.code).toBe('worker_failed');
    // Progress fired only for the successful item.
    expect(onProgress).toHaveBeenCalledWith(0, 100);
    expect(onProgress.mock.calls.every(([index]) => index === 0)).toBe(true);
  });

  it('forwards per-item progress as (index, percent)', async () => {
    const onProgress = vi.fn();
    const promise = convertManyInWorker([new Uint8Array([1]), new Uint8Array([2])], {
      workerUrl: uniqueUrl(),
      maxConcurrentWorkers: 2,
      onProgress,
    });

    MockWorker.instances[1].emit('message', { data: { type: 'progress', percent: 40 } });
    expect(onProgress).toHaveBeenCalledWith(1, 40);

    emitResult(MockWorker.instances[0], new Blob(['a']));
    emitResult(MockWorker.instances[1], new Blob(['b']));
    await promise;

    expect(onProgress).toHaveBeenCalledWith(0, 100);
    expect(onProgress).toHaveBeenCalledWith(1, 100);
  });

  it('strips batch-only, worker-only, and non-cloneable options from the post payload', async () => {
    const controller = new AbortController();
    const promise = convertManyInWorker([new Uint8Array([1])], {
      workerUrl: uniqueUrl(),
      workerType: 'module',
      maxConcurrentWorkers: 2,
      timeoutMs: 5000,
      continueOnError: true,
      signal: controller.signal,
      onProgress: vi.fn(),
      to: 'webp',
      output: 'dataUrl',
      quality: 0.5,
    });

    const posted = MockWorker.instances[0].posted[0] as { options: Record<string, unknown> };
    expect(posted.options).toEqual({ to: 'webp', output: 'dataUrl', quality: 0.5 });

    emitResult(MockWorker.instances[0], new Blob(['a']));
    await promise;
  });

  it('applies the output shape inside the worker (dataUrl results pass through)', async () => {
    const promise = convertManyInWorker([new Uint8Array([1]), new Uint8Array([2])], {
      workerUrl: uniqueUrl(),
      maxConcurrentWorkers: 2,
      output: 'dataUrl',
    });

    emitResult(MockWorker.instances[0], 'data:image/png;base64,AAA' as never);
    emitResult(MockWorker.instances[1], 'data:image/png;base64,BBB' as never);

    const results = await promise;
    expect(results).toEqual(['data:image/png;base64,AAA', 'data:image/png;base64,BBB']);
  });

  it('rejects mid-batch abort with aborted and terminates active workers', async () => {
    const controller = new AbortController();
    const promise = convertManyInWorker(
      [new Uint8Array([1]), new Uint8Array([2]), new Uint8Array([3])],
      { workerUrl: uniqueUrl(), maxConcurrentWorkers: 2, signal: controller.signal }
    );

    controller.abort();

    const error = await promise.catch((e) => e);
    expect(error).toMatchObject({ code: 'aborted' });
    expect(MockWorker.instances[0].terminated).toBe(true);
    expect(MockWorker.instances[1].terminated).toBe(true);
  });

  it.each([
    ['quality 5', { quality: 5 }, 'invalid_quality'],
    ['bogus output', { output: 'bogus' }, 'invalid_input'],
    ['injected decoder', { decoder: {} }, 'invalid_input'],
    ['bad continueOnError', { continueOnError: 'yes' }, 'invalid_input'],
    ['malformed crop', { crop: { x: 0, y: 0, width: 0, height: 5 } }, 'invalid_crop'],
    ['malformed signal', { signal: {} }, 'invalid_input'],
  ] as Array<[string, Record<string, unknown>, string]>)(
    'validates %s up front without constructing a worker',
    async (_label, extra, code) => {
      const error = await convertManyInWorker([new Uint8Array([1])], {
        workerUrl: uniqueUrl(),
        ...extra,
      } as never).catch((e) => e);
      expect(error).toMatchObject({ code });
      expect(MockWorker.instances).toHaveLength(0);
    }
  );

  it('rejects non-array inputs with invalid_input', async () => {
    const error = await convertManyInWorker('not-an-array' as never, {
      workerUrl: uniqueUrl(),
    }).catch((e) => e);
    expect(error).toMatchObject({ code: 'invalid_input' });
    expect(error.message).toContain('array');
  });

  it('rejects with worker_unsupported when Worker is unavailable', async () => {
    globalThis.Worker = undefined as unknown as typeof Worker;

    const error = await convertManyInWorker([new Uint8Array([1])], {
      workerUrl: uniqueUrl(),
    }).catch((e) => e);
    expect(error).toMatchObject({ code: 'worker_unsupported' });
  });
});

describe('worker entry-point validation (main thread)', () => {
  let originalWorker: typeof Worker;

  beforeEach(() => {
    originalWorker = globalThis.Worker;
    globalThis.Worker = MockWorker as unknown as typeof Worker;
    MockWorker.instances = [];
    MockWorker.constructionError = null;
    MockWorker.postError = null;
  });

  afterEach(() => {
    globalThis.Worker = originalWorker;
  });

  const input = () => new Uint8Array([1]);
  let validateUrlSeq = 0;
  const validateUrl = () => `/validate-${validateUrlSeq++}.js`;

  const cases: Array<[string, Record<string, unknown>, string]> = [
    ['out-of-range quality', { quality: 5 }, 'invalid_quality'],
    ['unknown format', { to: 'tiff' }, 'invalid_format'],
    ['unknown output shape', { output: 'json' }, 'invalid_input'],
    ['zero-width crop', { crop: { x: 0, y: 0, width: 0, height: 1 } }, 'invalid_crop'],
    ['non-boolean preserveExif', { preserveExif: 'yes' }, 'invalid_input'],
    ['non-positive scale', { scale: 0 }, 'invalid_resize'],
    ['fractional maxConcurrentWorkers', { maxConcurrentWorkers: 1.5 }, 'invalid_concurrency'],
    ['negative timeoutMs', { timeoutMs: -5 }, 'invalid_input'],
  ];

  it.each(cases)('convertHeicInWorker rejects %s on the main thread', async (_label, options, code) => {
    const error = await convertHeicInWorker(input(), {
      workerUrl: validateUrl(),
      ...options,
    } as never).catch((e) => e);
    expect(error).toMatchObject({ code });
    expect(MockWorker.instances).toHaveLength(0);
  });

  it.each(cases)('convertManyInWorker rejects %s on the main thread', async (_label, options, code) => {
    const error = await convertManyInWorker([input()], {
      workerUrl: validateUrl(),
      ...options,
    } as never).catch((e) => e);
    expect(error).toMatchObject({ code });
    expect(MockWorker.instances).toHaveLength(0);
  });

  it('timeoutMs: 0 (disabled) is accepted', async () => {
    // No timeout scheduled and no reply from the mock worker: the call
    // stays pending by design — validation is what this test pins.
    void convertHeicInWorker(input(), { workerUrl: validateUrl(), timeoutMs: 0 }).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(MockWorker.instances).toHaveLength(1);
  });
});

describe('reserveWorkerSlot (semaphore)', () => {
  afterEach(() => {
    __semaphoreTestHooks.workerSlots.clear();
  });

  it('cancelling a queued waiter never grants past max', () => {
    const { reserveWorkerSlot, workerSlots } = __semaphoreTestHooks;
    const key = 'semaphore-cancel-queued';
    const granted: number[] = [];
    const done: Array<() => void> = [];

    const releaseA = reserveWorkerSlot(key, 1, (finish) => {
      granted.push(1);
      done.push(finish);
    });
    const releaseB = reserveWorkerSlot(key, 1, (finish) => {
      granted.push(2);
      done.push(finish);
    });
    const releaseC = reserveWorkerSlot(key, 1, (finish) => {
      granted.push(3);
      done.push(finish);
    });

    expect(granted).toEqual([1]); // B and C queued behind A

    releaseB(); // cancelled while queued: no slot was freed, nobody may start
    expect(granted).toEqual([1]);

    releaseA(); // A's real release hands the single slot to the next waiter
    expect(granted).toEqual([1, 3]);

    releaseC(); // C was granted by A's hand-off; now it finishes and the
    // emptied slot entry is collected.
    expect(granted).toEqual([1, 3]);
    expect(workerSlots.has(key)).toBe(false);
  });

  it('release is idempotent', () => {
    const { reserveWorkerSlot, workerSlots } = __semaphoreTestHooks;
    const key = 'semaphore-idempotent';
    const done: Array<() => void> = [];
    const release = reserveWorkerSlot(key, 1, (finish) => done.push(finish));
    expect(workerSlots.get(key)?.active).toBe(1);
    release();
    release();
    expect(workerSlots.get(key)?.active ?? 0).toBe(0);
    expect(workerSlots.has(key)).toBe(false);
  });
});
