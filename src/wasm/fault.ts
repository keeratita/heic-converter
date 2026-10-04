/**
 * Registry of decoders whose WebAssembly module faulted (bad heap write, OOM
 * abort, unreachable trap). Such an instance cannot be reused: emmalloc has no
 * way to mark its arena unusable, so the next decode on the same heap is
 * undefined behaviour.
 *
 * Lives in its own module rather than in `wrapper.ts` so `index.ts`'s
 * `DecoderPool` can read it without importing the wrapper — the wrapper is
 * mocked in most unit tests, and this must stay real. Deliberately not
 * re-exported from `src/wasm/index.ts`: internal plumbing, not public API.
 */
const faulted = new WeakSet<object>();

export function markFaulted(decoder: object): void {
  faulted.add(decoder);
}

export function clearFaulted(decoder: object): void {
  faulted.delete(decoder);
}

export function isDecoderPoisoned(decoder: object): boolean {
  return faulted.has(decoder);
}
