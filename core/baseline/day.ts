/**
 * Day arithmetic for cadence statistics.
 *
 * Everything is computed on UTC calendar days. That is a deliberate choice,
 * not an oversight: gaps must be stable numbers, and local time is not - an
 * hour of DST shift can turn a 7.0-day gap into 6.958 or 7.042 and quietly
 * move a median. The temporal resolver already emits UTC midnights for day and
 * week precision, so the two agree by construction.
 *
 * The cost is a boundary that is not the person's own midnight. For a cadence
 * measured in days, an event landing on the "wrong" side of UTC midnight
 * shifts one gap by at most one day, and the thresholds carry multi-day floors
 * precisely so that cannot flip a decision.
 */
export const DAY_MS = 86_400_000;

/** The UTC calendar day an instant falls on, as a midnight Date. */
export function toUtcDay(instant: Date): Date {
  return new Date(
    Date.UTC(instant.getUTCFullYear(), instant.getUTCMonth(), instant.getUTCDate()),
  );
}

/** Whole days between two UTC day boundaries. */
export function daysBetween(earlier: Date, later: Date): number {
  return Math.round((toUtcDay(later).getTime() - toUtcDay(earlier).getTime()) / DAY_MS);
}

/** ISO yyyy-mm-dd for a UTC day - the canonical key for collapsing. */
export function utcDayKey(instant: Date): string {
  return toUtcDay(instant).toISOString().slice(0, 10);
}
