import type { Clock } from "@/server/adapters/clock";
import type { BaselinesRepo, StoredBaseline } from "@/server/repositories/baselines";
import type {
  InteractionEventsRepo,
  InteractionEventRecord,
} from "@/server/repositories/interaction-events";
import { baselineConfig } from "@/core/baseline/config";
import {
  computeBaseline,
  type Baseline,
  type BaselineDerivation,
  type BaselineInputEvent,
  type GateFailure,
} from "@/core/baseline/compute";
import { DAY_MS } from "@/core/baseline/day";

/**
 * Baseline read/write orchestration (docs/03 section 8.2).
 *
 * Two triggers, both targeted to one (entity, event_type) series:
 *  - recomputeSeries: an event was just derived for it.
 *  - readBaseline:    someone is reading it and the stored row is older than
 *                     the staleness window.
 *
 * The second exists because a baseline can go stale with NO new event: events
 * age out of the 180-day evidence window on their own. Recompute-on-write can
 * never notice that, because nothing was written.
 */
export type SeriesEventType = "visit" | "call";

export type BaselineDeps = {
  interactionEvents: InteractionEventsRepo;
  baselines: BaselinesRepo;
  clock: Clock;
};

export type SeriesRef = {
  userId: string;
  entityId: string;
  eventType: SeriesEventType;
};

/** The one place interaction rows become baseline inputs. */
export function toBaselineInput(row: InteractionEventRecord): BaselineInputEvent {
  return {
    id: row.id,
    occurredAt: new Date(row.occurredAt),
    occurredAtPrecision: row.occurredAtPrecision,
    certainty: row.certainty,
    polarity: row.polarity,
  };
}

function lookbackCutoff(now: Date): string {
  return new Date(now.getTime() - baselineConfig.lookbackDays * DAY_MS).toISOString();
}

/**
 * Rebuilds the in-memory Baseline a stored row represents.
 *
 * Every field is either persisted or derivable from persisted values, so this
 * is reconstruction rather than approximation. `dispersion` is recomputed from
 * median and MAD for the same reason the threshold is not stored: it is
 * derived state, and one source of truth beats two.
 */
export function fromStored(stored: StoredBaseline): Baseline {
  return {
    status: stored.status,
    medianGapDays: stored.medianGapDays,
    madDays: stored.madDays,
    dispersion:
      stored.medianGapDays !== null && stored.madDays !== null && stored.medianGapDays > 0
        ? stored.madDays / stored.medianGapDays
        : null,
    observationCount: stored.observationCount,
    windowStart: stored.windowStart ? new Date(stored.windowStart) : null,
    windowEnd: stored.windowEnd ? new Date(stored.windowEnd) : null,
    reasons: Array.isArray(stored.reasons) ? (stored.reasons as GateFailure[]) : [],
    methodVersion: stored.methodVersion,
    inputsHash: stored.inputsHash,
  };
}

/** Recomputes one series from stored evidence and persists the result. */
export async function recomputeSeries(
  deps: BaselineDeps,
  series: SeriesRef,
): Promise<BaselineDerivation> {
  const now = deps.clock.now();
  const rows = await deps.interactionEvents.listForSeries({
    ...series,
    sinceIso: lookbackCutoff(now),
  });

  const baseline = computeBaseline(rows.map(toBaselineInput), now);

  await deps.baselines.save({
    ...series,
    baseline,
    computedAt: now.toISOString(),
  });

  return baseline;
}

export function isStale(computedAt: string, now: Date): boolean {
  const ageMs = now.getTime() - Date.parse(computedAt);
  return ageMs >= baselineConfig.stalenessHours * 3_600_000;
}

export type BaselineSource = "persisted" | "recomputed_stale" | "recomputed_missing";

/**
 * One effective baseline, whatever its provenance.
 *
 * Callers use `result.baseline` and never have to branch on where it came
 * from. `source` and `computedAt` exist for the debug view and for tests, not
 * because anyone needs them to get an answer.
 */
export type BaselineReadResult = {
  baseline: Baseline;
  source: BaselineSource;
  /** When the value being returned was computed. */
  computedAt: string;
};

/**
 * Reads one series' baseline, lazily refreshing it when the stored row has
 * aged past the staleness window. Only the requested series is touched - a
 * read of John's visits never recomputes anyone else's anything.
 */
export async function readBaseline(
  deps: BaselineDeps,
  series: SeriesRef,
): Promise<BaselineReadResult> {
  const now = deps.clock.now();
  const stored = await deps.baselines.find(series);

  if (stored && !isStale(stored.computedAt, now)) {
    return { baseline: fromStored(stored), source: "persisted", computedAt: stored.computedAt };
  }

  const baseline = await recomputeSeries(deps, series);
  return {
    baseline,
    source: stored ? "recomputed_stale" : "recomputed_missing",
    computedAt: now.toISOString(),
  };
}
