import type { Database } from "@/server/db/types.generated";
import type { Db } from "./db";

type SignalType = Database["public"]["Enums"]["signal_type"];
type SignalStatus = Database["public"]["Enums"]["signal_status"];

/**
 * Signals are the audit row behind "why did / didn't CareLoop say anything?".
 * Every write here is either a new detection or one of exactly two outcomes of
 * the single suppression pass that runs at materialization (F3).
 */
export type SignalRecord = {
  id: string;
  entityId: string;
  baselineId: string | null;
  signalType: SignalType;
  status: SignalStatus;
  /** Structured derivation, never prose. Parsed by the caller. */
  explanation: unknown;
  detectedAt: string;
  suppressionReason: string | null;
  materializedAt: string | null;
};

export type SignalsRepo = {
  insert(input: {
    userId: string;
    entityId: string;
    baselineId: string | null;
    signalType: SignalType;
    explanation: unknown;
    /** Passed in — the Clock port owns time, not this layer. */
    detectedAt: string;
  }): Promise<SignalRecord>;
  /** Bounded history, for replay identity and the debug view. */
  listRecent(userId: string, sinceIso: string, limit: number): Promise<SignalRecord[]>;
  /**
   * Replay-safe by construction: conditional on the row still being
   * `detected`. A materialized signal is never demoted to suppressed by a
   * retried job arriving late.
   */
  markSuppressed(id: string, reason: string): Promise<void>;
};

const SELECT =
  "id, entity_id, baseline_id, signal_type, status, explanation, detected_at, suppression_reason, materialized_at";

type Row = Pick<
  Database["public"]["Tables"]["signals"]["Row"],
  | "id"
  | "entity_id"
  | "baseline_id"
  | "signal_type"
  | "status"
  | "explanation"
  | "detected_at"
  | "suppression_reason"
  | "materialized_at"
>;

function toRecord(row: Row): SignalRecord {
  return {
    id: row.id,
    entityId: row.entity_id,
    baselineId: row.baseline_id,
    signalType: row.signal_type,
    status: row.status,
    explanation: row.explanation,
    detectedAt: row.detected_at,
    suppressionReason: row.suppression_reason,
    materializedAt: row.materialized_at,
  };
}

export function signalsRepo(db: Db): SignalsRepo {
  return {
    async insert(input) {
      const { data, error } = await db
        .from("signals")
        .insert({
          user_id: input.userId,
          entity_id: input.entityId,
          baseline_id: input.baselineId,
          signal_type: input.signalType,
          explanation: input.explanation as never,
          detected_at: input.detectedAt,
          status: "detected",
        })
        .select(SELECT)
        .single();
      if (error) throw new Error(`insertSignal failed: ${error.message}`);
      return toRecord(data);
    },

    async listRecent(userId, sinceIso, limit) {
      const { data, error } = await db
        .from("signals")
        .select(SELECT)
        .eq("user_id", userId)
        .gte("detected_at", sinceIso)
        .order("detected_at", { ascending: false })
        .limit(limit);
      if (error) throw new Error(`listSignals failed: ${error.message}`);
      return (data ?? []).map(toRecord);
    },

    async markSuppressed(id, reason) {
      const { error } = await db
        .from("signals")
        .update({ status: "suppressed", suppression_reason: reason })
        .eq("id", id)
        .eq("status", "detected");
      if (error) throw new Error(`markSignalSuppressed failed: ${error.message}`);
    },
  };
}
