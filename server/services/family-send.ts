import type { Clock } from "@/server/adapters/clock";
import { familyConfig, familyRespondUrl } from "@/server/config";
import { logDelivery, type Notifier } from "@/server/adapters/notifier";
import type { ConsentGrantsRepo } from "@/server/repositories/consent-grants";
import type { EntitiesRepo } from "@/server/repositories/entities";
import type { FamilyContactRecord, FamilyContactsRepo } from "@/server/repositories/family-contacts";
import type { FamilyRequestRecord, FamilyRequestsRepo } from "@/server/repositories/family-requests";
import type { OpportunitiesRepo } from "@/server/repositories/opportunities";
import { callPendingRpc } from "@/server/repositories/rpc";
import type { Db } from "@/server/repositories/db";
import {
  checkSendPreconditions,
  type SendPrecheckFailure,
} from "@/core/consent/validation";
import {
  familyTokenExpiresAt,
  mintFamilyToken,
  tokenHashPrefix,
} from "@/core/family/token";
import { sha256Hex } from "@/core/share/text-hash";
import { isTokenExpired } from "@/core/family/token";

/**
 * Sending the approved bytes (docs/04 sections 11.3, 12.2a — frozen E3).
 *
 * THE ENTIRE POINT OF THIS FILE IS THAT IT CONTAINS NO MODEL CALL.
 *
 * Between the person's "yes" and the message leaving, there is no rewrite, no
 * polish, no personalisation, no translation, no repair pass and no
 * regeneration. The outbound body is a byte copy of the snapshot the user
 * approved, and the preconditions exist to prove that the thing being copied
 * is still the thing that was shown.
 *
 *   what was shown == what was approved == what was sent
 *
 * Because the text is pinned before approval rather than generated after it, a
 * drifting model or an edited prompt can only cause a REFUSAL, never a
 * surprise.
 *
 * ── TWO DIFFERENT KINDS OF WORK ─────────────────────────────────────────────
 *
 * `createAuthorizedRequest` turns a consent grant into a durable outbound
 * OBLIGATION, in one transaction: the request row exists, the grant is spent,
 * the opportunity is consumed. It happens once.
 *
 * `retryPendingDelivery` is TRANSPORT against an obligation that already
 * exists. It runs as often as delivery needs it to, and it deliberately does
 * NOT re-run the consent preconditions — `usedAt is null` is a precondition of
 * CREATING the obligation, and re-applying it to transport would make every
 * retry fail forever with "consent already used" on exactly the state that
 * proves consent was properly given.
 *
 * Keeping them separate is what makes a crash between the two survivable:
 *
 *   request = pending, grant.used_at set, opportunity = consumed
 *
 * is not a state needing new consent. It is unfinished transport.
 */
export type FamilySendDeps = {
  clock: Clock;
  db: Db;
  opportunities: OpportunitiesRepo;
  consentGrants: ConsentGrantsRepo;
  familyRequests: FamilyRequestsRepo;
  familyContacts: FamilyContactsRepo;
  entities: EntitiesRepo;
  notifier: Notifier;
};

export type SendOutcome =
  | { outcome: "sent"; requestId: string; renderedTextHash: string }
  | { outcome: "already_sent"; requestId: string }
  | { outcome: "delivery_failed"; requestId: string; errorName: string }
  | { outcome: "integrity_failure"; failure: SendPrecheckFailure | string }
  | { outcome: "nothing_to_send" };

/** What the atomic creation transaction can answer. */
type CreateRpcOutcome =
  | "created"
  | "reloaded"
  | "grant_invalid"
  | "opportunity_not_approved"
  | "opportunity_not_found"
  | "contact_not_found"
  | "recipient_mismatch"
  | "integrity_rejected";

type CreateRpcResult = {
  outcome: CreateRpcOutcome;
  requestId?: string;
  reason?: string;
  status?: string;
};

const ENTITY_SCAN_LIMIT = 400;

function logEvent(record: Record<string, unknown>): void {
  console.log(JSON.stringify(record));
}

/**
 * The entry point: make sure the approved message reaches the family member.
 *
 * It is a router, not a procedure. What has already happened decides which of
 * the two kinds of work is outstanding, which is why calling it twice, or
 * after a crash at any point, is safe.
 */
export async function sendApprovedOpportunity(
  deps: FamilySendDeps,
  input: { userId: string; opportunityId: string },
): Promise<SendOutcome> {
  const opportunity = await deps.opportunities.findOwnedById(input.opportunityId, input.userId);
  if (!opportunity) return { outcome: "nothing_to_send" };

  const existing = await deps.familyRequests.findByOpportunity(opportunity.id);
  if (existing) {
    if (existing.status === "delivered" || existing.status === "answered") {
      return { outcome: "already_sent", requestId: existing.id };
    }
    if (existing.status !== "pending") {
      // `expired` is terminal. The window closed; the answer is not to send.
      return { outcome: "nothing_to_send" };
    }
    // The obligation exists and was never delivered. Transport only.
    return retryPendingDelivery(deps, { request: existing, now: deps.clock.now() });
  }

  const created = await createAuthorizedRequest(deps, {
    userId: input.userId,
    opportunityId: opportunity.id,
  });
  if (created.outcome !== "authorized") return created.failure;

  return deliver(deps, {
    request: created.request,
    contact: created.contact,
    tokenPlaintext: created.tokenPlaintext,
    renderedTextHash: created.renderedTextHash,
  });
}

type CreateResult =
  | {
      outcome: "authorized";
      request: FamilyRequestRecord;
      contact: FamilyContactRecord;
      tokenPlaintext: string;
      renderedTextHash: string;
    }
  | { outcome: "failed"; failure: SendOutcome };

/**
 * Step 1 (E3): validate, then create the obligation and consume consent in ONE
 * transaction. No network call happens inside it, and none may be added.
 */
export async function createAuthorizedRequest(
  deps: FamilySendDeps,
  input: { userId: string; opportunityId: string },
): Promise<CreateResult> {
  const now = deps.clock.now();
  const fail = (failure: SendOutcome): CreateResult => ({ outcome: "failed", failure });

  const opportunity = await deps.opportunities.findOwnedById(input.opportunityId, input.userId);
  if (!opportunity) return fail({ outcome: "nothing_to_send" });

  const grant = await deps.consentGrants.findByOpportunity(opportunity.id);
  if (!grant) return fail({ outcome: "integrity_failure", failure: "grant_not_found" });

  /* --- the five preconditions, before the transaction opens --- */
  const precheck = checkSendPreconditions({
    grant: {
      renderedTextSnapshot: grant.renderedTextSnapshot,
      renderedTextHash: grant.renderedTextHash,
      payloadSnapshot: grant.payloadSnapshot,
      expiresAt: grant.expiresAt,
      usedAt: grant.usedAt,
      revokedAt: grant.revokedAt,
    },
    opportunity: {
      status: opportunity.status,
      renderedText: opportunity.renderedText,
      renderedTextHash: opportunity.renderedTextHash,
      sharePayload: opportunity.sharePayload,
    },
    now,
  });

  if (!precheck.ok) {
    // A mismatch means something changed after the user agreed. The only safe
    // response is to not send: no re-render, no repair, no consumed consent.
    logEvent({
      event: "family.send_refused",
      opportunityId: opportunity.id,
      grantId: grant.id,
      failure: precheck.failure,
    });
    return fail({ outcome: "integrity_failure", failure: precheck.failure });
  }

  const entities = await deps.entities.listForUser(input.userId, ENTITY_SCAN_LIMIT);
  const entity = entities.find((row) => row.id === opportunity.entityId);
  if (!entity) return fail({ outcome: "integrity_failure", failure: "entity_not_found" });

  const contact = await deps.familyContacts.ensure({
    userId: input.userId,
    entityId: opportunity.entityId,
    channel: familyConfig.devChannel,
    // The POC has no real address book. The handle is an opaque digest rather
    // than the entity id: an address is handed to a third-party transport, and
    // internal identifiers have no business travelling there. A real channel
    // adapter supplies a real address; the shape is already right for it.
    address: `dev-inbox:${sha256Hex(`${input.userId}:${opportunity.entityId}`).slice(0, 16)}`,
    displayName: entity.displayName,
  });

  const token = mintFamilyToken();
  const result = (await callPendingRpc(deps.db, "create_authorized_family_request", {
    p_opportunity_id: opportunity.id,
    p_user_id: input.userId,
    p_contact_id: contact.id,
    // The approved bytes, from the precheck, so no other string can be reached
    // by accident.
    p_rendered_body: precheck.bytes,
    p_rendered_body_hash: sha256Hex(precheck.bytes),
    p_payload: grant.payloadSnapshot,
    p_access_token_hash: token.hash,
    p_token_expires_at: familyTokenExpiresAt(now).toISOString(),
    p_now: now.toISOString(),
  })) as CreateRpcResult | null;

  if (!result || typeof result.outcome !== "string") {
    return fail({ outcome: "integrity_failure", failure: "create_request_unrecognised" });
  }

  if (result.outcome !== "created" && result.outcome !== "reloaded") {
    logEvent({
      event: "family.create_refused",
      opportunityId: opportunity.id,
      grantId: grant.id,
      outcome: result.outcome,
      reason: result.reason,
    });
    return fail({
      outcome: "integrity_failure",
      failure: result.reason ?? result.outcome,
    });
  }

  const request = result.requestId ? await deps.familyRequests.findById(result.requestId) : null;
  if (!request) return fail({ outcome: "integrity_failure", failure: "request_not_found" });

  logEvent({
    event: result.outcome === "created" ? "family.request_authorized" : "family.request_reloaded",
    opportunityId: opportunity.id,
    grantId: grant.id,
    requestId: request.id,
    renderedTextHash: grant.renderedTextHash,
  });

  if (result.outcome === "reloaded") {
    // Another attempt created the obligation; this call's plaintext token was
    // never stored against it. Rotate on the SAME request rather than
    // delivering a token the row does not know.
    if (request.status !== "pending") {
      return fail({ outcome: "already_sent", requestId: request.id });
    }
    const rotated = await rotateForRetry(deps, request);
    if (!rotated) return fail({ outcome: "already_sent", requestId: request.id });
    return {
      outcome: "authorized",
      request: rotated.request,
      contact,
      tokenPlaintext: rotated.tokenPlaintext,
      renderedTextHash: grant.renderedTextHash,
    };
  }

  if (request.renderedBody !== precheck.bytes) {
    // The stored obligation disagrees with the approved snapshot. Refuse
    // rather than deliver bytes nobody approved.
    return fail({ outcome: "integrity_failure", failure: "rendered_text_mismatch" });
  }

  return {
    outcome: "authorized",
    request,
    contact,
    tokenPlaintext: token.plaintext,
    renderedTextHash: grant.renderedTextHash,
  };
}

/**
 * Step 2 (E3): transport, against an obligation that already exists.
 *
 * Consent is NOT re-validated here, and that is the point — see the file
 * header. What is re-validated is that the bytes on the row still hash to the
 * hash on the row, because those bytes are about to leave the system.
 */
export async function retryPendingDelivery(
  deps: FamilySendDeps,
  input: { request: FamilyRequestRecord; now?: Date },
): Promise<SendOutcome> {
  const request = input.request;
  const now = input.now ?? deps.clock.now();
  if (request.status !== "pending") {
    return request.status === "delivered" || request.status === "answered"
      ? { outcome: "already_sent", requestId: request.id }
      : { outcome: "nothing_to_send" };
  }

  // THE DELIVERY BOUNDARY. A request whose read window has already closed must
  // not go out: the family member would receive a link that is dead on
  // arrival, and the row would go on counting as outstanding. Retire it and
  // stop transport. The clock decides this, not the status column.
  if (isTokenExpired(request.tokenExpiresAt, now)) {
    await deps.familyRequests.markExpired({ id: request.id, now: now.toISOString() });
    logEvent({
      event: "family.delivery_abandoned_expired",
      requestId: request.id,
      opportunityId: request.opportunityId,
    });
    return { outcome: "nothing_to_send" };
  }

  if (sha256Hex(request.renderedBody) !== request.renderedBodyHash) {
    return { outcome: "integrity_failure", failure: "rendered_text_hash_mismatch" };
  }

  const contact = await deps.familyContacts.findById(request.contactId);
  if (!contact) return { outcome: "integrity_failure", failure: "contact_not_found" };

  // Only the HASH was stored, so the plaintext from the attempt that created
  // this row is gone. Rotate: same request, same bytes, same consent, same
  // original expiry, new capability.
  const rotated = await rotateForRetry(deps, request);
  if (!rotated) return { outcome: "already_sent", requestId: request.id };

  return deliver(deps, {
    request: rotated.request,
    contact,
    tokenPlaintext: rotated.tokenPlaintext,
    renderedTextHash: request.renderedBodyHash,
  });
}

/**
 * The bounded opportunistic sweep (the lazy half of the lifecycle).
 *
 * No cron, no worker, no queue: expiry is a fact about the clock, so it is
 * cheapest to notice it on a path that is already running. Bounded so a
 * backlog costs several turns a little rather than one turn a lot, and
 * idempotent so running it from two paths at once is harmless.
 */
export async function expireOverdueFamilyRequests(
  deps: FamilySendDeps,
  input: { userId: string },
): Promise<number> {
  const expired = await deps.familyRequests.expireOverdueForUser({
    userId: input.userId,
    now: deps.clock.now().toISOString(),
    limit: familyConfig.expirySweepLimit,
  });
  if (expired > 0) logEvent({ event: "family.requests_expired", count: expired });
  return expired;
}

async function rotateForRetry(
  deps: FamilySendDeps,
  request: FamilyRequestRecord,
): Promise<{ request: FamilyRequestRecord; tokenPlaintext: string } | null> {
  const token = mintFamilyToken();
  const rotated = await deps.familyRequests.rotateToken({
    id: request.id,
    accessTokenHash: token.hash,
  });
  if (!rotated) return null;
  logEvent({
    event: "family.token_rotated",
    requestId: rotated.id,
    // The PREFIX of the hash. Never the plaintext, and never the whole hash.
    tokenHashPrefix: tokenHashPrefix(token.hash),
  });
  return { request: rotated, tokenPlaintext: token.plaintext };
}

/**
 * The network call, outside every transaction, and the single row update that
 * records its result.
 *
 * A failure here changes nothing about consent: the grant stays spent, the
 * opportunity stays consumed, the request stays `pending` and retryable. The
 * older adult is not asked again, because they already answered.
 */
async function deliver(
  deps: FamilySendDeps,
  input: {
    request: FamilyRequestRecord;
    contact: FamilyContactRecord;
    tokenPlaintext: string;
    renderedTextHash: string;
  },
): Promise<SendOutcome> {
  const { request, contact } = input;
  const startedAt = Date.now();

  try {
    await deps.notifier.send({
      // The request id IS the idempotency key. For a provider that supports
      // one, this is the value to pass; for a provider that does not,
      // exactly-once delivery cannot be guaranteed by anything on this side of
      // the network, and that limit is documented rather than pretended away.
      requestId: request.id,
      channel: contact.channel,
      address: contact.address,
      recipientDisplayName: contact.displayName,
      body: request.renderedBody,
      responseUrl: familyRespondUrl(input.tokenPlaintext),
    });
  } catch (error) {
    const errorName = error instanceof Error ? error.name : "UnknownError";
    await deps.familyRequests.recordDeliveryFailure({
      id: request.id,
      error: error instanceof Error ? error.message : "unknown delivery failure",
    });
    logDelivery({
      requestId: request.id,
      opportunityId: request.opportunityId,
      channel: contact.channel,
      tokenHash: request.accessTokenHash,
      outcome: "failed",
      latencyMs: Date.now() - startedAt,
      errorName,
    });
    return { outcome: "delivery_failed", requestId: request.id, errorName };
  }

  const delivered = await deps.familyRequests.markDelivered({
    id: request.id,
    now: deps.clock.now().toISOString(),
  });

  logDelivery({
    requestId: request.id,
    opportunityId: request.opportunityId,
    channel: contact.channel,
    tokenHash: request.accessTokenHash,
    outcome: "delivered",
    latencyMs: Date.now() - startedAt,
  });

  logEvent({
    event: "family.sent",
    opportunityId: request.opportunityId,
    requestId: request.id,
    renderedTextHash: input.renderedTextHash,
    // null when a concurrent caller marked it first. The message went out
    // either way; this only records who won the update.
    markedDelivered: delivered !== null,
  });

  return {
    outcome: "sent",
    requestId: request.id,
    renderedTextHash: input.renderedTextHash,
  };
}
