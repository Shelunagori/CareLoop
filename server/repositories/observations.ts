import type { Json } from "@/server/db/types.generated";
import type { Db } from "./db";

/**
 * The observation RECORD is append-only in the part that matters: the raw
 * model output. `payload`, `confidence`, `source_span`, `model` and `prompt_id`
 * are written once at insert and never updated — that is "the model said this"
 * (docs/02 §4.1).
 *
 * Processing METADATA is deliberately mutable: `processed_at` and `resolution`
 * are written afterwards by the deterministic layer to record what the system
 * decided to do with the observation. So the row is not frozen; the provenance
 * within it is. Saying "observations are immutable" without that distinction
 * would be wrong about a table this repository updates on every ingestion.
 */
export type ObservationRecord = {
  id: string;
  sourceMessageId: string;
  kind: string;
  payload: Json;
  confidence: number | null;
  processedAt: string | null;
};

export type ObservationsRepo = {
  /** Replay safety: an already-extracted message is never re-extracted. */
  findByMessage(userId: string, sourceMessageId: string, kind: string): Promise<ObservationRecord | null>;
  /**
   * Provenance read: the raw payload behind one derived row. Scoped by user in
   * the WHERE clause, not checked afterwards - there is no code path that
   * reads an observation without saying whose it is.
   */
  findById(userId: string, id: string): Promise<ObservationRecord | null>;
  insert(input: {
    userId: string;
    sourceMessageId: string;
    kind: string;
    payload: Json;
    confidence: number | null;
    sourceSpan: string | null;
    model: string;
    promptId: string;
  }): Promise<ObservationRecord>;
  markProcessed(id: string, resolution: Json): Promise<void>;
};

export function observationsRepo(db: Db): ObservationsRepo {
  const select = "id, source_message_id, kind, payload, confidence, processed_at";

  const toRecord = (row: {
    id: string;
    source_message_id: string;
    kind: string;
    payload: Json;
    confidence: number | null;
    processed_at: string | null;
  }): ObservationRecord => ({
    id: row.id,
    sourceMessageId: row.source_message_id,
    kind: row.kind,
    payload: row.payload,
    confidence: row.confidence,
    processedAt: row.processed_at,
  });

  return {
    async findByMessage(userId, sourceMessageId, kind) {
      const { data, error } = await db
        .from("observations")
        .select(select)
        .eq("user_id", userId)
        .eq("source_message_id", sourceMessageId)
        .eq("kind", kind)
        .maybeSingle();
      if (error) throw new Error(`findObservation failed: ${error.message}`);
      return data ? toRecord(data) : null;
    },

    async findById(userId, id) {
      const { data, error } = await db
        .from("observations")
        .select(select)
        .eq("user_id", userId)
        .eq("id", id)
        .maybeSingle();
      if (error) throw new Error(`findObservationById failed: ${error.message}`);
      return data ? toRecord(data) : null;
    },

    async insert(input) {
      const { data, error } = await db
        .from("observations")
        .insert({
          user_id: input.userId,
          source_message_id: input.sourceMessageId,
          kind: input.kind,
          payload: input.payload,
          confidence: input.confidence,
          source_span: input.sourceSpan,
          model: input.model,
          prompt_id: input.promptId,
        })
        .select(select)
        .single();
      if (error) throw new Error(`insertObservation failed: ${error.message}`);
      return toRecord(data);
    },

    async markProcessed(id, resolution) {
      const { error } = await db
        .from("observations")
        .update({
          processed_at: new Date().toISOString(),
          resolution,
        })
        .eq("id", id);
      if (error) throw new Error(`markProcessed failed: ${error.message}`);
    },
  };
}
