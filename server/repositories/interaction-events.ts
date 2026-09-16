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
};

const SELECT =
  "id, entity_id, event_type, occurred_at, occurred_at_precision, reported_at, certainty, polarity, window_start, window_end, ingest_fingerprint";

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
      return (data ?? []).map((row) => ({
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
        ingestFingerprint: row.ingest_fingerprint,
      }));
    },
  };
}
