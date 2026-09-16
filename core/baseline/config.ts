/**
 * Every tunable in the pattern engine, in one reviewable place (docs/03).
 * A threshold change should be a diff someone can read, not a magic-number
 * hunt across call sites.
 */
export const baselineConfig = {
  /** Events older than this never contribute to a rhythm. */
  lookbackDays: 180,

  /* --- evidence gates (docs/03 section 9) --- */
  /** Three events give two gaps; a dispersion from two numbers is not evidence. */
  minEvents: 4,
  /** Four events in one week is a burst, not a rhythm. */
  minSpanDays: 21,
  /** Guards against same-day collapse leaving too few intervals. */
  minDistinctGaps: 3,

  /** Below this certainty an event is stored but never counted. */
  minCertainty: 0.7,

  /** MAD/median above this means there is data but no stable rhythm. */
  maxDispersion: 0.8,

  /* --- cadence threshold terms (docs/03 section 10.1) --- */
  madMultiplier: 2,
  medianMultiplier: 1.5,
  medianOffsetDays: 4,
  /** No signal for daily-contact relationships. */
  absoluteFloorDays: 7,

  /**
   * How long a persisted baseline is trusted before a read recomputes it
   * (docs/03 section 8.2).
   *
   * A baseline can go stale with no new event at all: evidence ages out of the
   * 180-day window, so the same stored row describes a rhythm the evidence no
   * longer supports. Targeted recompute-on-write cannot catch that, because
   * nothing was written.
   */
  stalenessHours: 24,

  /** Bumped when the algorithm changes, so a stored baseline stays reproducible. */
  methodVersion: "baseline.v1",
} as const;

export type BaselineConfig = typeof baselineConfig;
