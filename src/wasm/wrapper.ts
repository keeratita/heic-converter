import type { IHeicDecoder, DecodedImage } from '../types';
import { Messages } from '../messages/core';
import { clampPercent } from '../progress';
import { HeicConverterError } from '../errors';
import { clearFaulted, markFaulted } from './fault';

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

/**
 * Shape of the decoded result returned by the WASM HeicDecoder.
 */
interface HeicDecoderResult {
  width: number;
  height: number;
  data: Uint8Array;
  /** EXIF orientation 1-8 (1 when absent or already applied by libheif). */
  orientation?: number;
  /**
   * Raw EXIF block normalized to the JPEG APP1 payload form
   * ("Exif\0\0" + TIFF), present when the file carries an Exif item
   * (regardless of irot/imir). JS-owned, same as `data`.
   */
  exif?: Uint8Array;
}

/**
 * Shape of the WASM HeicDecoder instance exposed by libheif.
 */
interface HeicDecoderInstance {
  decode(data: Uint8Array, onProgress: ((percent: number) => void) | null): HeicDecoderResult | string | null;
  /**
   * Fast path available on newer builds: reads input already placed in the
   * WASM heap by the caller, avoiding embind's per-byte std::string
   * marshalling of the input file.
   */
  decodeFromPointer?(
    ptr: number,
    len: number,
    onProgress: ((percent: number) => void) | null
  ): HeicDecoderResult | string | null;
  delete(): void;
}

/**
 * Shape of the WASM module factory output.
 */
interface HeicDecoderModule {
  HeicDecoder: new () => HeicDecoderInstance;
  /** Present on newer glue builds (EXPORTED_FUNCTIONS/RuntimeMethods). */
  _malloc?: (size: number) => number;
  _free?: (ptr: number) => void;
  HEAPU8?: Uint8Array;
}

interface ModuleInitOptions extends Record<string, unknown> {
  locateFile?: LibheifDecoderOptions['locateFile'];
  wasmBinary?: ArrayBuffer | ArrayBufferView;
}

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
  private decoderInstance: HeicDecoderInstance | null = null;
  /**
   * Memoized module-loading promise so concurrent initialize()/decode() calls
   * on the same instance never instantiate (or mutate) the module twice.
   * Resolves null when a concurrent free() discarded the freshly created
   * instance (see initGeneration).
   */
  private initPromise: Promise<HeicDecoderModule | null> | null = null;
  /**
   * Generation counter for init/free races: a load that finishes after a
   * concurrent free() must not resurrect module/decoderInstance.
   */
  private initGeneration = 0;

  constructor(options?: LibheifDecoderOptions) {
    this.options = options;
  }

  /**
   * Initializes the WebAssembly module and instantiates the HEIC decoder.
   * Safe to call concurrently: the module is loaded at most once per instance.
   */
  async initialize(): Promise<void> {
    if (!this.initPromise) {
      const generation = ++this.initGeneration;
      const moduleArgs: ModuleInitOptions = {};
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
          const instance = new module.HeicDecoder();
          if (generation !== this.initGeneration) {
            // free() ran during the load: drop it instead of resurrecting.
            instance.delete();
            return null;
          }
          this.module = module;
          this.decoderInstance = instance;
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
    if (!this.module || !this.decoderInstance) {
      await this.initialize();
    }
    if (!this.module || !this.decoderInstance) {
      // A concurrent free() (or a raced initialization) dropped the instance.
      throw new HeicConverterError('decode_failed', Messages.DecoderFreedDuringDecode);
    }

    // Contain host progress exceptions (unwinding through embind would abort
    // the module) and normalize values to the documented [0, 100] range.
    let progressError: unknown;
    const wrappedProgress = onProgress
      ? (percent: number): void => {
          try {
            onProgress(clampPercent(percent));
          } catch (error) {
            progressError = progressError ?? error;
          }
        }
      : null;

    const module = this.module;
    const instance = this.decoderInstance;
    let result: HeicDecoderResult | string | null;

    try {
      // Fast path when the glue exports the pointer API: one HEAPU8.set instead
      // of embind's per-byte marshalling; otherwise use the std::string path.
      if (
        typeof instance.decodeFromPointer === 'function' &&
        typeof module._malloc === 'function' &&
        typeof module._free === 'function' &&
        module.HEAPU8 instanceof Uint8Array &&
        data.buffer !== module.HEAPU8.buffer
      ) {
        const ptr = module._malloc(data.byteLength);
        if (ptr === 0) {
          throw new HeicConverterError(
            'decode_failed',
            Messages.DecodeInputAllocFailed(data.byteLength)
          );
        }
        try {
          module.HEAPU8.set(data, ptr);
          result = instance.decodeFromPointer(ptr, data.byteLength, wrappedProgress);
        } finally {
          module._free(ptr);
        }
      } else {
        result = instance.decode(data, wrappedProgress);
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
    }

    if (typeof result === 'string') {
      throw new HeicConverterError(
        'decode_failed',
        Messages.DecodeFailedWithDetail(sanitizeDecoderDetail(result), data.byteLength)
      );
    }
    if (!result) {
      throw new HeicConverterError('decode_failed', Messages.DecodeFailed(data.byteLength));
    }

    if (progressError !== undefined) {
      // Decode succeeded but the host callback threw — report it with cause.
      throw new HeicConverterError(
        'progress_callback_failed',
        Messages.ProgressCallbackThrew(
          progressError instanceof Error ? progressError.message : String(progressError)
        ),
        { cause: progressError }
      );
    }

    const width = result.width;
    const height = result.height;

    // Validate the reported orientation before exposing it: anything outside
    // EXIF's 1-8 range (or absent on an older glue) is identity. Only set the
    // field when a rotation is actually pending, keeping the result shape
    // backwards compatible.
    const rawOrientation = result.orientation;
    const orientation =
      typeof rawOrientation === 'number' &&
      Number.isInteger(rawOrientation) &&
      rawOrientation >= 1 &&
      rawOrientation <= 8
        ? rawOrientation
        : 1;

    // DecodedImage.data must outlive free(): the C++ wrapper allocates pixels
    // as a JS array, so wrap without copying when HEAPU8 proves it is not a
    // heap view; otherwise copy.
    const heapBuffer = module.HEAPU8 instanceof Uint8Array ? module.HEAPU8.buffer : undefined;
    const clampedData =
      heapBuffer !== undefined && result.data.buffer !== heapBuffer
        ? new Uint8ClampedArray(result.data.buffer, result.data.byteOffset, result.data.byteLength)
        : new Uint8ClampedArray(result.data);

    const decoded: DecodedImage = {
      width,
      height,
      data: clampedData,
    };
    if (orientation > 1) {
      decoded.orientation = orientation;
    }
    // Expose the raw EXIF block for metadata preservation (preserveExif) and
    // for raw-decode consumers (e.g. Node + sharp). Same ownership rule as
    // `data`: the block must outlive free(), so copy only when HEAPU8 shows it
    // is a live heap view — the C++ wrapper hands back a JS-allocated array,
    // so this is normally a zero-copy wrap (it was previously an extra full
    // copy of a payload that can reach 4 MB). Require at least a marker plus a
    // minimal TIFF header to be useful.
    const rawExif = result.exif;
    if (rawExif instanceof Uint8Array && rawExif.length >= 14) {
      decoded.exif =
        heapBuffer !== undefined && rawExif.buffer !== heapBuffer
          ? new Uint8Array(rawExif.buffer, rawExif.byteOffset, rawExif.byteLength)
          : new Uint8Array(rawExif);
    }
    return decoded;
  }

  /**
   * Cleans up the WebAssembly decoder instance and resources.
   * Idempotent: safe to call multiple times. After free(), the next
   * initialize() — or decode() directly, which re-initializes transparently
   * — loads a fresh module.
   *
   * free() is also safe to call while initialize() is in flight: a load that
   * completes after free() discards its fresh instance instead of leaking it.
   */
  free(): void {
    // Invalidate any in-flight initialization so it cannot resurrect state.
    this.initGeneration += 1;
    if (this.decoderInstance) {
      this.decoderInstance.delete();
      this.decoderInstance = null;
    }
    this.module = null;
    clearFaulted(this); // a fresh module means a fresh heap
    // Release the module so a later initialize() loads a fresh one.
    this.initPromise = null;
  }
}
