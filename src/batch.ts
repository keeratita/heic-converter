import { HeicConverterError } from './errors';
import { Messages } from './messages/core';
import type { ConvertItemResult } from './types';

/**
 * How many runners a batch spawns — and, by necessity, the bound of the
 * `convertMany({ reuseDecoders: true })` decoder pool. Both sides must derive
 * from this one expression: if the pool were ever smaller than the runner count,
 * a runner would park forever waiting for a lease another runner holds.
 */
export function runnerCountFor(concurrency: number, total: number): number {
  return Math.min(concurrency, total);
}

/**
 * Shared bounded-concurrency batch runner backing both `convertMany` and
 * `convertManyInWorker`. Semantics (documented on the public APIs):
 *
 * - Items are processed in input order by at most `concurrency` runners.
 * - Default mode rejects with `batch_item_failed` as soon as the first
 *   failure is known; in-flight items settle in the background. The error
 *   names the first failing item and carries `itemIndex`/`itemTotal`/
 *   `failedCount`, plus up to two extra distinct failure messages.
 * - `continueOnError` mode never rejects for item failures and never stops
 *   launching items: it fulfills with per-item results in input order.
 * - Up-front failures thrown by `convertItem` synchronously (none today)
 *   propagate untouched.
 */
export function runBoundedBatch<T>(
  inputs: readonly unknown[],
  concurrency: number,
  convertItem: (input: unknown, index: number) => Promise<T>,
  options: { continueOnError: true; signal?: AbortSignal }
): Promise<ConvertItemResult<T>[]>;
export function runBoundedBatch<T>(
  inputs: readonly unknown[],
  concurrency: number,
  convertItem: (input: unknown, index: number) => Promise<T>,
  options?: { continueOnError?: false; signal?: AbortSignal }
): Promise<T[]>;
export function runBoundedBatch<T>(
  inputs: readonly unknown[],
  concurrency: number,
  convertItem: (input: unknown, index: number) => Promise<T>,
  options: { continueOnError: boolean; signal?: AbortSignal }
): Promise<Array<T | ConvertItemResult<T>>>;
export async function runBoundedBatch<T>(
  inputs: readonly unknown[],
  concurrency: number,
  convertItem: (input: unknown, index: number) => Promise<T>,
  options?: { continueOnError?: boolean; signal?: AbortSignal }
): Promise<T[] | ConvertItemResult<T>[]> {
  const continueOnError = options?.continueOnError === true;
  const signal = options?.signal;
  const results: ConvertItemResult<T>[] = new Array(inputs.length);
  let nextIndex = 0;
  let failed = false;
  let completedCount = 0;
  let firstError: unknown = null;
  let firstErrorIndex = -1;
  let failedCount = 0;
  const otherErrorMessages: string[] = [];
  // Single early-settle channel for BOTH the first item failure and abort —
  // the race below distinguishes the two cases after the fact.
  let notifySettle: (() => void) | undefined;
  const settleEarly = new Promise<void>((resolve) => {
    notifySettle = resolve;
  });
  const onAbort = (): void => notifySettle?.();
  if (signal && !continueOnError) {
    // Aborting mid-batch settles the race; in-flight items stop at their
    // next boundary check and no new items are launched.
    signal.addEventListener('abort', onAbort, { once: true });
  }

  const runItem = async (): Promise<void> => {
    while ((!failed && !signal?.aborted) || continueOnError) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= inputs.length) {
        return;
      }
      if (continueOnError && signal?.aborted) {
        // Cancellation also honors continueOnError batches: stop launching
        // new items and complete every not-yet-started entry as aborted
        // (started items still settle normally).
        const abortError = new HeicConverterError('aborted', Messages.Aborted);
        for (let i = index; i < inputs.length; i++) {
          results[i] = { index: i, ok: false, error: abortError };
        }
        nextIndex = inputs.length;
        return;
      }
      try {
        const value = await convertItem(inputs[index], index);
        results[index] = { index, ok: true, result: value };
        completedCount += 1;
      } catch (error) {
        failedCount += 1;
        if (continueOnError) {
          results[index] = {
            index,
            ok: false,
            error: error instanceof Error ? error : new Error(String(error)),
          };
          continue;
        }
        if (!failed) {
          failed = true;
          firstError = error;
          firstErrorIndex = index;
          notifySettle?.();
        } else if (otherErrorMessages.length < 2) {
          // Cap at two extra messages: distinguishes one bad file from a
          // systemic failure without dumping the whole batch.
          otherErrorMessages.push(error instanceof Error ? error.message : String(error));
        }
      }
    }
  };

  const runnerCount = runnerCountFor(concurrency, inputs.length);
  const runners = Array.from({ length: runnerCount }, () => runItem());

  try {
    if (continueOnError) {
      await Promise.all(runners);
      return results;
    }

    // Reject on the first failure; in-flight items settle in the background
    // and release their own resources.
    await Promise.race([Promise.all(runners), settleEarly]);

    if (completedCount === inputs.length) {
      return results.map((entry) => {
        if (!entry || !entry.ok) {
          // Unreachable: any failure throws below; any success is recorded.
          throw new HeicConverterError(
            'batch_item_failed',
            Messages.BatchItemProducedNoResult(entry?.index)
          );
        }
        return entry.result;
      });
    }
    // Cancellation wins over a concurrent item failure: the batch outcome
    // the user asked for was 'stop'.
    if (signal?.aborted) {
      throw new HeicConverterError('aborted', Messages.Aborted);
    }
    if (failed) {
      const message = firstError instanceof Error ? firstError.message : String(firstError);
      let text = Messages.ConvertManyItemFailed(firstErrorIndex + 1, inputs.length, message);
      if (failedCount > 1) {
        text += Messages.ConvertManyExtraFailures(failedCount, inputs.length);
        if (otherErrorMessages.length > 0) {
          text += Messages.ConvertManyOtherErrors(otherErrorMessages);
        }
      }
      throw new HeicConverterError('batch_item_failed', text, {
        cause: firstError,
        itemIndex: firstErrorIndex,
        itemTotal: inputs.length,
        failedCount,
      });
    }
    // Unreachable: the race only settles via completion, failure, or abort.
    throw new HeicConverterError('batch_item_failed', Messages.BatchEndedWithoutResult);
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}
