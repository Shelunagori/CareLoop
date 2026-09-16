import type { Json } from "@/server/db/types.generated";
import type { Db } from "./db";

/**
 * Consent grants.
 *
 * There is no status column, by design: validity is DERIVED from used_at,
 * revoked_at and expires_at by one pure function (core/consent/validation), so
 * it cannot drift out of sync with them. This repository therefore never
 * writes a state - it writes timestamps, conditionally.
 *
 * UNIQUE(opportunity_id) makes "one grant per approval cycle" structural: a
 * duplicated approval request cannot mint a second grant, whatever the caller
 * does.
 */
export type ConsentGrantRecord = {
  id: string;
  opportunityId: string;
  scope: unknown;
  payloadSnapshot: unknown;
  renderedTextSnapshot: string;
  renderedTextHash: string;
  grantingMessageId: string | null;
  grantedAt: string;
  expiresAt: string;
  usedAt: string | null;
  revokedAt: string | null;
};

export type ConsentGrantsRepo = {
  /**
   * Idempotent on opportunity_id. A racing second approval reloads the first
   * grant rather than creating another - the user consented once.
   */
  create(input: {
    userId: string;
    opportunityId: string;
    scope: Json;
    payloadSnapshot: Json;
    renderedTextSnapshot: string;
    renderedTextHash: string;
    grantingMessageId: string | null;
    grantedAt: string;
    expiresAt: string;
  }): Promise<{ grant: ConsentGrantRecord; created: boolean }>;
  findByOpportunity(opportunityId: string): Promise<ConsentGrantRecord | null>;
  /** Conditional on the grant still being unused, unrevoked and in window. */
  markUsed(input: { id: string; now: string }): Promise<ConsentGrantRecord | null>;
  markRevoked(input: { id: string; now: string }): Promise<ConsentGrantRecord | null>;
};

const SELECT =
  "id, opportunity_id, scope, payload_snapshot, rendered_text_snapshot, rendered_text_hash, granting_message_id, granted_at, expires_at, used_at, revoked_at";

type Row = {
  id: string;
  opportunity_id: string;
  scope: Json;
  payload_snapshot: Json;
  rendered_text_snapshot: string;
  rendered_text_hash: string;
  granting_message_id: string | null;
  granted_at: string;
  expires_at: string;
  used_at: string | null;
  revoked_at: string | null;
};

function toRecord(row: Row): ConsentGrantRecord {
  return {
    id: row.id,
    opportunityId: row.opportunity_id,
    scope: row.scope,
    payloadSnapshot: row.payload_snapshot,
    renderedTextSnapshot: row.rendered_text_snapshot,
    renderedTextHash: row.rendered_text_hash,
    grantingMessageId: row.granting_message_id,
    grantedAt: row.granted_at,
    expiresAt: row.expires_at,
    usedAt: row.used_at,
    revokedAt: row.revoked_at,
  };
}

export function consentGrantsRepo(db: Db): ConsentGrantsRepo {
  return {
    async create(input) {
      const existing = await db
        .from("consent_grants")
        .select(SELECT)
        .eq("opportunity_id", input.opportunityId)
        .maybeSingle();
      if (existing.error) throw new Error(`findConsentGrant failed: ${existing.error.message}`);
      if (existing.data) return { grant: toRecord(existing.data), created: false };

      const { data, error } = await db
        .from("consent_grants")
        .insert({
          user_id: input.userId,
          opportunity_id: input.opportunityId,
          scope: input.scope,
          payload_snapshot: input.payloadSnapshot,
          rendered_text_snapshot: input.renderedTextSnapshot,
          rendered_text_hash: input.renderedTextHash,
          granting_message_id: input.grantingMessageId,
          granted_at: input.grantedAt,
          expires_at: input.expiresAt,
        })
        .select(SELECT)
        .maybeSingle();

      if (error) {
        // Lost the race on UNIQUE(opportunity_id): the other transaction's
        // grant is the one consent attaches to. Reload rather than fail.
        const reloaded = await db
          .from("consent_grants")
          .select(SELECT)
          .eq("opportunity_id", input.opportunityId)
          .maybeSingle();
        if (reloaded.data) return { grant: toRecord(reloaded.data), created: false };
        throw new Error(`createConsentGrant failed: ${error.message}`);
      }
      if (!data) throw new Error("createConsentGrant returned no row");
      return { grant: toRecord(data), created: true };
    },

    async findByOpportunity(opportunityId) {
      const { data, error } = await db
        .from("consent_grants")
        .select(SELECT)
        .eq("opportunity_id", opportunityId)
        .maybeSingle();
      if (error) throw new Error(`findConsentGrant failed: ${error.message}`);
      return data ? toRecord(data) : null;
    },

    async markUsed({ id, now }) {
      const { data, error } = await db
        .from("consent_grants")
        .update({ used_at: now })
        .eq("id", id)
        // Single use, never revoked, never past the window. The predicates are
        // the enforcement; the pure precheck is the explanation.
        .is("used_at", null)
        .is("revoked_at", null)
        .gt("expires_at", now)
        .select(SELECT)
        .maybeSingle();
      if (error) throw new Error(`markGrantUsed failed: ${error.message}`);
      return data ? toRecord(data) : null;
    },

    async markRevoked({ id, now }) {
      const { data, error } = await db
        .from("consent_grants")
        .update({ revoked_at: now })
        .eq("id", id)
        .is("used_at", null)
        .is("revoked_at", null)
        .select(SELECT)
        .maybeSingle();
      if (error) throw new Error(`markGrantRevoked failed: ${error.message}`);
      return data ? toRecord(data) : null;
    },
  };
}
