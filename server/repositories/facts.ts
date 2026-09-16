import type { Database } from "@/server/db/types.generated";
import type { Db } from "./db";

type EvidenceStatus = Database["public"]["Enums"]["evidence_status"];

export type FactRecord = {
  id: string;
  subjectEntityId: string | null;
  key: string;
  value: string;
  status: EvidenceStatus;
  evidenceCount: number;
  sourceObservationIds: string[];
  sourceConversationIds: string[];
};

export type FactsRepo = {
  listForSubject(userId: string, subjectEntityId: string | null, limit: number): Promise<FactRecord[]>;
  find(input: { userId: string; subjectEntityId: string | null; key: string }): Promise<FactRecord | null>;
  create(input: {
    userId: string;
    subjectEntityId: string | null;
    key: string;
    value: string;
    confidence: number;
    status: EvidenceStatus;
    evidenceCount: number;
    sourceObservationIds: string[];
    sourceConversationIds: string[];
  }): Promise<FactRecord>;
  updateEvidence(input: {
    id: string;
    value: string;
    status: EvidenceStatus;
    evidenceCount: number;
    sourceObservationIds: string[];
    sourceConversationIds: string[];
  }): Promise<FactRecord>;
};

const SELECT =
  "id, subject_entity_id, key, value, status, evidence_count, source_observation_ids, source_conversation_ids";

/** Derived from the generated table Row — no column types restated here. */
type Row = Pick<
  Database["public"]["Tables"]["facts"]["Row"],
  | "id"
  | "subject_entity_id"
  | "key"
  | "value"
  | "status"
  | "evidence_count"
  | "source_observation_ids"
  | "source_conversation_ids"
>;

/** `value` is jsonb; M2 stores plain strings and reads them back defensively. */
function readValue(raw: unknown): string {
  return typeof raw === "string" ? raw : JSON.stringify(raw ?? "");
}

function toRecord(row: Row): FactRecord {
  return {
    id: row.id,
    subjectEntityId: row.subject_entity_id,
    key: row.key,
    value: readValue(row.value),
    status: row.status,
    evidenceCount: row.evidence_count,
    sourceObservationIds: row.source_observation_ids,
    sourceConversationIds: row.source_conversation_ids,
  };
}

export function factsRepo(db: Db): FactsRepo {
  return {
    async listForSubject(userId, subjectEntityId, limit) {
      let query = db.from("facts").select(SELECT).eq("user_id", userId);
      query = subjectEntityId === null
        ? query.is("subject_entity_id", null)
        : query.eq("subject_entity_id", subjectEntityId);
      const { data, error } = await query.order("key", { ascending: true }).limit(limit);
      if (error) throw new Error(`listFacts failed: ${error.message}`);
      return (data ?? []).map(toRecord);
    },

    async find({ userId, subjectEntityId, key }) {
      let query = db.from("facts").select(SELECT).eq("user_id", userId).eq("key", key);
      query = subjectEntityId === null
        ? query.is("subject_entity_id", null)
        : query.eq("subject_entity_id", subjectEntityId);
      const { data, error } = await query.maybeSingle();
      if (error) throw new Error(`findFact failed: ${error.message}`);
      return data ? toRecord(data) : null;
    },

    async create(input) {
      const { data, error } = await db
        .from("facts")
        .insert({
          user_id: input.userId,
          subject_entity_id: input.subjectEntityId,
          key: input.key,
          value: input.value,
          confidence: input.confidence,
          status: input.status,
          evidence_count: input.evidenceCount,
          source_observation_ids: input.sourceObservationIds,
          source_conversation_ids: input.sourceConversationIds,
        })
        .select(SELECT)
        .single();
      if (error) throw new Error(`createFact failed: ${error.message}`);
      return toRecord(data);
    },

    async updateEvidence(input) {
      const { data, error } = await db
        .from("facts")
        .update({
          value: input.value,
          status: input.status,
          evidence_count: input.evidenceCount,
          source_observation_ids: input.sourceObservationIds,
          source_conversation_ids: input.sourceConversationIds,
        })
        .eq("id", input.id)
        .select(SELECT)
        .single();
      if (error) throw new Error(`updateFact failed: ${error.message}`);
      return toRecord(data);
    },
  };
}
