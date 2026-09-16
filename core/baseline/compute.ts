import { baselineConfig, type BaselineConfig } from "./config";
import { DAY_MS, daysBetween, utcDayKey } from "./day";
import { stableHash } from "./hash";
import { median, medianAbsoluteDeviation } from "./stats";

/**
 * The baseline engine (docs/03 sections 8-10).
 *
 * Answers exactly one question: what is historically normal for this
 * relationship and this kind of contact? It does NOT answer whether to say
 * anything about it now - that is detection, and it lives in M4.
 *
 * Pure: no database, no model, no network, no ambient clock, no mutable state.
 * Call it with literal objects and assert on the result.
 */
export type BaselineStatus = "NO_BASELINE" | "IRREGULAR" | "ACTIVE";

/** The subset of an interaction event the baseline needs. */
export type BaselineInputEvent = {
  /** The stored row's id. This is the evidence identity inputs_hash is over. */
  id: string;
  occurredAt: Date;
  occurredAtPrecision: "exact" | "day" | "week" | "unknown";
  certainty: number;
  polarity: "positive" | "absence";
};

export type GateFailure =
  | { code: "INSUFFICIENT_EVENTS"; have: number; need: number }
  | { code: "INSUFFICIENT_SPAN"; haveDays: number; needDays: number }
  | { code: "INSUFFICIENT_GAPS"; have: number; need: number };

/**
 * The baseline itself: everything that is persisted, plus what can be derived
 * from it with no further evidence. A stored row reconstructs into exactly
 * this, which is what lets a read return one shape whatever its source.
 */
export type Baseline = {
  status: BaselineStatus;
  /** Days between contacts, at the middle of the distribution. */
  medianGapDays: number | null;
  madDays: number | null;
  dispersion: number | null;
  /** Qualifying events, before day collapse. */
  observationCount: number;
  windowStart: Date | null;
  windowEnd: Date | null;
  reasons: GateFailure[];
  methodVersion: string;
  inputsHash: string;
};

/**
 * What you additionally know when you have just derived a baseline from the
 * evidence, rather than read one back.
 *
 * `gaps` and `statisticalDayCount` are deliberately NOT part of `Baseline`:
 * they are not stored and cannot be reconstructed from a row, so putting them
 * there would force every read to invent them. The debug view gets them by
 * recomputing, which is its job anyway.
 */
export type BaselineDerivation = Baseline & {
  /** Distinct calendar days the qualifying events fall on. */
  statisticalDayCount: number;
  gaps: number[];
  spanDays: number;
};

export function computeBaseline(
  events: readonly BaselineInputEvent[],
  now: Date,
  config: BaselineConfig = baselineConfig,
): BaselineDerivation {
  // 1. Filter. Absence assertions are evidence of NON-occurrence and must never
  //    contribute positive cadence. Imprecise times cannot enter gap arithmetic
  //    without silently inventing precision the person never gave.
  const cutoff = new Date(now.getTime() - config.lookbackDays * DAY_MS);
  const qualifying = events.filter(
    (event) =>
      event.polarity === "positive" &&
      event.certainty >= config.minCertainty &&
      (event.occurredAtPrecision === "exact" || event.occurredAtPrecision === "day") &&
      event.occurredAt.getTime() >= cutoff.getTime() &&
      event.occurredAt.getTime() <= now.getTime(),
  );

  // 2. Collapse to one event per calendar day - statistics only. The stored
  //    rows are untouched; two genuine calls on a Tuesday remain two rows.
  const dayKeys = [...new Set(qualifying.map((event) => utcDayKey(event.occurredAt)))].sort();
  const days = dayKeys.map((key) => new Date(`${key}T00:00:00.000Z`));

  const windowStart = days.length > 0 ? days[0] : null;
  const windowEnd = days.length > 0 ? days[days.length - 1] : null;
  const spanDays = windowStart && windowEnd ? daysBetween(windowStart, windowEnd) : 0;

  // 3. Gaps between consecutive distinct days.
  const gaps: number[] = [];
  for (let i = 1; i < days.length; i += 1) {
    gaps.push(daysBetween(days[i - 1], days[i]));
  }

  // The hash is over the EVIDENCE, not the statistics: the canonical sorted
  // ids of the qualifying rows. Ordering of the input array cannot change it,
  // and a filtered-out row cannot either - but a second genuine call on a day
  // that already has one DOES change it, even though the median and MAD are
  // untouched. That is the point: the evidence set moved, so the provenance
  // must say so. Which algorithm and config produced the statistics is
  // recorded separately, by method_version.
  const inputsHash = stableHash([...qualifying.map((event) => event.id)].sort());

  const base = {
    observationCount: qualifying.length,
    statisticalDayCount: days.length,
    gaps,
    spanDays,
    windowStart,
    windowEnd,
    methodVersion: config.methodVersion,
    inputsHash,
  };

  // 4. Evidence gates. Note what is NOT here: how long it has been since the
  //    last event. Recency is detection's input, never a condition on the
  //    baseline's existence (R4) - a long silence must not delete the very
  //    rhythm that makes the silence meaningful.
  const reasons: GateFailure[] = [];
  if (days.length < config.minEvents) {
    reasons.push({ code: "INSUFFICIENT_EVENTS", have: days.length, need: config.minEvents });
  }
  if (spanDays < config.minSpanDays) {
    reasons.push({ code: "INSUFFICIENT_SPAN", haveDays: spanDays, needDays: config.minSpanDays });
  }
  if (gaps.length < config.minDistinctGaps) {
    reasons.push({ code: "INSUFFICIENT_GAPS", have: gaps.length, need: config.minDistinctGaps });
  }

  if (reasons.length > 0) {
    return {
      ...base,
      status: "NO_BASELINE",
      medianGapDays: null,
      madDays: null,
      dispersion: null,
      reasons,
    };
  }

  // 5. Robust statistics.
  const medianGapDays = median(gaps);
  const madDays = medianAbsoluteDeviation(gaps);

  // Defensive: the gates guarantee at least three gaps, and distinct sorted
  // days cannot produce a zero gap, so a zero median should be unreachable.
  // Treating it as irregular is the safe reading if it ever happens.
  if (medianGapDays <= 0) {
    return {
      ...base,
      status: "IRREGULAR",
      medianGapDays,
      madDays,
      dispersion: null,
      reasons: [],
    };
  }

  const dispersion = madDays / medianGapDays;

  // 6. Regular enough to call a rhythm?
  if (dispersion > config.maxDispersion) {
    return {
      ...base,
      status: "IRREGULAR",
      medianGapDays,
      madDays,
      dispersion,
      reasons: [],
    };
  }

  return {
    ...base,
    status: "ACTIVE",
    medianGapDays,
    madDays,
    dispersion,
    reasons: [],
  };
}

/**
 * How long silence may run before it departs from the rhythm.
 *
 * DERIVED, never stored. The frozen architecture keeps this in the detector
 * layer (docs/03 section 10.1), and persisting it would duplicate state that
 * can silently drift from the constants it came from. M3 exposes the function;
 * the debug view calls it for explainability, and M4's cadence_gap detector
 * will call this exact function rather than reading a column.
 *
 * The floors matter more than the statistical term. On a tight cadence the MAD
 * term is the SMALLEST of the four, so a single missed day would otherwise
 * fire - technically a deviation, socially absurd.
 */
export function computeCadenceThreshold(
  medianGapDays: number,
  madDays: number,
  config: BaselineConfig = baselineConfig,
): number {
  return Math.max(
    medianGapDays + config.madMultiplier * madDays,
    medianGapDays * config.medianMultiplier,
    medianGapDays + config.medianOffsetDays,
    config.absoluteFloorDays,
  );
}
