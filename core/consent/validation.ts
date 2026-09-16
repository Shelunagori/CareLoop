import { sha256Hex } from "@/core/share/text-hash";
import type { OpportunityStatus } from "./status";
import { deepEqual } from "./deep-equal";

/**
 * Consent validity and the send-time preconditions (docs/04 section 11.3).
 *
 * Pure. Every check is deterministic and every failure is fatal: a mismatch
 * means something changed after the user agreed, and the only safe response to
 * that is to not send. Nothing here re-renders, repairs, or falls back to a
 * freshly generated sentence.
 */

/**
 * Grant state is DERIVED from four timestamps, never stored as a column, so it
 * cannot drift out of sync with them (docs/02 section 4.1).
 */
export type GrantState = "active" | "used" | "revoked" | "expired";

export type GrantTimestamps = {
  expiresAt: string;
  usedAt: string | null;
  revokedAt: string | null;
};

export function grantState(grant: GrantTimestamps, now: Date): GrantState {
  // `used` first: once the send happened the action is complete and cannot be
  // un-performed, so a window passing afterwards is irrelevant (docs/04 s11.5).
  if (grant.usedAt !== null) return "used";
  if (grant.revokedAt !== null) return "revoked";
  // Boundary: exactly at expiry is EXPIRED. Authority to act has to end at a
  // defined instant, and "still valid at exactly 72h" is the fuzzier rule.
  if (now.getTime() >= Date.parse(grant.expiresAt)) return "expired";
  return "active";
}

export type SendPrecheckFailure =
  | "grant_already_used"
  | "grant_revoked"
  | "grant_expired"
  | "opportunity_not_approved"
  | "opportunity_draft_missing"
  | "snapshot_hash_mismatch"
  | "opportunity_hash_mismatch"
  | "rendered_text_mismatch"
  | "payload_mismatch";

export type SendPrecheckInput = {
  grant: GrantTimestamps & {
    renderedTextSnapshot: string;
    renderedTextHash: string;
    payloadSnapshot: unknown;
  };
  opportunity: {
    status: OpportunityStatus;
    renderedText: string | null;
    renderedTextHash: string | null;
    sharePayload: unknown;
  };
  now: Date;
};

export type SendPrecheck =
  | { ok: true; bytes: string }
  | { ok: false; failure: SendPrecheckFailure };

/**
 * The five preconditions, in the frozen order (docs/04 section 11.3), run
 * BEFORE any transaction opens and never inside the delivery step.
 *
 *  1. the grant is unused, unrevoked and within its window
 *  2. the opportunity is `approved`
 *  3. sha256(snapshot) matches the hash stored with it
 *  4. that hash matches the opportunity's stored hash
 *  5. the payload snapshot deep-equals the opportunity's payload
 *
 * Plus one the frozen list implies and this makes explicit: the opportunity's
 * stored text is byte-identical to the approved snapshot. Two strings can hash
 * the same in a world where someone edited one of them and recomputed a hash;
 * comparing the bytes costs nothing and closes that door.
 */
export function checkSendPreconditions(input: SendPrecheckInput): SendPrecheck {
  const state = grantState(input.grant, input.now);
  if (state === "used") return { ok: false, failure: "grant_already_used" };
  if (state === "revoked") return { ok: false, failure: "grant_revoked" };
  if (state === "expired") return { ok: false, failure: "grant_expired" };

  if (input.opportunity.status !== "approved") {
    return { ok: false, failure: "opportunity_not_approved" };
  }
  if (input.opportunity.renderedText === null || input.opportunity.renderedTextHash === null) {
    return { ok: false, failure: "opportunity_draft_missing" };
  }

  if (sha256Hex(input.grant.renderedTextSnapshot) !== input.grant.renderedTextHash) {
    return { ok: false, failure: "snapshot_hash_mismatch" };
  }
  if (input.grant.renderedTextHash !== input.opportunity.renderedTextHash) {
    return { ok: false, failure: "opportunity_hash_mismatch" };
  }
  if (input.grant.renderedTextSnapshot !== input.opportunity.renderedText) {
    return { ok: false, failure: "rendered_text_mismatch" };
  }
  if (!deepEqual(input.grant.payloadSnapshot, input.opportunity.sharePayload)) {
    return { ok: false, failure: "payload_mismatch" };
  }

  // The bytes that will be sent. Returned from the check so the caller cannot
  // reach for a different string by accident.
  return { ok: true, bytes: input.grant.renderedTextSnapshot };
}

export type ApprovalPrecheckFailure =
  | "opportunity_not_offered"
  | "opportunity_expired"
  | "opportunity_draft_missing";

/** What must hold before `offered -> approved` (this milestone's section 6). */
export function checkApprovalPreconditions(input: {
  opportunity: {
    status: OpportunityStatus;
    expiresAt: string;
    renderedText: string | null;
    renderedTextHash: string | null;
    sharePayload: unknown;
  };
  now: Date;
}): { ok: true } | { ok: false; failure: ApprovalPrecheckFailure } {
  if (input.opportunity.status !== "offered") {
    return { ok: false, failure: "opportunity_not_offered" };
  }
  if (input.now.getTime() >= Date.parse(input.opportunity.expiresAt)) {
    return { ok: false, failure: "opportunity_expired" };
  }
  if (
    input.opportunity.renderedText === null ||
    input.opportunity.renderedTextHash === null ||
    input.opportunity.sharePayload === null ||
    input.opportunity.sharePayload === undefined
  ) {
    return { ok: false, failure: "opportunity_draft_missing" };
  }
  return { ok: true };
}
