import type { IHeicDecoder, DecodedImage } from '../types';
import { Messages } from '../messages/core';
import { clampPercent, progressCallbackError } from '../progress';
import { HeicConverterError } from '../errors';
import { clearFaulted, markFaulted } from './fault';
// Single source of truth for the glue surface — see the d.ts header. A local
// duplicate of these interfaces drifted from main.cpp once already.
import type {
  HeicDecoderModule,
  HeicDecoderModuleOptions,
} from './wrapper/heic-decoder.js';

export interface LibheifDecoderOptions {
  /**
   * Custom function to locate the WASM file.
   * Useful when serving the WASM file from a custom route or CDN.
   */
  locateFile?: (path: string, prefix: string) => string;

  /**
   * Raw WASM binary buffer. If provided, the library will use this buffer
   * directly instead of attempting to fetch the WASM file. Accepts an
   * `ArrayBuffer` or any `ArrayBufferView` (e.g. a Node.js `Buffer` from
   * `fs.readFileSync`).
   */
  wasmBinary?: ArrayBuffer | ArrayBufferView;

  /**
   * Advanced: extra properties merged into the Emscripten module argument
   * object (e.g. `instantiateWasm` for streaming compilation). Prefer
   * `locateFile`/`wasmBinary` for the common cases; keys provided here must
   * not collide with them.
   */
  moduleOverrides?: Record<string, unknown>;
}

// JS-visible header of the C++ DecodeResult (build-wasm/wrapper/main.cpp):
// nine 4-byte little-endian fields at fixed offsets, static_asserted there.
// Read through a DataView over the live heap after each decode.
const RESULT_HEADER_BYTES = 36;
const RESULT_WIDTH = 0; // Int32; 0 => error, read ERROR/ERROR_LEN
const RESULT_HEIGHT = 4; // Int32
const RESULT_ORIENTATION = 8; // Int32, 1..8 as parsed
const RESULT_PLANE = 12; // Uint32 heap address of RGBA rows
const RESULT_STRIDE = 16; // Uint32 row pitch in bytes
const RESULT_EXIF = 20; // Uint32 heap address of "Exif\0\0"+TIFF, or 0
const RESULT_EXIF_LEN = 24; // Uint32
const RESULT_ERROR = 28; // Uint32 heap address of utf8 detail, or 0
const RESULT_ERROR_LEN = 32; // Uint32

/**
 * libheif builds some error strings from raw container bytes (fourccs, mime
 * types, item names), so the detail returned by `decode()` is untrusted input
 * headed for `error.message` — and from there to log lines and, in the demo,
 * the page. Strip control characters and clamp before it gets there.
 */
// Matching control characters *is* the point: this is the strip step for
// untrusted decoder text, not a parser that might happen to meet one.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]+/g;

function sanitizeDecoderDetail(detail: string): string {
  const cleaned = detail.replace(CONTROL_CHARS, ' ').trim();
  return cleaned.length > 200 ? `${cleaned.slice(0, 197)}...` : cleaned;
}

export class LibheifDecoder implements IHeicDecoder {
  private options?: LibheifDecoderOptions;
  private module: HeicDecoderModule | null = null;
  /**
   * Memoized module-loading promise so concurrent initialize()/decode() calls
   * on the same instance never instantiate (or mutate) the module twice.
   * Resolves null when a concurrent free() discarded the freshly loaded
   * module (see initGeneration).
   */
  private initPromise: Promise<HeicDecoderModule | null> | null = null;
  /**
   * Generation counter for init/free races: a load that finishes after a
   * concurrent free() must not resurrect module.
   */
  private initGeneration = 0;

  constructor(options?: LibheifDecoderOptions) {
    this.options = options;
  }

  /**
   * Initializes the WebAssembly module (the raw C-ABI decoder surface).
   * Safe to call concurrently: the module is loaded at most once per instance.
   */
  async initialize(): Promise<void> {
    if (!this.initPromise) {
      const generation = ++this.initGeneration;
      const moduleArgs: HeicDecoderModuleOptions = {};
      if (this.options?.moduleOverrides) {
        Object.assign(moduleArgs, this.options.moduleOverrides);
      }
      if (this.options?.locateFile) {
        moduleArgs.locateFile = this.options.locateFile;
      }
      if (this.options?.wasmBinary) {
        moduleArgs.wasmBinary = this.options.wasmBinary;
      }

      // Lazy-load the glue so it is fetched on first decode, not on import.
      const promise = import('./wrapper/heic-decoder.js')
        .then(({ default: createHeicDecoderModule }) =>
          createHeicDecoderModule(moduleArgs)
        )
        .then((module) => {
          if (generation !== this.initGeneration) {
            // free() ran during the load: drop it instead of resurrecting.
            return null;
          }
          // Verify the C-ABI exports once, here instead of re-probing per
          // call: the pinned build always exports them, so their absence
          // means the glue/WASM pair does not come from this release
          // (tampered, or a partial dist/ upload) — a load-stage verdict,
          // not a decode one.
          const missing = [
            typeof module._heic_decode === 'function' ? null : '_heic_decode',
            typeof module._heic_result_free === 'function' ? null : '_heic_result_free',
            typeof module._malloc === 'function' ? null : '_malloc',
            typeof module._free === 'function' ? null : '_free',
            module.HEAPU8 instanceof Uint8Array ? null : 'HEAPU8',
          ].filter((name): name is string => name !== null);
          if (missing.length > 0) {
            throw new HeicConverterError(
              'decoder_init_failed',
              Messages.GlueApiMissing(missing.join(', '))
            );
          }
          this.module = module;
          return module;
        })
        .catch((error) => {
          // Allow a failed load to retry — but never clobber a newer init.
          if (this.initPromise === promise) {
            this.initPromise = null;
          }
          throw error;
        });
      this.initPromise = promise;
    }

    await this.initPromise;
  }

  /**
   * Decodes HEIC binary data into raw RGBA pixel data.
   * @param data The HEIC file contents as a Uint8Array.
   * @param onProgress Optional progress callback (receives a normalized
   * percentage clamped to 0-100).
   */
  async decode(
    data: Uint8Array,
    onProgress?: (percent: number) => void
  ): Promise<DecodedImage> {
    if (!this.module) {
      await this.initialize();
    }
    const module = this.module;
    if (!module) {
      // A concurrent free() (or a raced initialization) dropped the module.
      throw new HeicConverterError('decode_failed', Messages.DecoderFreedDuringDecode);
    }

    // Contain host progress exceptions (they must never reach the C++
    // boundary) and normalize values to the documented [0, 100] range. A
    // throw disables the remaining events of this decode — the same
    // containment the embind path gave with its per-call callback.
    let progressError: unknown;
    const wrappedProgress = onProgress
      ? (percent: number): void => {
          try {
            onProgress(clampPercent(percent));
          } catch (error) {
            progressError = progressError ?? error;
            module.__progressCb = null;
          }
        }
      : null;

    // Input already backed by the heap would overlap the _malloc slot
    // HEAPU8.set writes into — copy it out first. (Caller-reachable via a
    // leaked module ref.)
    const input = data.buffer === module.HEAPU8.buffer ? new Uint8Array(data) : data;

    let decoded: DecodedImage;
    let inputPtr = 0;
    let resultPtr = 0;
    try {
      inputPtr = module._malloc(input.byteLength);
      if (inputPtr === 0) {
        throw new HeicConverterError(
          'decode_failed',
          Messages.DecodeInputAllocFailed(input.byteLength)
        );
      }
      module.HEAPU8.set(input, inputPtr);

      // The progress slot is installed and consumed within ONE synchronous
      // task: JS's single thread serializes decode() calls that share the
      // module, so one decode's events never interleave with another, and
      // save/restore keeps even a host callback that re-enters decode()
      // wired to its own events.
      const previousProgressCb = module.__progressCb ?? null;
      module.__progressCb = wrappedProgress;
      try {
        resultPtr = module._heic_decode(inputPtr, input.byteLength);
      } finally {
        module.__progressCb = previousProgressCb;
      }

      // Re-read the heap: ALLOW_MEMORY_GROWTH may have replaced it during
      // the decode.
      const heap = module.HEAPU8;
      if (resultPtr === 0) {
        // The C++ only returns 0 when even the result allocation failed —
        // a broken module, same class as a trap. TypeError (not a
        // HeicConverterError) so the fault path below takes it.
        throw new TypeError('heic_decode returned a null result');
      }
      const header = new DataView(heap.buffer, resultPtr, RESULT_HEADER_BYTES);
      const width = header.getInt32(RESULT_WIDTH, true);
      if (width === 0) {
        const errorPtr = header.getUint32(RESULT_ERROR, true);
        const errorLen = header.getUint32(RESULT_ERROR_LEN, true);
        const detail =
          errorPtr !== 0
            ? new TextDecoder().decode(heap.subarray(errorPtr, errorPtr + errorLen))
            : '';
        throw new HeicConverterError(
          'decode_failed',
          detail
            ? Messages.DecodeFailedWithDetail(sanitizeDecoderDetail(detail), data.byteLength)
            : Messages.DecodeFailed(data.byteLength)
        );
      }
      const height = header.getInt32(RESULT_HEIGHT, true);
      // C++ enforces the dimension caps before it ever returns a success
      // header; only the EXIF orientation range is re-validated before it
      // is exposed. Outside EXIF's 1-8 range is identity, and only a
      // genuinely pending rotation sets the field (backwards-compatible
      // result shape).
      const rawOrientation = header.getInt32(RESULT_ORIENTATION, true);
      const orientation =
        rawOrientation >= 1 && rawOrientation <= 8 ? rawOrientation : 1;
      const plane = header.getUint32(RESULT_PLANE, true);
      const stride = header.getUint32(RESULT_STRIDE, true);

      // The plane dies with heic_result_free, so DecodedImage.data is
      // always an owned copy — one bulk copy for tightly packed rows,
      // stride-aware row copies otherwise (the copy budget the old C++
      // side paid before handing JS an array).
      const rowBytes = width * 4;
      const pixels = new Uint8ClampedArray(rowBytes * height);
      if (stride === rowBytes) {
        pixels.set(heap.subarray(plane, plane + rowBytes * height));
      } else {
        for (let y = 0; y < height; y++) {
          pixels.set(heap.subarray(plane + y * stride, plane + y * stride + rowBytes), y * rowBytes);
        }
      }
      decoded = { width, height, data: pixels };
      if (orientation > 1) {
        decoded.orientation = orientation;
      }
      // Same ownership rule as `data`: copy out before releasing the
      // result. Require the 6-byte "Exif\0\0" marker plus a minimal TIFF
      // header to be useful.
      const exifPtr = header.getUint32(RESULT_EXIF, true);
      const exifLen = header.getUint32(RESULT_EXIF_LEN, true);
      if (exifPtr !== 0 && exifLen >= 14) {
        decoded.exif = heap.slice(exifPtr, exifPtr + exifLen);
      }
    } catch (error) {
      // A decoder fault (bad heap write, OOM, unreachable) traps inside the
      // module as a raw WebAssembly.RuntimeError and leaves emmalloc's arena
      // unusable; the documented contract is a typed error, and the instance
      // must never be leased to the next caller.
      if (error instanceof HeicConverterError) {
        throw error;
      }
      markFaulted(this);
      throw new HeicConverterError('decode_failed', Messages.DecodeFaulted(data.byteLength), {
        cause: error
      });
    } finally {
      module.__progressCb = null;
      // Release the library's resources. On a faulted module these calls can
      // trap again — the module is being discarded, so cleanup failure must
      // never replace the typed error already in flight.
      try {
        if (resultPtr !== 0) {
          module._heic_result_free(resultPtr);
        }
        if (inputPtr !== 0) {
          module._free(inputPtr);
        }
      } catch {
        /* module faulted; markFaulted above already retired it */
      }
    }

    if (progressError !== undefined) {
      // Decode succeeded but the host callback threw — report it with cause.
      throw progressCallbackError(progressError);
    }

    return decoded;
  }

  /**
   * Cleans up the WebAssembly decoder resources.
   * Idempotent: safe to call multiple times. After free(), the next
   * initialize() — or decode() directly, which re-initializes transparently
   * — loads a fresh module.
   *
   * free() is also safe to call while initialize() is in flight: a load that
   * completes after free() discards itself instead of resurrecting state.
   */
  free(): void {
    // Invalidate any in-flight initialization so it cannot resurrect state.
    this.initGeneration += 1;
    this.module = null;
    clearFaulted(this); // a fresh module means a fresh heap
    // Release the module so a later initialize() loads a fresh one.
    this.initPromise = null;
  }
}
