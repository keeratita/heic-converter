/**
 * Stable, machine-readable error codes attached to every error the library
 * throws (as `HeicConverterError.code`). Codes are part of the public API:
 * they are additive-only and never repurposed, so callers can branch on
 * `error.code` instead of matching on message strings.
 */
export type HeicConverterErrorCode =
  | 'invalid_input'
  | 'invalid_quality'
  | 'invalid_resize'
  | 'invalid_format'
  | 'invalid_concurrency'
  | 'decoder_init_failed'
  | 'decode_failed'
  | 'progress_callback_failed'
  | 'render_encode_failed'
  | 'unsupported_environment'
  | 'worker_unsupported'
  | 'worker_create_failed'
  | 'worker_post_failed'
  | 'worker_failed'
  | 'worker_timeout'
  | 'batch_item_failed';

/**
 * Error thrown by all first-party code paths. Extends `Error` so existing
 * `instanceof Error` / message-based handling keeps working; the `code`
 * (and, for batch failures, `itemIndex`/`itemTotal`/`failedCount`) fields
 * add a structured discriminator without changing message text.
 */
export class HeicConverterError extends Error {
  readonly code: HeicConverterErrorCode;
  /** 0-based index of the failing input. Only set on `batch_item_failed` errors. */
  readonly itemIndex?: number;
  /** Total number of inputs in the batch. Only set on `batch_item_failed` errors. */
  readonly itemTotal?: number;
  /** How many items failed overall. Only set on `batch_item_failed` errors. */
  readonly failedCount?: number;

  constructor(
    code: HeicConverterErrorCode,
    message: string,
    options?: { cause?: unknown; itemIndex?: number; itemTotal?: number; failedCount?: number }
  ) {
    super(message, { cause: options?.cause });
    this.name = 'HeicConverterError';
    this.code = code;
    if (options?.itemIndex !== undefined) {
      this.itemIndex = options.itemIndex;
    }
    if (options?.itemTotal !== undefined) {
      this.itemTotal = options.itemTotal;
    }
    if (options?.failedCount !== undefined) {
      this.failedCount = options.failedCount;
    }
  }
}
