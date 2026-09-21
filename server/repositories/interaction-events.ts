import type { Database } from "@/server/db/types.generated";
import type { Db } from "./db";

type EventType = Database["public"]["Enums"]["event_type"];
type Polarity = Database["public"]["Enums"]["event_polarity"];
type TimePrecision = Database["public"]["Enums"]["time_precision"];

/** The spine the pattern engine reads. Never episode text, never the model. */
export type InteractionEventInput = {
  userId: string;
  entityId: string;
  eventType: EventType;
  occurredAt: string;
  occurredAtPrecision: TimePrecision;
  reportedAt: string;
  certainty: number;
  polarity: Polarity;
  windowStart: string | null;
  windowEnd: string | null;
  sourceObservationId: string | null;
  ingestFingerprint: string;
};

export type InteractionEventRecord = {
  id: string;
  entityId: string;
  eventType: EventType;
  occurredAt: string;
  occurredAtPrecision: TimePrecision;
  reportedAt: string;
  certainty: number;
  polarity: Polarity;
  windowStart: string | null;
  windowEnd: string | null;
  /** Provenance: the immutable observation this row was derived from. */
  sourceObservationId: string | null;
  ingestFingerprint: string;
};

export type InteractionEventsRepo = {
  /**
   * Idempotent on (user_id, ingest_fingerprint). A replayed observation
   * therefore writes nothing new, enforced by the database rather than by the
   * caller remembering to check.
   */
  insertMany(events: readonly InteractionEventInput[]): Promise<void>;
  /** Everything for one (entity, event_type) since a cutoff, oldest first. */
  listForSeries(input: {
    userId: string;
    entityId: string;
    eventType: EventType;
    sinceIso: string;
  }): Promise<InteractionEventRecord[]>;
  /**
   * Absence assertions reported within a bounded recent window, newest first.
   *
   * Keyed on `reported_at`, not `occurred_at`: the detector is asking "what
   * has this person told us lately", which is a freshness question, and the
   * occurred/reported split exists precisely so those two are not confused
   * (docs/02 section 7).
   */
  listRecentAbsences(input: {
    userId: string;
    sinceReportedIso: string;
    limit: number;
  }): Promise<InteractionEventRecord[]>;
  /** Oldest recorded contact for this user, or null. Cold-start input. */
  earliestOccurredAt(userId: string): Promise<string | null>;
  /**
   * Positive events since a cutoff, newest first, across every entity.
   *
   * The one source allowed to power a proactive opening (core/opening).
   * Filtered to `positive` in the QUERY rather than after it: an absence
   * assertion must not be able to reach that code path even by accident,
   * and a filter in SQL is harder to drop than a filter in a map.
   */
  listRecentPositive(input: {
    userId: string;
    sinceOccurredIso: string;
    limit: number;
  }): Promise<InteractionEventRecord[]>;
};

const SELECT =
  "id, entity_id, event_type, occurred_at, occurred_at_precision, reported_at, certainty, polarity, window_start, window_end, source_observation_id, ingest_fingerprint";

type Row = {
  id: string;
  entity_id: string;
  event_type: EventType;
  occurred_at: string;
  occurred_at_precision: TimePrecision;
  reported_at: string;
  certainty: number | string;
  polarity: Polarity;
  window_start: string | null;
  window_end: string | null;
  source_observation_id: string | null;
  ingest_fingerprint: string;
};

function toRecord(row: Row): InteractionEventRecord {
  return {
    id: row.id,
    entityId: row.entity_id,
    eventType: row.event_type,
    occurredAt: row.occurred_at,
    occurredAtPrecision: row.occurred_at_precision,
    reportedAt: row.reported_at,
    certainty: Number(row.certainty),
    polarity: row.polarity,
    windowStart: row.window_start,
    windowEnd: row.window_end,
    sourceObservationId: row.source_observation_id,
    ingestFingerprint: row.ingest_fingerprint,
  };
}

export function interactionEventsRepo(db: Db): InteractionEventsRepo {
  return {
    async insertMany(events) {
      if (events.length === 0) return;
      const rows = events.map((event) => ({
        user_id: event.userId,
        entity_id: event.entityId,
        event_type: event.eventType,
        occurred_at: event.occurredAt,
        occurred_at_precision: event.occurredAtPrecision,
        reported_at: event.reportedAt,
        certainty: event.certainty,
        polarity: event.polarity,
        window_start: event.windowStart,
        window_end: event.windowEnd,
        source_observation_id: event.sourceObservationId,
        ingest_fingerprint: event.ingestFingerprint,
      }));

      const { error } = await db
        .from("interaction_events")
        .upsert(rows, {
          onConflict: "user_id,ingest_fingerprint",
          ignoreDuplicates: true,
        });
      if (error) throw new Error(`insertInteractionEvents failed: ${error.message}`);
    },

    async listForSeries({ userId, entityId, eventType, sinceIso }) {
      const { data, error } = await db
        .from("interaction_events")
        .select(SELECT)
        .eq("user_id", userId)
        .eq("entity_id", entityId)
        .eq("event_type", eventType)
        .gte("occurred_at", sinceIso)
        .order("occurred_at", { ascending: true });
      if (error) throw new Error(`listInteractionEvents failed: ${error.message}`);
      return (data ?? []).map(toRecord);
    },

    async listRecentAbsences({ userId, sinceReportedIso, limit }) {
      const { data, error } = await db
        .from("interaction_events")
        .select(SELECT)
        .eq("user_id", userId)
        .eq("polarity", "absence")
        .gte("reported_at", sinceReportedIso)
        .order("reported_at", { ascending: false })
        .limit(limit);
      if (error) throw new Error(`listRecentAbsences failed: ${error.message}`);
      return (data ?? []).map(toRecord);
    },

    async listRecentPositive({ userId, sinceOccurredIso, limit }) {
      const { data, error } = await db
        .from("interaction_events")
        .select(SELECT)
        .eq("user_id", userId)
        .eq("polarity", "positive")
        .gte("occurred_at", sinceOccurredIso)
        .order("occurred_at", { ascending: false })
        .limit(limit);
      if (error) throw new Error(`listRecentPositive failed: ${error.message}`);
      return (data ?? []).map(toRecord);
    },

    async earliestOccurredAt(userId) {
      const { data, error } = await db
        .from("interaction_events")
        .select("occurred_at")
        .eq("user_id", userId)
        .order("occurred_at", { ascending: true })
        .limit(1)
        .maybeSingle();
      if (error) throw new Error(`earliestInteractionEvent failed: ${error.message}`);
      return data ? data.occurred_at : null;
    },
  };
}
