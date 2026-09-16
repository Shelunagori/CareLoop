import type { Database } from "@/server/db/types.generated";
import type { Db } from "./db";

type EvidenceStatus = Database["public"]["Enums"]["evidence_status"];

export type RelationshipRecord = {
  id: string;
  fromEntityId: string | null;
  toEntityId: string;
  kind: string;
  status: EvidenceStatus;
  evidenceCount: number;
  sourceObservationIds: string[];
  sourceConversationIds: string[];
};

export type RelationshipsRepo = {
  listForUser(userId: string, limit: number): Promise<RelationshipRecord[]>;
  find(input: {
    userId: string;
    fromEntityId: string | null;
    toEntityId: string;
    kind: string;
  }): Promise<RelationshipRecord | null>;
  create(input: {
    userId: string;
    fromEntityId: string | null;
    toEntityId: string;
    kind: string;
    labelRaw: string | null;
    confidence: number;
    status: EvidenceStatus;
    evidenceCount: number;
    sourceObservationIds: string[];
    sourceConversationIds: string[];
  }): Promise<RelationshipRecord>;
  updateEvidence(input: {
    id: string;
    status: EvidenceStatus;
    evidenceCount: number;
    sourceObservationIds: string[];
    sourceConversationIds: string[];
    confirmedAt: string | null;
  }): Promise<RelationshipRecord>;
};

const SELECT =
  "id, from_entity_id, to_entity_id, kind, status, evidence_count, source_observation_ids, source_conversation_ids";

/** Derived from the generated table Row — no column types restated here. */
type Row = Pick<
  Database["public"]["Tables"]["relationships"]["Row"],
  | "id"
  | "from_entity_id"
  | "to_entity_id"
  | "kind"
  | "status"
  | "evidence_count"
  | "source_observation_ids"
  | "source_conversation_ids"
>;

function toRecord(row: Row): RelationshipRecord {
  return {
    id: row.id,
    fromEntityId: row.from_entity_id,
    toEntityId: row.to_entity_id,
    kind: row.kind,
    status: row.status,
    evidenceCount: row.evidence_count,
    sourceObservationIds: row.source_observation_ids,
    sourceConversationIds: row.source_conversation_ids,
  };
}

export function relationshipsRepo(db: Db): RelationshipsRepo {
  return {
    async listForUser(userId, limit) {
      const { data, error } = await db
        .from("relationships")
        .select(SELECT)
        .eq("user_id", userId)
        .limit(limit);
      if (error) throw new Error(`listRelationships failed: ${error.message}`);
      return (data ?? []).map(toRecord);
    },

    async find({ userId, fromEntityId, toEntityId, kind }) {
      // The unique index is on an expression (coalesce of a nullable FK), which
      // PostgREST cannot target with onConflict — hence find-then-write rather
      // than upsert. The per-conversation job lease is what keeps that safe.
      let query = db
        .from("relationships")
        .select(SELECT)
        .eq("user_id", userId)
        .eq("to_entity_id", toEntityId)
        .eq("kind", kind);
      query = fromEntityId === null
        ? query.is("from_entity_id", null)
        : query.eq("from_entity_id", fromEntityId);

      const { data, error } = await query.maybeSingle();
      if (error) throw new Error(`findRelationship failed: ${error.message}`);
      return data ? toRecord(data) : null;
    },

    async create(input) {
      const { data, error } = await db
        .from("relationships")
        .insert({
          user_id: input.userId,
          from_entity_id: input.fromEntityId,
          to_entity_id: input.toEntityId,
          kind: input.kind,
          label_raw: input.labelRaw,
          confidence: input.confidence,
          status: input.status,
          evidence_count: input.evidenceCount,
          source_observation_ids: input.sourceObservationIds,
          source_conversation_ids: input.sourceConversationIds,
        })
        .select(SELECT)
        .single();
      if (error) throw new Error(`createRelationship failed: ${error.message}`);
      return toRecord(data);
    },

    async updateEvidence(input) {
      const { data, error } = await db
        .from("relationships")
        .update({
          status: input.status,
          evidence_count: input.evidenceCount,
          source_observation_ids: input.sourceObservationIds,
          source_conversation_ids: input.sourceConversationIds,
          last_confirmed_at: input.confirmedAt,
        })
        .eq("id", input.id)
        .select(SELECT)
        .single();
      if (error) throw new Error(`updateRelationship failed: ${error.message}`);
      return toRecord(data);
    },
  };
}
