import { baselineConfig } from "@/core/baseline/config";
import { computeCadenceThreshold, type Baseline } from "@/core/baseline/compute";
import { DAY_MS, utcDayKey } from "@/core/baseline/day";
import type { EntitiesRepo } from "@/server/repositories/entities";
import { readBaseline, toBaselineInput, type BaselineDeps, type BaselineSource } from "./baseline";
import { computeBaseline } from "@/core/baseline/compute";

/**
 * The derivation view (docs/03 section 8.3).
 *
 * It recomputes from the stored events through the SAME pure function the
 * ingestion path uses, rather than reading the persisted baseline row. That is
 * the point: a baseline you cannot reproduce is a rumour, not evidence, so the
 * inspector proves the stored value rather than restating it.
 */
export type SeriesDerivation = {
  entityId: string;
  entityName: string;
  eventType: "visit" | "call";
  qualifyingEvents: Array<{
    occurredAt: string;
    reportedAt: string;
    precision: string;
    certainty: number;
  }>;
  excludedEvents: Array<{ occurredAt: string; reason: string }>;
  statisticalDays: string[];
  gaps: number[];
  evidenceCount: number;
  statisticalDayCount: number;
  spanDays: number;
  medianGapDays: number | null;
  madDays: number | null;
  dispersion: number | null;
  status: Baseline["status"];
  /**
   * DERIVED for display, never persisted. computeCadenceThreshold is the same
   * function M4's cadence_gap detector will call, so what is shown here is
   * what detection will use - but no column holds it.
   */
  derivedThresholdDays: number | null;
  /** Whether the stored row was fresh, or lazily recomputed on this read. */
  baselineSource: BaselineSource;
  /** When the value the read returned was computed. */
  baselineComputedAt: string;
  /** True when the live derivation disagrees with what the read returned. */
  persistedDisagrees: boolean;
  reasons: Baseline["reasons"];
  methodVersion: string;
  inputsHash: string;
};

export type BaselineDebugDeps = BaselineDeps & {
  entities: EntitiesRepo;
};

const EVENT_TYPES = ["visit", "call"] as const;

export async function loadBaselineDerivations(
  deps: BaselineDebugDeps,
  input: { userId: string; now: Date },
): Promise<SeriesDerivation[]> {
  const entities = await deps.entities.listForUser(input.userId, 200);
  const sinceIso = new Date(
    input.now.getTime() - baselineConfig.lookbackDays * DAY_MS,
  ).toISOString();

  const derivations: SeriesDerivation[] = [];

  for (const entity of entities) {
    for (const eventType of EVENT_TYPES) {
      const series = await deps.interactionEvents.listForSeries({
        userId: input.userId,
        entityId: entity.id,
        eventType,
        sinceIso,
      });
      if (series.length === 0) continue;

      // Read through the lazy-staleness path, so opening /debug exercises the
      // same refresh a detector read would.
      const read = await readBaseline(deps, {
        userId: input.userId,
        entityId: entity.id,
        eventType,
      });

      // Then derive live from the same stored evidence. A baseline you cannot
      // reproduce is a rumour, not evidence - so the view recomputes rather
      // than restating the row.
      const baseline = computeBaseline(series.map(toBaselineInput), input.now);

      const qualifies = (row: (typeof series)[number]) =>
        row.polarity === "positive" &&
        row.certainty >= baselineConfig.minCertainty &&
        (row.occurredAtPrecision === "exact" || row.occurredAtPrecision === "day");

      derivations.push({
        entityId: entity.id,
        entityName: entity.displayName,
        eventType,
        qualifyingEvents: series.filter(qualifies).map((row) => ({
          occurredAt: row.occurredAt,
          reportedAt: row.reportedAt,
          precision: row.occurredAtPrecision,
          certainty: row.certainty,
        })),
        excludedEvents: series
          .filter((row) => !qualifies(row))
          .map((row) => ({
            occurredAt: row.occurredAt,
            reason:
              row.polarity === "absence"
                ? "absence assertion (never positive cadence)"
                : row.certainty < baselineConfig.minCertainty
                  ? `certainty ${row.certainty} below ${baselineConfig.minCertainty}`
                  : `imprecise time (${row.occurredAtPrecision})`,
          })),
        statisticalDays: [
          ...new Set(series.filter(qualifies).map((row) => utcDayKey(new Date(row.occurredAt)))),
        ].sort(),
        gaps: baseline.gaps,
        evidenceCount: baseline.observationCount,
        statisticalDayCount: baseline.statisticalDayCount,
        spanDays: baseline.spanDays,
        medianGapDays: baseline.medianGapDays,
        madDays: baseline.madDays,
        dispersion: baseline.dispersion,
        status: baseline.status,
        derivedThresholdDays:
          baseline.status === "ACTIVE" &&
          baseline.medianGapDays !== null &&
          baseline.madDays !== null
            ? computeCadenceThreshold(baseline.medianGapDays, baseline.madDays)
            : null,
        baselineSource: read.source,
        baselineComputedAt: read.computedAt,
        persistedDisagrees:
          read.baseline.status !== baseline.status ||
          read.baseline.inputsHash !== baseline.inputsHash,
        reasons: baseline.reasons,
        methodVersion: baseline.methodVersion,
        inputsHash: baseline.inputsHash,
      });
    }
  }

  return derivations;
}
