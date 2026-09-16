import type { Database } from "@/server/db/types.generated";
import type { Db } from "./db";
import type { Baseline } from "@/core/baseline/compute";

type EventType = Database["public"]["Enums"]["event_type"];

/**
 * Persisted baseline state is historical EVIDENCE and STATISTICS only.
 *
 * There is deliberately no threshold column. The cadence threshold is a pure
 * function of (median, MAD, config) and belongs to the detector layer
 * (docs/03 section 10.1); storing it would duplicate derived state that can
 * drift from the constants that produced it. Readers call
 * computeCadenceThreshold instead.
 */
export type StoredBaseline = {
  id: string;
  entityId: string;
  eventType: EventType;
  status: Database["public"]["Enums"]["baseline_status"];
  medianGapDays: number | null;
  madDays: number | null;
  observationCount: number;
  windowStart: string | null;
  windowEnd: string | null;
  reasons: unknown;
  methodVersion: string;
  inputsHash: string;
  computedAt: string;
};

export type BaselinesRepo = {
  /** One row per (user, entity, event_type) - upserted, never duplicated. */
  save(input: {
    userId: string;
    entityId: string;
    eventType: EventType;
    baseline: Baseline;
    /** Passed in, never `new Date()` here - the Clock seam owns time. */
    computedAt: string;
  }): Promise<void>;
  find(input: {
    userId: string;
    entityId: string;
    eventType: EventType;
  }): Promise<StoredBaseline | null>;
  listForUser(userId: string, limit: number): Promise<StoredBaseline[]>;
};

const SELECT =
  "id, entity_id, event_type, status, cadence_days_median, cadence_days_mad, observation_count, window_start, window_end, reasons, method_version, inputs_hash, computed_at";

type Row = Pick<
  Database["public"]["Tables"]["baselines"]["Row"],
  | "id"
  | "entity_id"
  | "event_type"
  | "status"
  | "cadence_days_median"
  | "cadence_days_mad"
  | "observation_count"
  | "window_start"
  | "window_end"
  | "reasons"
  | "method_version"
  | "inputs_hash"
  | "computed_at"
>;

function toRecord(row: Row): StoredBaseline {
  return {
    id: row.id,
    entityId: row.entity_id,
    eventType: row.event_type,
    status: row.status,
    medianGapDays: row.cadence_days_median === null ? null : Number(row.cadence_days_median),
    madDays: row.cadence_days_mad === null ? null : Number(row.cadence_days_mad),
    observationCount: row.observation_count,
    windowStart: row.window_start,
    windowEnd: row.window_end,
    reasons: row.reasons,
    methodVersion: row.method_version,
    inputsHash: row.inputs_hash,
    computedAt: row.computed_at,
  };
}

export function baselinesRepo(db: Db): BaselinesRepo {
  return {
    async save(input) {
      const { userId, entityId, eventType, baseline } = input;
      const { error } = await db.from("baselines").upsert(
        {
          user_id: userId,
          entity_id: entityId,
          event_type: eventType,
          status: baseline.status,
          cadence_days_median: baseline.medianGapDays,
          cadence_days_mad: baseline.madDays,
          observation_count: baseline.observationCount,
          window_start: baseline.windowStart ? baseline.windowStart.toISOString() : null,
          window_end: baseline.windowEnd ? baseline.windowEnd.toISOString() : null,
          reasons: baseline.reasons,
          method_version: baseline.methodVersion,
          inputs_hash: baseline.inputsHash,
          computed_at: input.computedAt,
        },
        { onConflict: "user_id,entity_id,event_type" },
      );
      if (error) throw new Error(`saveBaseline failed: ${error.message}`);
    },

    async find({ userId, entityId, eventType }) {
      const { data, error } = await db
        .from("baselines")
        .select(SELECT)
        .eq("user_id", userId)
        .eq("entity_id", entityId)
        .eq("event_type", eventType)
        .maybeSingle();
      if (error) throw new Error(`findBaseline failed: ${error.message}`);
      return data ? toRecord(data) : null;
    },

    async listForUser(userId, limit) {
      const { data, error } = await db
        .from("baselines")
        .select(SELECT)
        .eq("user_id", userId)
        .order("computed_at", { ascending: false })
        .limit(limit);
      if (error) throw new Error(`listBaselines failed: ${error.message}`);
      return (data ?? []).map(toRecord);
    },
  };
}
