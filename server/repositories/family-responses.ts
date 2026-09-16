import type { Json } from "@/server/db/types.generated";
import type { Db } from "./db";

/**
 * The family member's reply, as received.
 *
 * `raw_body` is what they actually chose or wrote; `parsed` is the structured
 * reading. Both are kept: provenance means being able to show the words next
 * to the interpretation, not only the interpretation.
 */
export type FamilyResponseRecord = {
  id: string;
  requestId: string;
  rawBody: string;
  parsed: unknown;
  receivedAt: string;
};

export type FamilyResponsesRepo = {
  findByRequest(requestId: string): Promise<FamilyResponseRecord | null>;
  findById(id: string): Promise<FamilyResponseRecord | null>;
};

const SELECT = "id, request_id, raw_body, parsed, received_at";

type Row = {
  id: string;
  request_id: string;
  raw_body: string;
  parsed: Json;
  received_at: string;
};

export const toFamilyResponseRecord = (row: Row): FamilyResponseRecord => ({
  id: row.id,
  requestId: row.request_id,
  rawBody: row.raw_body,
  parsed: row.parsed,
  receivedAt: row.received_at,
});

export function familyResponsesRepo(db: Db): FamilyResponsesRepo {
  return {
    async findByRequest(requestId) {
      const { data, error } = await db
        .from("family_responses")
        .select(SELECT)
        .eq("request_id", requestId)
        .maybeSingle();
      if (error) throw new Error(`findFamilyResponse failed: ${error.message}`);
      return data ? toFamilyResponseRecord(data) : null;
    },

    async findById(id) {
      const { data, error } = await db
        .from("family_responses")
        .select(SELECT)
        .eq("id", id)
        .maybeSingle();
      if (error) throw new Error(`findFamilyResponseById failed: ${error.message}`);
      return data ? toFamilyResponseRecord(data) : null;
    },
  };
}
