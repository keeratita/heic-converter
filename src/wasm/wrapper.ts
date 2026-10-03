import type { IHeicDecoder, DecodedImage } from '../types';
import { Messages } from '../messages';
import { HeicConverterError } from '../errors';

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

      // Lazy-load the Emscripten glue so it stays out of the main bundle and
      // is only fetched on the first actual decode (not on import).
      const promise = import('./wrapper/heic-decoder.js')
        .then(({ default: createHeicDecoderModule }) =>
          createHeicDecoderModule(moduleArgs)
        )
        .then((module) => {
          const instance = new module.HeicDecoder();
          if (generation !== this.initGeneration) {
            // free() ran while the module was loading: do not resurrect this
            // instance; drop it so a later initialize() starts a fresh load.
            instance.delete();
            return null;
          }
          this.module = module;
          this.decoderInstance = instance;
          return module;
        })
        .catch((error) => {
          // Reset so a failed load (e.g. transient WASM fetch failure) can be
          // retried — but never clobber a newer init started after free().
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
      throw new HeicConverterError(
        'decode_failed',
        'Decoder was freed before decoding completed; call initialize() again.'
      );
    }

    // Wrap the host progress callback so it (a) can never leak an exception
    // into WASM code — unwinding through the embind call would abort the
    // module or leak the libheif context — and (b) always receives a value
    // normalized to [0, 100], the documented onProgress contract.
    let progressError: unknown;
    const wrappedProgress = onProgress
      ? (percent: number): void => {
          try {
            const numeric = Number(percent);
            onProgress(Number.isFinite(numeric) ? Math.min(100, Math.max(0, numeric)) : 0);
          } catch (error) {
            progressError = progressError ?? error;
          }
        }
      : null;

    const module = this.module;
    const instance = this.decoderInstance;
    let result: HeicDecoderResult | string | null;

    // Bulk-load the input into the WASM heap when the newer glue exposes the
    // pointer API: one HEAPU8.set instead of embind's per-byte std::string
    // loop. Fall back to the std::string path on older glue builds.
    if (
      typeof instance.decodeFromPointer === 'function' &&
      typeof module._malloc === 'function' &&
      typeof module._free === 'function' &&
      module.HEAPU8 instanceof Uint8Array &&
      data.buffer !== module.HEAPU8.buffer
    ) {
      const ptr = module._malloc(data.byteLength);
      try {
        module.HEAPU8.set(data, ptr);
        result = instance.decodeFromPointer(ptr, data.byteLength, wrappedProgress);
      } finally {
        module._free(ptr);
      }
    } else {
      result = instance.decode(data, wrappedProgress);
    }

    if (typeof result === 'string') {
      throw new HeicConverterError(
        'decode_failed',
        Messages.DecodeFailedWithDetail(result, data.byteLength)
      );
    }
    if (!result) {
      throw new HeicConverterError('decode_failed', Messages.DecodeFailed(data.byteLength));
    }

    if (progressError !== undefined) {
      // The decode itself succeeded, but the host callback violated its side
      // of the contract — surface it with attribution instead of swallowing.
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

    // DecodedImage.data must be independent of the WASM heap so results stay
    // valid after free() and after a later decode on the same instance. The
    // C++ wrapper builds the pixel buffer with a JS `new Uint8Array(...)`, so
    // when we can prove it is not a heap view (newer glue exports HEAPU8) we
    // wrap it without copying; otherwise (older glue) copy defensively.
    const heapBuffer = module.HEAPU8 instanceof Uint8Array ? module.HEAPU8.buffer : undefined;
    const clampedData =
      heapBuffer !== undefined && result.data.buffer !== heapBuffer
        ? new Uint8ClampedArray(result.data.buffer, result.data.byteOffset, result.data.byteLength)
        : new Uint8ClampedArray(result.data);

    return {
      width,
      height,
      data: clampedData,
    };
  }

  /**
   * Cleans up the WebAssembly decoder instance and resources.
   * Idempotent: safe to call multiple times. After free(), the instance must
   * be re-initialized (createHeicDecoderModule runs again on the next call).
   *
   * free() is also safe to call while initialize() is in flight: a load that
   * completes after free() discards its fresh instance instead of leaking it.
   */
  free(): void {
    // Invalidate any in-flight initialization so its .then() cannot
    // resurrect module/decoderInstance after this free.
    this.initGeneration += 1;
    if (this.decoderInstance) {
      this.decoderInstance.delete();
      this.decoderInstance = null;
    }
    this.module = null;
    // Drop the module reference so the WASM instance/heap can be garbage
    // collected, and allow a later initialize() to load a fresh module.
    this.initPromise = null;
  }
}
