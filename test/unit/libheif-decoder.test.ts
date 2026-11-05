import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LibheifDecoder } from '../../src/wasm/wrapper';
import { isDecoderPoisoned } from '../../src/wasm/fault';
import { HeicConverterError } from '../../src/errors';

/**
 * Mocked glue for the raw C ABI in `build-wasm/wrapper/main.cpp`.
 *
 * - Tests express decode outcomes as JS objects; the mock `_heic_decode`
 *   serializes them into a fake heap the way the C++ does — 36-byte
 *   `DecodeResult` header (nine 4-byte little-endian fields), stride-aware
 *   plane rows, exif/error payloads — so `wrapper.ts`'s DataView reads,
 *   JS-side copies, and the post-decode `HEAPU8` re-read are all tested.
 * - The struct ABI narrows what the mock can express, and that IS the
 *   contract: orientation is int32 by construction (`DataView.getInt32`)
 *   and exif is pointer+length, so non-numeric orientation values and
 *   non-byte-array exif fields are unreachable and untested. Out-of-range
 *   ints, short blocks, error strings, and null results stay under test.
 */

const INPUT_SLOT = 16; // `_malloc` always hands out this address

const mockState = vi.hoisted(() => {
  const INITIAL_HEAP = 64 * 1024;
  const RESERVE = 256; // mock-allocated payloads never touch the input slot
  const HEADER = 36;
  const INPUT = 16;

  interface Success {
    width: number;
    height: number;
    data?: Uint8Array;
    orientation?: number;
    stride?: number;
    exif?: Uint8Array;
  }

  const state = {
    heap: new Uint8Array(INITIAL_HEAP),
    cursor: RESERVE,
    lastResultPtr: 0,
    decode: vi.fn(),
    malloc: vi.fn((): number => INPUT),
    free: vi.fn(),
    heicDecode: vi.fn(),
    resultFree: vi.fn(),
    module: {} as Record<string, unknown>,
    reset: (): void => undefined,
    defaultHeicDecode: null as unknown as (ptr: number, len: number) => number, // real mock assigned below
  };

  const ensure = (bytes: number): void => {
    if (bytes <= state.heap.length) {
      return;
    }
    // `ALLOW_MEMORY_GROWTH` simulation: a NEW buffer with the old bytes kept,
    // and `module.HEAPU8` re-pointed — `wrapper.ts` MUST re-read it after decode.
    let size = state.heap.length;
    while (size < bytes) size *= 2;
    const grown = new Uint8Array(size);
    grown.set(state.heap);
    state.heap = grown;
    state.module.HEAPU8 = grown;
  };

  const alloc = (n: number): number => {
    const at = state.cursor;
    ensure(at + n);
    state.cursor = (at + n + 3) & ~3; // keep the cursor 4-aligned for `DataView`
    return at;
  };

  const writeHeader = (f: {
    width: number;
    height: number;
    orientation: number;
    plane: number;
    stride: number;
    exif: number;
    exifLen: number;
    error: number;
    errorLen: number;
  }): number => {
    const at = alloc(HEADER);
    const view = new DataView(state.heap.buffer, at, HEADER);
    view.setInt32(0, f.width, true);
    view.setInt32(4, f.height, true);
    view.setInt32(8, f.orientation, true);
    view.setUint32(12, f.plane, true);
    view.setUint32(16, f.stride, true);
    view.setUint32(20, f.exif, true);
    view.setUint32(24, f.exifLen, true);
    view.setUint32(28, f.error, true);
    view.setUint32(32, f.errorLen, true);
    return at;
  };

  const defaultHeicDecode = (ptr: number, len: number): number => {
    const bytes = state.heap.slice(ptr, ptr + len);
    // Read the slot fresh on every fire: the wrapper nulls it mid-decode to
    // stop the remaining events after a host throw.
    const fire = (percent: number): void => {
      const cb = state.module.__progressCb as ((p: number) => void) | null;
      cb?.(percent);
    };
    const outcome = state.decode(bytes, fire) as Success | string | null | undefined;
    if (outcome === null || outcome === undefined) {
      return 0; // the C++ only returns null when even the result alloc fails
    }
    if (typeof outcome === 'string') {
      const msg = new TextEncoder().encode(outcome);
      const at = msg.length > 0 ? alloc(msg.length) : 0;
      if (msg.length > 0) state.heap.set(msg, at);
      state.lastResultPtr = writeHeader({
        width: 0,
        height: 0,
        orientation: 0,
        plane: 0,
        stride: 0,
        exif: 0,
        exifLen: 0,
        error: at,
        errorLen: msg.length,
      });
      return state.lastResultPtr;
    }
    const rowBytes = outcome.width * 4;
    const stride = outcome.stride ?? rowBytes;
    let plane = 0;
    if (outcome.data && outcome.data.length > 0) {
      plane = alloc(stride * outcome.height);
      if (stride === rowBytes) {
        state.heap.set(outcome.data, plane);
      } else {
        for (let y = 0; y < outcome.height; y++) {
          state.heap.set(outcome.data.subarray(y * rowBytes, (y + 1) * rowBytes), plane + y * stride);
        }
      }
    }
    let exif = 0;
    let exifLen = 0;
    if (outcome.exif && outcome.exif.length > 0) {
      exif = alloc(outcome.exif.length);
      exifLen = outcome.exif.length;
      state.heap.set(outcome.exif, exif);
    }
    state.lastResultPtr = writeHeader({
      width: outcome.width,
      height: outcome.height,
      orientation: outcome.orientation ?? 1,
      plane,
      stride,
      exif,
      exifLen,
      error: 0,
      errorLen: 0,
    });
    return state.lastResultPtr;
  };

  state.heicDecode = vi.fn(defaultHeicDecode);
  state.defaultHeicDecode = defaultHeicDecode;
  state.module = {
    _malloc: state.malloc,
    _free: state.free,
    _heic_decode: state.heicDecode,
    _heic_result_free: state.resultFree,
    HEAPU8: state.heap,
    __progressCb: null,
  };
  state.reset = (): void => {
    state.heap = new Uint8Array(INITIAL_HEAP);
    state.cursor = RESERVE;
    state.lastResultPtr = 0;
    state.module.HEAPU8 = state.heap;
    state.module.__progressCb = null;
  };

  return { state, factory: vi.fn() };
});

vi.mock('../../src/wasm/wrapper/heic-decoder.js', () => ({
  default: mockState.factory,
}));

describe('LibheifDecoder (mocked glue)', () => {
  // Smallest valid WASM module (magic + version): the wrapper compiles
  // `wasmBinary` now, so option tests need real bytes, not an `ArrayBuffer` stub.
  const MINIMAL_WASM = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);

  beforeEach(() => {
    mockState.factory.mockReset();
    mockState.factory.mockResolvedValue(mockState.state.module);
    mockState.state.reset();
    mockState.state.decode.mockReset();
    mockState.state.malloc.mockReset();
    mockState.state.malloc.mockImplementation(() => INPUT_SLOT);
    mockState.state.free.mockReset();
    mockState.state.heicDecode.mockReset();
    mockState.state.heicDecode.mockImplementation(mockState.state.defaultHeicDecode);
    mockState.state.resultFree.mockReset();
  });

  describe('Initialization', () => {
    it('should create module without options', async () => {
      const decoder = new LibheifDecoder();
      await decoder.initialize();

      expect(mockState.factory).toHaveBeenCalledWith({});
    });

    it('should create module with wasmBinary option', async () => {
      const decoder = new LibheifDecoder({ wasmBinary: MINIMAL_WASM });
      await decoder.initialize();

      // Emscripten >=4 glue ignores `Module.wasmBinary`; the wrapper supplies
      // the bytes via `instantiateWasm`.
      expect(mockState.factory).toHaveBeenCalledWith({
        instantiateWasm: expect.any(Function),
      });
    });

    it('should create module with locateFile option', async () => {
      const locateFile = (path: string) => `https://cdn.example.com/${path}`;
      const decoder = new LibheifDecoder({ locateFile });
      await decoder.initialize();

      expect(mockState.factory).toHaveBeenCalledWith({ locateFile });
    });

    it('should create module with both options', async () => {
      const locateFile = (path: string) => `https://cdn.example.com/${path}`;
      const decoder = new LibheifDecoder({ wasmBinary: MINIMAL_WASM, locateFile });
      await decoder.initialize();

      expect(mockState.factory).toHaveBeenCalledWith({
        instantiateWasm: expect.any(Function),
        locateFile,
      });
    });

    it('should not reinitialize if already initialized', async () => {
      const decoder = new LibheifDecoder();
      await decoder.initialize();
      await decoder.initialize();

      expect(mockState.factory).toHaveBeenCalledTimes(1);
    });

    it('should not instantiate the module twice for concurrent initialize calls', async () => {
      const decoder = new LibheifDecoder();
      await Promise.all([decoder.initialize(), decoder.initialize()]);

      expect(mockState.factory).toHaveBeenCalledTimes(1);
    });

    it('should allow retrying after module initialization fails', async () => {
      mockState.factory
        .mockRejectedValueOnce(new Error('fetch failed'))
        .mockResolvedValueOnce(mockState.state.module);

      const decoder = new LibheifDecoder();
      await expect(decoder.initialize()).rejects.toThrow('fetch failed');

      await decoder.initialize();
      expect(mockState.factory).toHaveBeenCalledTimes(2);
    });
  });

  describe('Decoding', () => {
    it('should decode valid HEIC data successfully', async () => {
      const mockData = new Uint8Array([1, 2, 3, 4]);
      mockState.state.decode.mockReturnValue({
        width: 100,
        height: 100,
        data: new Uint8Array(100 * 100 * 4),
      });

      const decoder = new LibheifDecoder();
      await decoder.initialize();
      const result = await decoder.decode(mockData);

      expect(result.width).toBe(100);
      expect(result.height).toBe(100);
      expect(result.data).toBeInstanceOf(Uint8ClampedArray);
      // The mock reads the upload back out of the heap, so the C++ sees the
      // bytes the wrapper wrote.
      expect(mockState.state.decode.mock.calls[0][0]).toEqual(mockData);
    });

    it('should call onProgress callback during decode', async () => {
      mockState.state.decode.mockImplementation(
        (_data: Uint8Array, fire: (percent: number) => void) => {
          fire(50);
          return { width: 100, height: 100, data: new Uint8Array(100 * 100 * 4) };
        }
      );

      const progressCallback = vi.fn();
      const decoder = new LibheifDecoder();
      await decoder.initialize();
      await decoder.decode(new Uint8Array([1, 2, 3, 4]), progressCallback);

      expect(progressCallback).toHaveBeenCalledWith(50);
    });

    it('should fault the decoder when _heic_decode returns a null result', async () => {
      const mockData = new Uint8Array([1, 2, 3, 4]);
      mockState.state.decode.mockReturnValue(null);

      const decoder = new LibheifDecoder();
      await decoder.initialize();
      const error = await decoder.decode(mockData).catch((e) => e);

      // A null result means even the C++ result allocation failed — broken
      // module, same class as a trap: typed error, poisoned instance.
      expect(error).toBeInstanceOf(HeicConverterError);
      expect(error.code).toBe('decode_failed');
      expect(isDecoderPoisoned(decoder)).toBe(true);
      expect(mockState.state.resultFree).not.toHaveBeenCalled();
      expect(mockState.state.free).toHaveBeenCalledWith(INPUT_SLOT);
    });

    it('should throw error when decode returns error string', async () => {
      mockState.state.decode.mockReturnValue('Invalid HEIC format');

      const decoder = new LibheifDecoder();
      await decoder.initialize();

      await expect(decoder.decode(new Uint8Array([1, 2, 3, 4]))).rejects.toThrow(
        'HEIC decoding failed: Invalid HEIC format'
      );
    });

    it('should fall back to the no-detail message when the error struct carries no bytes', async () => {
      // `width=0` with `error=0`/`error_len=0` (C++ make_error on an empty
      // message): still a decode failure, just without sanitizable detail.
      mockState.state.decode.mockReturnValue('');

      const decoder = new LibheifDecoder();
      await decoder.initialize();

      await expect(decoder.decode(new Uint8Array([1, 2, 3, 4]))).rejects.toThrow(
        'HEIC decoding failed (no result returned;'
      );
    });

    it('should clamp an oversized decoder error detail to 200 characters', async () => {
      // Decoder strings reach `error.message` (logs, demo DOM): oversized
      // details clamp to 200 chars with an ellipsis, control chars stripped.
      const mockData = new Uint8Array([1, 2, 3, 4]);
      mockState.state.decode.mockReturnValue(`heif: ${'x'.repeat(300)} trailing`);

      const decoder = new LibheifDecoder();
      await decoder.initialize();

      const error = await decoder.decode(mockData).catch((e) => e);
      expect(error).toBeInstanceOf(HeicConverterError);
      // Full template: `HEIC decoding failed: ${detail} (input: ${bytes} bytes)`.
      const prefix = 'HEIC decoding failed: ';
      const suffix = ` (input: ${mockData.byteLength} bytes)`;
      expect(error.message.startsWith(prefix)).toBe(true);
      expect(error.message.endsWith(suffix)).toBe(true);
      const detail = error.message.slice(prefix.length, -suffix.length);
      expect(detail).toHaveLength(200);
      expect(detail.endsWith('...')).toBe(true);
      // Matching control characters *is* the point: asserting the strip step.
      // eslint-disable-next-line no-control-regex
      expect(detail).not.toMatch(/[\u0000\u0007]/);
    });

    it('should auto-initialize if not initialized before decode', async () => {
      mockState.state.decode.mockReturnValue({
        width: 100,
        height: 100,
        data: new Uint8Array(100 * 100 * 4),
      });

      const decoder = new LibheifDecoder();
      await decoder.decode(new Uint8Array([1, 2, 3, 4]));

      expect(mockState.factory).toHaveBeenCalledTimes(1);
    });

    it('should convert result data to Uint8ClampedArray', async () => {
      const rawData = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255]);
      mockState.state.decode.mockReturnValue({ width: 2, height: 1, data: rawData });

      const decoder = new LibheifDecoder();
      await decoder.initialize();
      const result = await decoder.decode(new Uint8Array([1, 2, 3, 4]));

      expect(result.data).toBeInstanceOf(Uint8ClampedArray);
      expect(result.data[0]).toBe(255);
      expect(result.data[1]).toBe(0);
      expect(result.data[2]).toBe(0);
      expect(result.data[3]).toBe(255);
    });

    it('should return an independent copy of decoded pixels, not a heap view', async () => {
      mockState.state.decode.mockReturnValue({
        width: 1,
        height: 1,
        data: new Uint8Array([9, 8, 7, 6]),
      });

      const decoder = new LibheifDecoder();
      await decoder.initialize();
      const result = await decoder.decode(new Uint8Array([1, 2, 3, 4]));

      // The plane lives in the mock heap until `_heic_result_free`; the copy
      // the wrapper takes must own its buffer.
      expect(result.data.buffer).not.toBe(mockState.state.heap.buffer);
      // Later glue-side writes cannot corrupt the caller's pixels.
      mockState.state.heap.fill(0);
      expect(Array.from(result.data)).toEqual([9, 8, 7, 6]);
    });
  });

  describe('Freeing resources', () => {
    it('should drop the module so the next initialize loads a fresh one', async () => {
      const decoder = new LibheifDecoder();
      await decoder.initialize();

      decoder.free();
      await decoder.initialize();

      expect(mockState.factory).toHaveBeenCalledTimes(2);
    });

    it('should handle multiple free calls gracefully', async () => {
      const decoder = new LibheifDecoder();
      await decoder.initialize();

      decoder.free();
      decoder.free();

      expect(mockState.factory).toHaveBeenCalledTimes(1);
    });

    it('should allow creating new decoder after free', async () => {
      const decoder1 = new LibheifDecoder();
      await decoder1.initialize();
      decoder1.free();

      const decoder2 = new LibheifDecoder();
      await decoder2.initialize();

      expect(mockState.factory).toHaveBeenCalledTimes(2);
    });
  });

  describe('Edge cases', () => {
    it('should handle empty Uint8Array input', async () => {
      // The wrapper uploads the (empty) bytes and lets the C++ decide; the
      // default mock outcome (null result) must still surface as a throw.
      const decoder = new LibheifDecoder();
      await decoder.initialize();

      await expect(decoder.decode(new Uint8Array([]))).rejects.toThrow();
    });

    it('should handle large image dimensions', async () => {
      mockState.state.decode.mockReturnValue({
        width: 2048,
        height: 2048,
        data: new Uint8Array(2048 * 2048 * 4),
      });

      const decoder = new LibheifDecoder();
      await decoder.initialize();
      const result = await decoder.decode(new Uint8Array([1, 2, 3, 4]));

      expect(result.width).toBe(2048);
      expect(result.height).toBe(2048);
    });

    it('should handle small image dimensions', async () => {
      mockState.state.decode.mockReturnValue({ width: 1, height: 1, data: new Uint8Array(4) });

      const decoder = new LibheifDecoder();
      await decoder.initialize();
      const result = await decoder.decode(new Uint8Array([1, 2, 3, 4]));

      expect(result.width).toBe(1);
      expect(result.height).toBe(1);
      expect(result.data.length).toBe(4);
    });

    it('should handle square images', async () => {
      const size = 512;
      mockState.state.decode.mockReturnValue({
        width: size,
        height: size,
        data: new Uint8Array(size * size * 4),
      });

      const decoder = new LibheifDecoder();
      await decoder.initialize();
      const result = await decoder.decode(new Uint8Array([1, 2, 3, 4]));

      expect(result.width).toBe(size);
      expect(result.height).toBe(size);
      expect(result.data.length).toBe(size * size * 4);
    });

    it('should handle non-square images', async () => {
      mockState.state.decode.mockReturnValue({
        width: 1920,
        height: 1080,
        data: new Uint8Array(1920 * 1080 * 4),
      });

      const decoder = new LibheifDecoder();
      await decoder.initialize();
      const result = await decoder.decode(new Uint8Array([1, 2, 3, 4]));

      expect(result.width).toBe(1920);
      expect(result.height).toBe(1080);
      expect(result.data.length).toBe(1920 * 1080 * 4);
    });

    it('should repack rows when the plane stride exceeds the row width', async () => {
      // 2x2 RGBA, packed rows of 8 bytes stored with a row pitch of 12.
      mockState.state.decode.mockReturnValue({
        width: 2,
        height: 2,
        stride: 12,
        data: new Uint8Array([1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4]),
      });

      const decoder = new LibheifDecoder();
      await decoder.initialize();
      const result = await decoder.decode(new Uint8Array([1]));

      expect(Array.from(result.data)).toEqual([1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4]);
    });

    it('should read the result header from the grown heap after memory growth', async () => {
      // Start on a heap too small for the plane: the mock grows it mid-decode
      // (new buffer, `module.HEAPU8` re-pointed). A wrapper that cached
      // `HEAPU8` before the decode would read a stale buffer and misreport everything.
      mockState.state.heap = new Uint8Array(4096);
      mockState.state.module.HEAPU8 = mockState.state.heap;
      const pixels = new Uint8Array(64 * 64 * 4).fill(7);
      mockState.state.decode.mockReturnValue({ width: 64, height: 64, data: pixels });

      const decoder = new LibheifDecoder();
      await decoder.initialize();
      const result = await decoder.decode(new Uint8Array([1, 2, 3, 4]));

      expect(result.width).toBe(64);
      expect(result.height).toBe(64);
      expect(result.data.length).toBe(64 * 64 * 4);
      expect(result.data.every((v) => v === 7)).toBe(true);
      expect(mockState.state.heap.length).toBeGreaterThan(4096);
    });
  });

  describe('Progress callback', () => {
    it('should clear the progress slot when no callback is provided', async () => {
      mockState.state.decode.mockReturnValue({
        width: 100,
        height: 100,
        data: new Uint8Array(100 * 100 * 4),
      });
      let slotDuringDecode: unknown = 'unset';
      mockState.state.heicDecode.mockImplementation((ptr: number, len: number) => {
        slotDuringDecode = mockState.state.module.__progressCb;
        return mockState.state.defaultHeicDecode(ptr, len);
      });

      const decoder = new LibheifDecoder();
      await decoder.initialize();
      await decoder.decode(new Uint8Array([1, 2, 3, 4]));

      // Without a host callback the slot is installed as null, so the `EM_JS`
      // trampoline fires nothing and the slot is cleared afterwards.
      expect(slotDuringDecode).toBeNull();
      expect(mockState.state.module.__progressCb).toBeNull();
    });

    it('should install a normalizing wrapper around the progress callback', async () => {
      mockState.state.decode.mockReturnValue({
        width: 100,
        height: 100,
        data: new Uint8Array(100 * 100 * 4),
      });
      let captured: ((percent: number) => void) | null = null;
      mockState.state.heicDecode.mockImplementation((ptr: number, len: number) => {
        captured = mockState.state.module.__progressCb as (percent: number) => void;
        return mockState.state.defaultHeicDecode(ptr, len);
      });

      const progressCallback = vi.fn();
      const decoder = new LibheifDecoder();
      await decoder.initialize();
      await decoder.decode(new Uint8Array([1, 2, 3, 4]), progressCallback);

      const installed = captured as unknown as (percent: number) => void;
      expect(installed).toBeInstanceOf(Function);
      expect(installed).not.toBe(progressCallback);
      // Values leaving the wrapper are clamped to the documented 0-100 range.
      installed(50);
      installed(150);
      installed(-5);
      installed(Number.NaN);
      expect(progressCallback.mock.calls.map(([percent]) => percent)).toEqual([50, 100, 0, 0]);
      // The slot does not outlive the synchronous decode.
      expect(mockState.state.module.__progressCb).toBeNull();
    });

    it('should deliver the full event sequence in order', async () => {
      mockState.state.decode.mockImplementation(
        (_data: Uint8Array, fire: (percent: number) => void) => {
          fire(0);
          fire(40);
          fire(80);
          fire(100);
          return { width: 1, height: 1, data: new Uint8Array([0, 0, 0, 255]) };
        }
      );

      const percents: number[] = [];
      const decoder = new LibheifDecoder();
      await decoder.initialize();
      await decoder.decode(new Uint8Array([1]), (p) => percents.push(p));

      expect(percents).toEqual([0, 40, 80, 100]);
    });

    it('should attribute a throwing host progress callback as progress_callback_failed', async () => {
      mockState.state.decode.mockImplementation(
        (_data: Uint8Array, fire: (percent: number) => void) => {
          fire(50); // host callback throws below; must not reach the module
          return { width: 100, height: 100, data: new Uint8Array(100 * 100 * 4) };
        }
      );

      const decoder = new LibheifDecoder();
      await decoder.initialize();

      const error = await decoder
        .decode(new Uint8Array([1, 2, 3, 4]), () => {
          throw new Error('host exploded');
        })
        .catch((e) => e);
      expect(error.code).toBe('progress_callback_failed');
      expect(error.message).toContain('onProgress callback threw during decode');
      expect(error.message).toContain('host exploded');
    });

    it('should stop delivering events after the host callback throws', async () => {
      // The wrapper nulls the slot on the first host throw — the containment
      // the old per-call `embind` callback gave by construction.
      const hostCalls: number[] = [];
      mockState.state.decode.mockImplementation(
        (_data: Uint8Array, fire: (percent: number) => void) => {
          fire(50);
          fire(75); // slot already null: must not reach the host
          return { width: 1, height: 1, data: new Uint8Array([0, 0, 0, 255]) };
        }
      );

      const decoder = new LibheifDecoder();
      await decoder.initialize();
      await decoder
        .decode(new Uint8Array([1]), (p) => {
          hostCalls.push(p);
          throw new Error('nope');
        })
        .catch(() => undefined);

      expect(hostCalls).toEqual([50]);
    });

    it('should report a non-Error progress throw via its string form', async () => {
      mockState.state.decode.mockImplementation(
        (_data: Uint8Array, fire: (percent: number) => void) => {
          fire(50);
          return { width: 1, height: 1, data: new Uint8Array([0, 0, 0, 255]) };
        }
      );

      const decoder = new LibheifDecoder();
      await decoder.initialize();

      const error = await decoder
        .decode(new Uint8Array([1]), () => {
          throw 'boom-string';
        })
        .catch((e) => e);
      expect(error.code).toBe('progress_callback_failed');
      expect(error.message).toContain('boom-string');
      expect(error.cause).toBe('boom-string');
    });
  });

  describe('Module options', () => {
    it('should pass locateFile function to module factory', async () => {
      const customLocateFile = vi.fn((path: string) => `custom/${path}`);
      const decoder = new LibheifDecoder({ locateFile: customLocateFile });
      await decoder.initialize();

      expect(mockState.factory).toHaveBeenCalledWith(
        expect.objectContaining({
          locateFile: expect.any(Function),
        })
      );
    });

    it('should pass wasmBinary to module factory', async () => {
      const decoder = new LibheifDecoder({ wasmBinary: MINIMAL_WASM });
      await decoder.initialize();

      const [moduleArgs] = mockState.factory.mock.calls[0];
      expect(moduleArgs.wasmBinary).toBeUndefined();
      // The shim instantiates the prepared binary and hands the instance to
      // the glue's `receiveInstance` callback.
      const instance = await new Promise((resolve) =>
        moduleArgs.instantiateWasm({}, resolve)
      );
      expect(instance).toBeInstanceOf(WebAssembly.Instance);
    });

    it('should pass moduleOverrides through to the module factory', async () => {
      const decoder = new LibheifDecoder({
        moduleOverrides: { print: () => undefined },
        wasmBinary: MINIMAL_WASM,
      });
      await decoder.initialize();

      const [moduleArgs] = mockState.factory.mock.calls[0];
      expect(moduleArgs.print).toBeInstanceOf(Function);
      expect(moduleArgs.instantiateWasm).toBeInstanceOf(Function);
    });

    it('should handle undefined options', async () => {
      const decoder = new LibheifDecoder(undefined);
      await decoder.initialize();

      expect(mockState.factory).toHaveBeenCalledWith({});
    });
  });

  describe('Pointer protocol (_malloc / _heic_decode / _free)', () => {
    it('should bulk-load input into the heap and release the result exactly once', async () => {
      mockState.state.decode.mockReturnValue({ width: 1, height: 1, data: new Uint8Array([1, 2, 3, 4]) });

      const mockData = new Uint8Array([10, 20, 30, 40]);
      const decoder = new LibheifDecoder();
      await decoder.initialize();
      const result = await decoder.decode(mockData);

      expect(mockState.state.malloc).toHaveBeenCalledWith(4);
      expect(mockState.state.heap.subarray(INPUT_SLOT, INPUT_SLOT + 4)).toEqual(
        new Uint8Array([10, 20, 30, 40])
      );
      expect(mockState.state.heicDecode).toHaveBeenCalledWith(INPUT_SLOT, 4);
      expect(mockState.state.free).toHaveBeenCalledWith(INPUT_SLOT);
      // The result struct must be released exactly once, after the copies.
      expect(mockState.state.resultFree).toHaveBeenCalledTimes(1);
      expect(mockState.state.resultFree).toHaveBeenCalledWith(mockState.state.lastResultPtr);
      expect(mockState.state.lastResultPtr).not.toBe(0);
      expect(result.width).toBe(1);
    });

    it('should free the malloc-ed input even when the decode traps', async () => {
      mockState.state.heicDecode.mockImplementationOnce(() => {
        throw new Error('wasm exploded');
      });
      const decoder = new LibheifDecoder();
      await decoder.initialize();

      // `SECURITY.md` promises a typed error rather than a raw module fault,
      // with the original kept on `cause`, and a faulted heap must never be reused.
      const error = await decoder.decode(new Uint8Array([1])).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(HeicConverterError);
      expect((error as HeicConverterError).code).toBe('decode_failed');
      expect(((error as HeicConverterError).cause as Error).message).toContain('wasm exploded');
      expect(isDecoderPoisoned(decoder)).toBe(true);
      expect(mockState.state.free).toHaveBeenCalledWith(INPUT_SLOT);
      // No result pointer ever came back, so there is nothing to release.
      expect(mockState.state.resultFree).not.toHaveBeenCalled();
    });

    it('should report an allocation failure when _malloc returns 0', async () => {
      mockState.state.malloc.mockReturnValue(0);

      const decoder = new LibheifDecoder();
      await decoder.initialize();
      const error = await decoder.decode(new Uint8Array([1, 2, 3, 4])).catch((e) => e);

      expect(error.code).toBe('decode_failed');
      expect(error.message).toContain('allocate');
      expect(mockState.state.heicDecode).not.toHaveBeenCalled();
      expect(mockState.state.free).not.toHaveBeenCalled();
      expect(isDecoderPoisoned(decoder)).toBe(false); // a failed alloc is not a trap
    });

    it('should copy input that is backed by the WASM heap before writing it back', async () => {
      // Overlap/detach guard: heap-backed input must be copied out before
      // `HEAPU8.set` writes it into the `_malloc` slot. Asserting the bytes
      // that arrive is vacuous (no overlap here, `TypedArray#set` is
      // memmove-safe anyway), so inspect the view handed to `set`: it must
      // be a copy, not the heap.
      mockState.state.heap.set([9, 8, 7, 6], 0);
      mockState.state.decode.mockReturnValue({ width: 1, height: 1, data: new Uint8Array([1, 2, 3, 4]) });
      const heapBackedInput = new Uint8Array(mockState.state.heap.buffer, 0, 4);
      const setSpy = vi.spyOn(mockState.state.heap, 'set');

      const decoder = new LibheifDecoder();
      await decoder.initialize();
      await decoder.decode(heapBackedInput);

      // First heap write of the decode is the wrapper's input upload.
      const written = setSpy.mock.calls[0][0] as Uint8Array;
      expect(
        written.buffer,
        'heap-backed input must be copied out, not written in place'
      ).not.toBe(mockState.state.heap.buffer);
      expect(Array.from(written)).toEqual([9, 8, 7, 6]);
      setSpy.mockRestore();
    });
  });

  describe('Glue API verification and fault bookkeeping', () => {
    it('rejects with decoder_init_failed when the glue lacks the C-ABI exports', async () => {
      // The pinned build always exports them; a glue missing them is tampered
      // or a mismatched partial upload — a load-stage verdict.
      mockState.factory.mockResolvedValue({
        _malloc: mockState.state.malloc,
        _free: mockState.state.free,
        _heic_decode: mockState.state.heicDecode,
        // `_heic_result_free` and `HEAPU8` are deliberately missing.
      });

      const decoder = new LibheifDecoder();
      const error = await decoder.initialize().catch((e: unknown) => e);

      expect(error).toBeInstanceOf(HeicConverterError);
      expect((error as HeicConverterError).code).toBe('decoder_init_failed');
      expect((error as HeicConverterError).message).toContain('_heic_result_free');
      expect((error as HeicConverterError).message).toContain('HEAPU8');
    });

    it('retries initialization after a glue-API rejection', async () => {
      mockState.factory.mockResolvedValueOnce({});
      const decoder = new LibheifDecoder();
      await expect(decoder.initialize()).rejects.toMatchObject({ code: 'decoder_init_failed' });

      // A failed load must not poison the instance: the next attempt sees the
      // healthy default module and succeeds.
      await decoder.initialize();
      await expect(decoder.decode(new Uint8Array([1]))).rejects.toBeInstanceOf(HeicConverterError);
      expect(mockState.factory).toHaveBeenCalledTimes(2);
    });

    it('clears the faulted flag on free() so a re-initialized decoder is leaseable', async () => {
      // A fresh module means a fresh heap: the poison must not survive `free()`
      // or a re-initialized instance would be discarded by the pool forever.
      mockState.state.heicDecode.mockImplementationOnce(() => {
        throw new Error('wasm exploded');
      });
      const decoder = new LibheifDecoder();
      await decoder.initialize();
      await decoder.decode(new Uint8Array([1, 2, 3, 4])).catch(() => undefined);
      expect(isDecoderPoisoned(decoder)).toBe(true);

      decoder.free();
      expect(isDecoderPoisoned(decoder)).toBe(false);
    });
  });

  describe('Initialization races with free()', () => {
    it('should reject decode when freed while the module is loading', async () => {
      let resolveFactory: ((module: unknown) => void) | undefined;
      mockState.factory.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFactory = resolve;
          })
      );

      const decoder = new LibheifDecoder();
      const decoding = decoder.decode(new Uint8Array([1, 2, 3, 4]));
      const settled = decoding.catch((e) => e);
      await new Promise((r) => setTimeout(r, 0)); // let the glue import reach the factory

      decoder.free(); // abandons the in-flight load
      resolveFactory!(mockState.state.module);

      const error = await settled;
      expect(error.code).toBe('decode_failed');
      expect(error.message).toContain('Decoder was freed before decoding completed');
      expect(mockState.state.decode).not.toHaveBeenCalled();
    });

    it('should not clobber a newer initialization when a stale load rejects', async () => {
      let rejectFirst: ((error: unknown) => void) | undefined;
      mockState.factory
        .mockImplementationOnce(
          () =>
            new Promise((_resolve, reject) => {
              rejectFirst = reject;
            })
        )
        .mockImplementationOnce(() => Promise.resolve(mockState.state.module));

      const decoder = new LibheifDecoder();
      const first = decoder.initialize();
      // Let the first glue import settle (factory invoked, load pending)
      // before starting the second one, mirroring real-world timing.
      await new Promise((r) => setTimeout(r, 0));
      decoder.free(); // abandons the first load
      await decoder.initialize();

      rejectFirst!(new Error('stale load failed'));
      await expect(first).rejects.toThrow('stale load failed');

      mockState.state.decode.mockReturnValue({
        width: 1,
        height: 1,
        data: new Uint8Array([0, 0, 0, 255]),
      });
      const result = await decoder.decode(new Uint8Array([1]));
      expect(result.width).toBe(1);
    });
  });
});

describe('LibheifDecoder (mocked glue) - orientation reporting', () => {
  beforeEach(() => {
    mockState.factory.mockReset();
    mockState.factory.mockResolvedValue(mockState.state.module);
    mockState.state.reset();
    mockState.state.decode.mockReset();
  });

  const decodeWith = async (orientation?: number): Promise<{ orientation?: number }> => {
    mockState.state.decode.mockReturnValue({
      width: 4,
      height: 2,
      data: new Uint8Array(4 * 2 * 4),
      ...(orientation !== undefined ? { orientation } : {}),
    });
    const decoder = new LibheifDecoder();
    await decoder.initialize();
    return decoder.decode(new Uint8Array([1, 2, 3, 4]));
  };

  it('passes through a valid EXIF orientation', async () => {
    const decoded = await decodeWith(6);
    expect(decoded.orientation).toBe(6);
  });

  it('omits the field for identity (1) or when the header reports the default', async () => {
    expect((await decodeWith(1)).orientation).toBeUndefined();
    expect((await decodeWith()).orientation).toBeUndefined(); // mock default: 1
  });

  it('normalizes out-of-range int32 orientations to identity', async () => {
    // The header field is int32 by construction (`DataView`), so out-of-range
    // integers are the only unusable values the ABI can carry.
    for (const garbage of [0, 9, -1, 255, 2147483647]) {
      const decoded = await decodeWith(garbage);
      expect(decoded.orientation).toBeUndefined();
    }
  });
});

describe('LibheifDecoder (mocked glue) - exif reporting', () => {
  beforeEach(() => {
    mockState.factory.mockReset();
    mockState.factory.mockResolvedValue(mockState.state.module);
    mockState.state.reset();
    mockState.state.decode.mockReset();
  });

  const validBlock = (): Uint8Array =>
    new Uint8Array([0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0x49, 0x49, 0x2a, 0x00, 8, 0, 0, 0]);

  const decodeWithExif = async (exif?: Uint8Array): Promise<{ exif?: Uint8Array }> => {
    mockState.state.decode.mockReturnValue({
      width: 4,
      height: 2,
      data: new Uint8Array(4 * 2 * 4),
      ...(exif !== undefined ? { exif } : {}),
    });
    const decoder = new LibheifDecoder();
    await decoder.initialize();
    return decoder.decode(new Uint8Array([1, 2, 3, 4]));
  };

  it('copies a valid EXIF block out of the heap before releasing the result', async () => {
    const source = validBlock();
    const decoded = await decodeWithExif(source);

    expect(decoded.exif).toBeInstanceOf(Uint8Array);
    // The block lived in the mock heap until `_heic_result_free`: the wrapper
    // must hand back an owned copy.
    expect((decoded.exif as Uint8Array).buffer).not.toBe(mockState.state.heap.buffer);
    expect(Array.from(decoded.exif as Uint8Array)).toEqual(Array.from(source));
    // Glue-side writes afterwards cannot corrupt the consumer's block.
    mockState.state.heap.fill(0);
    expect(Array.from(decoded.exif as Uint8Array)).toEqual(Array.from(source));
  });

  it('omits the field when absent', async () => {
    expect((await decodeWithExif()).exif).toBeUndefined();
  });

  it('omits blocks too short to carry a marker plus a minimal TIFF header', async () => {
    expect((await decodeWithExif(new Uint8Array(13))).exif).toBeUndefined();
    expect((await decodeWithExif(new Uint8Array(14))).exif).toBeInstanceOf(Uint8Array);
  });
});
