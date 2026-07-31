/**
 * The single boundary for converting an absolute observation timestamp into
 * an age. Every status time source must come through here so a future clock can
 * never be silently clamped into the freshest possible evidence.
 *
 * Keep the discriminated result: callers must handle invalid evidence before
 * TypeScript lets them read `ageMs`.
 */
export type ObservedAge =
  | { ok: true; ageMs: number }
  | { ok: false; reason: 'future' | 'non-finite' };

export function ageFromObservedTimestamp(
  observedAtMs: number,
  nowMs: number,
): ObservedAge {
  if (!Number.isFinite(observedAtMs) || !Number.isFinite(nowMs)) {
    return { ok: false, reason: 'non-finite' };
  }
  if (observedAtMs > nowMs) return { ok: false, reason: 'future' };
  return { ok: true, ageMs: nowMs - observedAtMs };
}
