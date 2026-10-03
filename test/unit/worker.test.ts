import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { convertHeicInWorker } from '../../src/worker';

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

    await expect(promise).rejects.toThrow('boom');
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

    await expect(promise).rejects.toThrow('deserialization failed');
    expect(worker.terminated).toBe(true);
  });

  it('should reject with the raw detail when messageerror carries a non-Error value', async () => {
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

    expect(onProgress).toHaveBeenCalledWith(100);
    expect(onProgress).toHaveBeenCalledWith(50);
    expect(onProgress).toHaveBeenCalledWith(0);

    worker.emit('message', { data: { type: 'result', ok: true, blob: new Blob() } });
    await promise;
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

    await expect(promise).rejects.toThrow('progress handler crashed');
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

    await expect(promise).rejects.toThrow('boom');
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
