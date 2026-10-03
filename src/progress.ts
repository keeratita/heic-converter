/**
 * Shared progress-value helpers. The public onProgress contract is "a number
 * clamped to 0-100"; every stage that forwards host-visible percentages
 * funnels values through clampPercent so the three call sites cannot drift.
 */

/** Coerce an arbitrary value to the documented 0-100 progress range. */
export function clampPercent(value: unknown): number {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.min(100, Math.max(0, numeric)) : 0;
}
