import type { Clock } from "@/server/adapters/clock";
import type { EntitiesRepo } from "@/server/repositories/entities";
import type {
  ConsentGrantsRepo,
  ConsentGrantRecord,
} from "@/server/repositories/consent-grants";
import type {
  OpportunitiesRepo,
  OpportunityRecord,
} from "@/server/repositories/opportunities";
import { buildOfferBlock, needsRepresenting, type TranscriptMessage } from "@/core/share/offer";
import { SharePayloadSchema, type SharePayload } from "@/core/share/payload";
import { readConsent, type ConsentReading } from "@/core/consent/decision";
import { buildConsentScope, consentExpiresAt } from "@/core/consent/grant";
import { checkApprovalPreconditions } from "@/core/consent/validation";

/**
 * The offer and the answer (docs/04 sections 11.1-11.3).
 *
 * Two guarantees live in this file and nowhere else:
 *
 *   what was SHOWN is the stored bytes, inserted by application code;
 *   what was APPROVED is a snapshot of those same bytes, copied not rebuilt.
 *
 * The conversational model is involved in neither. It never receives the draft
 * (E1), and it never classifies the answer - `readConsent` is a deterministic
 * parser, and even the declared LLM seam could only return a label that this
 * service then acts on.
 */
export type ConsentDeps = {
  clock: Clock;
  opportunities: OpportunitiesRepo;
  consentGrants: ConsentGrantsRepo;
  entities: EntitiesRepo;
};

const ENTITY_SCAN_LIMIT = 400;
const OPPORTUNITY_SCAN_LIMIT = 5;

function logEvent(record: Record<string, unknown>): void {
  console.log(JSON.stringify(record));
}

async function entityNameFor(
  deps: ConsentDeps,
  input: { userId: string; entityId: string },
): Promise<string | null> {
  const entities = await deps.entities.listForUser(input.userId, ENTITY_SCAN_LIMIT);
  return entities.find((entity) => entity.id === input.entityId)?.displayName ?? null;
}

function readPayload(value: unknown): SharePayload | null {
  const parsed = SharePayloadSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/* ------------------------------------------------------------------------ */
/* drafted -> offered                                                        */
/* ------------------------------------------------------------------------ */

export type OfferResult =
  | {
      outcome: "offered" | "represented";
      opportunityId: string;
      entityId: string;
      entityName: string;
      /** The exact stored bytes. */
      renderedText: string;
      /** What the application appends to the turn, verbatim. */
      block: string;
    }
  | { outcome: "none" }
  | { outcome: "expired"; opportunityId: string };

/**
 * Decides whether this turn should carry the offer, and builds it.
 *
 * The transition happens BEFORE the block is emitted, and it is a conditional
 * update, so two concurrent turns cannot both present the draft. The loser
 * gets null and stays quiet.
 *
 * `represented` covers a real failure mode: the transition committed and then
 * the stream died, leaving an opportunity marked `offered` that the person
 * never saw. A later turn notices the transcript does not contain the stored
 * bytes and shows the SAME message again - never a different one.
 */
export async function prepareOffer(
  deps: ConsentDeps,
  input: {
    userId: string;
    /** Recent transcript, used only to tell "already shown" from "not shown". */
    recentMessages: ReadonlyArray<TranscriptMessage>;
  },
): Promise<OfferResult> {
  const now = deps.clock.now();
  const candidates = await deps.opportunities.listByStatusForUser(
    input.userId,
    ["offered", "drafted"],
    OPPORTUNITY_SCAN_LIMIT,
  );

  for (const opportunity of candidates) {
    if (Date.parse(opportunity.expiresAt) <= now.getTime()) {
      // Expiry is evaluated on read, never swept. An expired opportunity is
      // terminal: the path back is a fresh signal, not a refreshed clock.
      await deps.opportunities.markExpired(opportunity.id, now.toISOString());
      logEvent({
        event: "consent.opportunity_expired",
        opportunityId: opportunity.id,
        status: opportunity.status,
      });
      continue;
    }
    if (opportunity.renderedText === null) continue;

    const entityName = await entityNameFor(deps, {
      userId: input.userId,
      entityId: opportunity.entityId,
    });
    if (entityName === null) continue;

    if (opportunity.status === "offered") {
      if (
        opportunity.offeredAt === null ||
        !needsRepresenting(input.recentMessages, {
          renderedText: opportunity.renderedText,
          offeredAt: opportunity.offeredAt,
        })
      ) {
        return { outcome: "none" };
      }
      return {
        outcome: "represented",
        opportunityId: opportunity.id,
        entityId: opportunity.entityId,
        entityName,
        renderedText: opportunity.renderedText,
        block: buildOfferBlock({ entityName, renderedText: opportunity.renderedText }),
      };
    }

    const offered = await deps.opportunities.markOffered({
      id: opportunity.id,
      now: now.toISOString(),
    });
    if (!offered) return { outcome: "none" };

    logEvent({
      event: "consent.offered",
      opportunityId: offered.id,
      entityId: offered.entityId,
      renderedTextHash: offered.renderedTextHash,
    });

    return {
      outcome: "offered",
      opportunityId: offered.id,
      entityId: offered.entityId,
      entityName,
      renderedText: opportunity.renderedText,
      block: buildOfferBlock({ entityName, renderedText: opportunity.renderedText }),
    };
  }

  return { outcome: "none" };
}

/* ------------------------------------------------------------------------ */
/* offered -> approved | declined                                            */
/* ------------------------------------------------------------------------ */

export type ConsentOutcome =
  | {
      outcome: "approved";
      opportunityId: string;
      grantId: string;
      entityName: string;
      reply: string;
    }
  | { outcome: "declined"; opportunityId: string; entityName: string; reply: string }
  /** Hesitation. The offer stands; ask once more, without re-showing it. */
  | { outcome: "unclear"; opportunityId: string; entityName: string; reply: string }
  /** Not an answer at all - they changed the subject. Carry on talking. */
  | { outcome: "not_an_answer"; opportunityId: string }
  | { outcome: "no_offer" }
  | { outcome: "expired"; opportunityId: string; reply: string }
  | { outcome: "integrity_failure"; opportunityId: string; failure: string };

export function replyForApproval(entityName: string): string {
  return `Thank you — I'll send that to ${entityName} now.`;
}
export function replyForDecline(): string {
  return "No problem. I won't send it.";
}
export function replyForUnclear(entityName: string): string {
  return `Sorry — would you like me to send that message to ${entityName}? A yes or a no is fine.`;
}
export function replyForExpired(): string {
  return "That message is no longer current, so I won't send it.";
}

/**
 * Reads the person's answer and, if it is a clear yes, pins the consent.
 *
 * Consent is never inferred from sentiment, enthusiasm, topic or silence.
 * Anything that is not a clear yes or a clear no leaves the opportunity
 * exactly where it was.
 */
export async function handleConsentReply(
  deps: ConsentDeps,
  input: { userId: string; text: string; grantingMessageId: string | null },
): Promise<ConsentOutcome> {
  const now = deps.clock.now();
  const offered = await deps.opportunities.listByStatusForUser(
    input.userId,
    ["offered"],
    OPPORTUNITY_SCAN_LIMIT,
  );
  if (offered.length === 0) return { outcome: "no_offer" };

  // Suppression allows one open opportunity per entity, and the offer cap
  // allows one per conversation, so more than one is not expected. Newest
  // first is the deterministic choice if it ever happens.
  const opportunity = offered[0];
  const reading: ConsentReading = readConsent(input.text);

  if (Date.parse(opportunity.expiresAt) <= now.getTime()) {
    await deps.opportunities.markExpired(opportunity.id, now.toISOString());
    return { outcome: "expired", opportunityId: opportunity.id, reply: replyForExpired() };
  }

  const entityName =
    (await entityNameFor(deps, { userId: input.userId, entityId: opportunity.entityId })) ??
    "them";

  logEvent({
    event: "consent.reply_read",
    opportunityId: opportunity.id,
    decision: reading.decision,
    rule: reading.matchedRule,
  });

  if (reading.decision === "unclear") {
    return reading.matchedRule === null
      ? { outcome: "not_an_answer", opportunityId: opportunity.id }
      : {
          outcome: "unclear",
          opportunityId: opportunity.id,
          entityName,
          reply: replyForUnclear(entityName),
        };
  }

  if (reading.decision === "decline") {
    const declined = await deps.opportunities.markDeclined({
      id: opportunity.id,
      now: now.toISOString(),
    });
    logEvent({
      event: "consent.declined",
      opportunityId: opportunity.id,
      applied: declined !== null,
    });
    // No grant, no request, no send. The row survives, because the decline is
    // what feeds M4's cooldown and quiet-period rules.
    return {
      outcome: "declined",
      opportunityId: opportunity.id,
      entityName,
      reply: replyForDecline(),
    };
  }

  return approveOpportunity(deps, {
    userId: input.userId,
    opportunity,
    entityName,
    grantingMessageId: input.grantingMessageId,
    now,
  });
}

async function approveOpportunity(
  deps: ConsentDeps,
  input: {
    userId: string;
    opportunity: OpportunityRecord;
    entityName: string;
    grantingMessageId: string | null;
    now: Date;
  },
): Promise<ConsentOutcome> {
  const { opportunity, now } = input;

  const precheck = checkApprovalPreconditions({
    opportunity: {
      status: opportunity.status,
      expiresAt: opportunity.expiresAt,
      renderedText: opportunity.renderedText,
      renderedTextHash: opportunity.renderedTextHash,
      sharePayload: opportunity.sharePayload,
    },
    now,
  });
  if (!precheck.ok) {
    logEvent({
      event: "consent.approval_refused",
      opportunityId: opportunity.id,
      failure: precheck.failure,
    });
    return {
      outcome: "integrity_failure",
      opportunityId: opportunity.id,
      failure: precheck.failure,
    };
  }

  const payload = readPayload(opportunity.sharePayload);
  if (payload === null) {
    return {
      outcome: "integrity_failure",
      opportunityId: opportunity.id,
      failure: "share_payload_unreadable",
    };
  }

  const approved = await deps.opportunities.markApproved({
    id: opportunity.id,
    now: now.toISOString(),
  });
  if (!approved) {
    // Lost the race, or it expired between the read and the write. Either way
    // this attempt does not get to decide; reload and report.
    const reloaded = await deps.opportunities.findOwnedById(opportunity.id, input.userId);
    if (reloaded?.status === "approved") {
      const grant = await deps.consentGrants.findByOpportunity(opportunity.id);
      if (grant) {
        return {
          outcome: "approved",
          opportunityId: opportunity.id,
          grantId: grant.id,
          entityName: input.entityName,
          reply: replyForApproval(input.entityName),
        };
      }
    }
    return {
      outcome: "integrity_failure",
      opportunityId: opportunity.id,
      failure: "approval_lost_race",
    };
  }

  // The snapshot. Copied from the opportunity, never rebuilt - consent has to
  // attach to bytes, and a regenerated sentence is a different artefact even
  // when it reads the same.
  const grantedAt = now;
  const { grant, created }: { grant: ConsentGrantRecord; created: boolean } =
    await deps.consentGrants.create({
      userId: input.userId,
      opportunityId: opportunity.id,
      scope: buildConsentScope({ recipientEntityId: opportunity.entityId, payload }),
      payloadSnapshot: opportunity.sharePayload as never,
      renderedTextSnapshot: opportunity.renderedText as string,
      renderedTextHash: opportunity.renderedTextHash as string,
      grantingMessageId: input.grantingMessageId,
      grantedAt: grantedAt.toISOString(),
      expiresAt: consentExpiresAt(grantedAt).toISOString(),
    });

  logEvent({
    event: "consent.approved",
    opportunityId: opportunity.id,
    grantId: grant.id,
    grantCreated: created,
    renderedTextHash: grant.renderedTextHash,
    expiresAt: grant.expiresAt,
  });

  return {
    outcome: "approved",
    opportunityId: opportunity.id,
    grantId: grant.id,
    entityName: input.entityName,
    reply: replyForApproval(input.entityName),
  };
}
