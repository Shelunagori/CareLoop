import { z } from "zod";
import {
  OPEN_OPPORTUNITY_STATUSES,
  type OpportunityStatus,
} from "@/core/consent/status";
import type { Db } from "./db";
import type { Database, Json } from "@/server/db/types.generated";

/**
 * Reconnect opportunities.
 *
 * Two things in here are structural rather than conventional, and both are
 * deliberate: materialization goes through a database function because it must
 * be one transaction, and the draft write is a CONDITIONAL update because two
 * racing drafts must not overwrite each other's bytes (docs/04 section 11.3 —
 * consent attaches to exact bytes, so "last writer wins" would mean the user
 * could approve a string that is no longer stored).
 */
export type OpportunityRecord = {
  id: string;
  signalId: string;
  entityId: string;
  proposal: unknown;
  sharePayload: unknown;
  renderedText: string | null;
  renderedTextHash: string | null;
  status: OpportunityStatus;
  offeredAt: string | null;
  resolvedAt: string | null;
  expiresAt: string;
  createdAt: string;
};

export type MaterializeOutcome =
  | "materialized"
  | "reloaded"
  | "blocked_open_opportunity"
  | "signal_not_detected"
  | "signal_not_found"
  /**
   * The three below mean the arguments did not describe a consistent, owned
   * row. They are integrity failures rather than ordinary flow: the function
   * establishes identity from the signal itself and refuses the call. See the
   * migration's ARGUMENT TRUST MODEL note.
   */
  | "signal_entity_mismatch"
  | "entity_not_found"
  | "invalid_expiry";

export type MaterializeResult = {
  outcome: MaterializeOutcome;
  opportunityId: string | null;
};

/**
 * The RPC returns jsonb, which is `unknown` to us no matter how the client is
 * typed, so it is parsed rather than cast. Same reasoning as running zod over
 * a model response: the shape is guaranteed by the other side, our invariants
 * are not.
 */
const MaterializeResultSchema = z.object({
  outcome: z.enum([
    "materialized",
    "reloaded",
    "blocked_open_opportunity",
    "signal_not_detected",
    "signal_not_found",
    "signal_entity_mismatch",
    "entity_not_found",
    "invalid_expiry",
  ]),
  opportunityId: z.string().uuid().nullable(),
});

export type OpportunitiesRepo = {
  /**
   * One transaction: insert the opportunity AND flip the signal to
   * `materialized`. See supabase/migrations/..._m4_materialize_signal.sql for
   * why this cannot be two PostgREST calls.
   */
  materialize(input: {
    signalId: string;
    userId: string;
    entityId: string;
    /** Written verbatim into reconnect_opportunities.proposal (jsonb). */
    proposal: Json;
    expiresAt: string;
    now: string;
  }): Promise<MaterializeResult>;
  findById(id: string): Promise<OpportunityRecord | null>;
  findBySignal(signalId: string): Promise<OpportunityRecord | null>;
  listOpenForUser(userId: string, limit: number): Promise<OpportunityRecord[]>;
  /** Bounded window over resolved/offered history, for suppression + debug. */
  listRecentForUser(
    userId: string,
    sinceIso: string,
    limit: number,
  ): Promise<OpportunityRecord[]>;
  /**
   * Persists payload + draft + hash, conditional on the opportunity still
   * being `proposed` and still offerable. Returns null when the condition
   * failed — the caller reloads the stored winner rather than overwriting it.
   */
  saveDraft(input: {
    id: string;
    sharePayload: Json;
    renderedText: string;
    renderedTextHash: string;
    now: string;
  }): Promise<OpportunityRecord | null>;
  /** Terminal, conditional on the row being pre-approval. Never extends. */
  markExpired(id: string, now: string): Promise<void>;
};

const SELECT =
  "id, signal_id, entity_id, proposal, share_payload, rendered_text, rendered_text_hash, status, offered_at, resolved_at, expires_at, created_at";

type Row = Pick<
  Database["public"]["Tables"]["reconnect_opportunities"]["Row"],
  | "id"
  | "signal_id"
  | "entity_id"
  | "proposal"
  | "share_payload"
  | "rendered_text"
  | "rendered_text_hash"
  | "status"
  | "offered_at"
  | "resolved_at"
  | "expires_at"
  | "created_at"
>;

function toRecord(row: Row): OpportunityRecord {
  return {
    id: row.id,
    signalId: row.signal_id,
    entityId: row.entity_id,
    proposal: row.proposal,
    sharePayload: row.share_payload,
    renderedText: row.rendered_text,
    renderedTextHash: row.rendered_text_hash,
    status: row.status,
    offeredAt: row.offered_at,
    resolvedAt: row.resolved_at,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
  };
}

export function opportunitiesRepo(db: Db): OpportunitiesRepo {
  return {
    async materialize(input) {
      // Called straight off the client. `const rpc = db.rpc` would detach the
      // method from its receiver, and supabase-js reads instance state
      // internally, so the detached call dies on `undefined.rest` at runtime
      // while typechecking perfectly. Never extract a client method.
      const { data, error } = await db.rpc("materialize_signal", {
        p_signal_id: input.signalId,
        p_user_id: input.userId,
        p_entity_id: input.entityId,
        p_proposal: input.proposal,
        p_expires_at: input.expiresAt,
        p_now: input.now,
      });
      if (error) throw new Error(`materialize_signal failed: ${error.message}`);
      const parsed = MaterializeResultSchema.safeParse(data);
      if (!parsed.success) {
        throw new Error("materialize_signal returned an unrecognised result shape");
      }
      return parsed.data;
    },

    async findById(id) {
      const { data, error } = await db
        .from("reconnect_opportunities")
        .select(SELECT)
        .eq("id", id)
        .maybeSingle();
      if (error) throw new Error(`findOpportunity failed: ${error.message}`);
      return data ? toRecord(data) : null;
    },

    async findBySignal(signalId) {
      const { data, error } = await db
        .from("reconnect_opportunities")
        .select(SELECT)
        .eq("signal_id", signalId)
        .maybeSingle();
      if (error) throw new Error(`findOpportunityBySignal failed: ${error.message}`);
      return data ? toRecord(data) : null;
    },

    async listOpenForUser(userId, limit) {
      const { data, error } = await db
        .from("reconnect_opportunities")
        .select(SELECT)
        .eq("user_id", userId)
        .in("status", [...OPEN_OPPORTUNITY_STATUSES])
        .order("created_at", { ascending: false })
        .limit(limit);
      if (error) throw new Error(`listOpenOpportunities failed: ${error.message}`);
      return (data ?? []).map(toRecord);
    },

    async listRecentForUser(userId, sinceIso, limit) {
      const { data, error } = await db
        .from("reconnect_opportunities")
        .select(SELECT)
        .eq("user_id", userId)
        .gte("created_at", sinceIso)
        .order("created_at", { ascending: false })
        .limit(limit);
      if (error) throw new Error(`listRecentOpportunities failed: ${error.message}`);
      return (data ?? []).map(toRecord);
    },

    async saveDraft(input) {
      const { data, error } = await db
        .from("reconnect_opportunities")
        .update({
          share_payload: input.sharePayload,
          rendered_text: input.renderedText,
          rendered_text_hash: input.renderedTextHash,
          status: "drafted",
        })
        .eq("id", input.id)
        // The whole optimistic-concurrency story is these two predicates: a
        // second drafter finds the row no longer `proposed` and writes nothing.
        .eq("status", "proposed")
        .gt("expires_at", input.now)
        .select(SELECT)
        .maybeSingle();
      if (error) throw new Error(`saveDraft failed: ${error.message}`);
      return data ? toRecord(data) : null;
    },

    async markExpired(id, now) {
      const { error } = await db
        .from("reconnect_opportunities")
        .update({ status: "expired", resolved_at: now })
        .eq("id", id)
        // Pre-approval statuses only. An approved or consumed opportunity has
        // its own clock (docs/04 section 11.5) and is not this path's business.
        .in("status", ["proposed", "drafted", "offered"])
        .lte("expires_at", now);
      if (error) throw new Error(`markOpportunityExpired failed: ${error.message}`);
    },
  };
}
