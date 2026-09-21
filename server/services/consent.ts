import type { Clock } from "@/server/adapters/clock";
import type { EntitiesRepo } from "@/server/repositories/entities";
import type { InteractionEventsRepo } from "@/server/repositories/interaction-events";
import type {
  ConsentGrantsRepo,
  ConsentGrantRecord,
} from "@/server/repositories/consent-grants";
import type {
  OpportunitiesRepo,
  OpportunityRecord,
} from "@/server/repositories/opportunities";
import {
  buildCadencePreamble,
  buildOfferBlock,
  needsRepresenting,
  type TranscriptMessage,
} from "@/core/share/offer";
import { buildWellbeingPreamble } from "@/core/wellbeing/offer";
import { ReconnectProposalSchema, type ReconnectProposal } from "@/core/detection/proposal";
import { detectionConfig, type DetectionConfig } from "@/core/detection/config";
import { currentSitting, mayPresentOpportunity } from "@/core/detection/presentation";
import { SharePayloadSchema, type SharePayload } from "@/core/share/payload";
import { presentableEntity } from "@/core/memory/provenance";
import { absenceIsSuperseded } from "@/core/detection/absence";
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
  /**
   * One bounded read, and only for an absence candidate (M12e.1): has the
   * person since reported contact with this entity, about the period they
   * said there was none? The detector already refuses to MINT a superseded
   * absence; this refuses to PRESENT one that was minted before the contact
   * was reported, which is the ordinary case — ingestion runs after the
   * turn, so the contradicting event lands one turn later.
   */
  interactionEvents: Pick<InteractionEventsRepo, "latestPositiveSince">;
  /** Overridable so a pacing threshold is testable by passing a number. */
  detection?: DetectionConfig;
};

const ENTITY_SCAN_LIMIT = 400;
const OPPORTUNITY_SCAN_LIMIT = 5;

function logEvent(record: Record<string, unknown>): void {
  console.log(JSON.stringify(record));
}

/**
 * The entity's name, IF it is fit to show a person.
 *
 * `sanitizeLabel` is not a new rule invented here — it is the same function
 * the outbound path has always used to decide what may appear in a message
 * to a family member (`core/share/minimize.ts`). It allows letters, marks,
 * spaces, apostrophes, hyphens and dots, and refuses everything else.
 *
 * WHY IT IS NOW ALSO ON THE PRESENTATION PATH. A reviewer's browser rendered
 * "RECONNECT WITH M4ABSENCE1789574558". Every layer had behaved correctly:
 * a developer seeding script had created an entity under that name, the
 * detector found a real signal for it, and the card printed the display name
 * it was given. The outbound message was never at risk — minimization would
 * have refused the label — but the CARD had no such rule, so the two halves
 * of one product disagreed about what counts as a person's name.
 *
 * Returning null here suppresses the offer entirely rather than showing an
 * identifier. That is the right way round: an opportunity nobody sees costs
 * a nudge, and a technical string presented as somebody's name costs the
 * reviewer's belief that this is a product.
 *
 * NOTHING HERE IS FIXTURE-SPECIFIC. No name, prefix or id is mentioned; the
 * rule is a character class, and it would refuse "user_42" and
 * "550e8400-e29b" for exactly the same reason.
 */
export type PresentableEntity = {
  displayName: string;
  /** Stored alternative labels, sanitized the same way. */
  aliases: readonly string[];
};

async function entityLabelFor(
  deps: ConsentDeps,
  input: { userId: string; entityId: string },
): Promise<PresentableEntity | null> {
  const entities = await deps.entities.listPresentableForUser(input.userId, ENTITY_SCAN_LIMIT);
  /**
   * PROVENANCE, NOT SPELLING — and decided in ONE place (M12e.3).
   *
   * `sanitizeLabel` refused "M4ABSENCE1789574558" because it contains
   * digits. It cannot refuse "TestPersonA", which is letters all the way
   * through and indistinguishable from a name somebody actually has. The
   * problem was never the characters; it is that the row was created by a
   * development seeding route rather than by the person talking.
   *
   * M12e put that rule here and nowhere else, which is how a reviewer still
   * saw "RECONNECT WITH TESTPERSONA": the card drawn on page load comes
   * from `loadPendingOffer`, not from this function. The rule now lives in
   * `core/memory/provenance.ts` and every presentation path calls it — and
   * the read above excludes `dev` in SQL before it gets here.
   */
  return presentableEntity(entities.find((entity) => entity.id === input.entityId));
}

function readPayload(value: unknown): SharePayload | null {
  const parsed = SharePayloadSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * The stored proposal, or null when this deploy cannot read it.
 *
 * Null is a real answer, not an error: a row written by an older shape holds
 * no cadence claim this code can stand behind. Everything downstream treats
 * it as "no claim" rather than guessing one.
 */
function readProposal(value: unknown): ReconnectProposal | null {
  const parsed = ReconnectProposalSchema.safeParse(value);
  return parsed.success ? (parsed.data as ReconnectProposal) : null;
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
      /**
       * WHY this offer appeared, when the application worked it out on its
       * own. Deterministic, built from the stored proposal, and NOT part of
       * `block`: the block's bytes are what consent attaches to and what the
       * browser strips to draw the card. Null when the person supplied the
       * context themselves, or when the proposal cannot be read.
       */
      preamble: string | null;
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
    /**
     * The conversation this turn belongs to. Carried for log correlation
     * and for the seam's shape; the pacing gate reads `recentMessages`,
     * whose timestamps are what a SITTING is measured from.
     */
    conversationId: string;
    /** Recent transcript, used only to tell "already shown" from "not shown". */
    recentMessages: ReadonlyArray<TranscriptMessage>;
  },
): Promise<OfferResult> {
  const now = deps.clock.now();
  const config = deps.detection ?? detectionConfig;
  const candidates = await deps.opportunities.listByStatusForUser(
    input.userId,
    ["offered", "drafted"],
    OPPORTUNITY_SCAN_LIMIT,
  );


  /**
   * Measured ONCE for the whole loop: every candidate is judged against the
   * same conversational moment, and a sitting cannot shift between two
   * candidates of one turn.
   */
  const sitting = currentSitting(input.recentMessages, config);

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

    const entity = await entityLabelFor(deps, {
      userId: input.userId,
      entityId: opportunity.entityId,
    });
    if (entity === null) {
      // Either the entity is gone, or its stored label is not something to
      // put in front of a person. Both are "say nothing", and both are
      // worth a log line: silence with no explanation is how a suppressed
      // offer becomes a bug report nobody can reproduce.
      logEvent({
        event: "consent.offer_withheld",
        opportunityId: opportunity.id,
        entityId: opportunity.entityId,
        reason: "unpresentable_entity",
      });
      continue;
    }

    /**
     * The stored proposal decides two things, and the model neither of them:
     * WHICH KIND of evidence this offer rests on — the application's own
     * statistic, or something the person said — and the exact sentence that
     * explains it.
     *
     * An unreadable proposal falls back to `user_stated_absence`, which is
     * the STRICTER of the two treatments under the gate below: it must have
     * been raised in this sitting. A row this deploy cannot read is a row it
     * cannot justify interrupting with.
     */
    const proposal = readProposal(opportunity.proposal);
    const observationKind = proposal?.observation.kind ?? "user_stated_absence";
    const preamble =
      proposal === null
        ? null
        : observationKind === "self_reported_wellbeing"
          ? // Not an explanation of a statistic — a reminder of whose words
            // these are. See core/wellbeing/offer.ts.
            buildWellbeingPreamble()
          : buildCadencePreamble(proposal);

    if (opportunity.status === "offered") {
      // Re-presenting is recovery, not interruption: this person was already
      // told, or should have been. The pacing gate does not apply to it.
      if (
        opportunity.offeredAt === null ||
        !needsRepresenting(input.recentMessages, {
          renderedText: opportunity.renderedText,
          offeredAt: opportunity.offeredAt,
          sittingStartedAtMs: sitting.startedAtMs,
        })
      ) {
        return { outcome: "none" };
      }
      return {
        outcome: "represented",
        opportunityId: opportunity.id,
        entityId: opportunity.entityId,
        entityName: entity.displayName,
        renderedText: opportunity.renderedText,
        block: buildOfferBlock({
          entityName: entity.displayName,
          renderedText: opportunity.renderedText,
        }),
        preamble,
      };
    }

    /**
     * DOES THIS TURN STILL SUPPORT THIS OFFER? (M12e)
     *
     * Asked BEFORE the transition, and a "no" spends nothing: no
     * `markOffered`, no `offered_at`, no 7-day cooldown started, nothing for
     * the person to have declined, and no second row. The opportunity stays
     * `drafted` inside its existing window and the next turn that genuinely
     * supports it shows it.
     *
     * M12c asked only "is this conversation underway", and only of cadence
     * offers. An explicit absence was exempt — correctly for the turn it is
     * said on, and wrongly for the fourteen days the absence detector keeps
     * re-examining the event. That is how "It was good, what about you?"
     * ended up carrying somebody's family matter. See
     * core/detection/presentation.ts for the whole rule.
     *
     * `continue` rather than `return`: withholding this candidate says
     * nothing about the next one.
     */
    /**
     * WHEN the person said it, and whether anything has overtaken it.
     *
     * `statedAt` is the source turn's `reported_at`, carried on the stored
     * proposal since M12e.1. A row written before that falls back to the
     * opportunity's `created_at` — the sweep that ingested the assertion,
     * and the closest honest substitute for the turn itself.
     */
    const absence =
      proposal !== null && proposal.observation.kind === "user_stated_absence"
        ? proposal.observation
        : null;
    const raisedAtIso = absence?.statedAt ?? opportunity.createdAt;

    let superseded = false;
    if (absence !== null) {
      const latest = await deps.interactionEvents.latestPositiveSince({
        userId: input.userId,
        entityId: opportunity.entityId,
        sinceOccurredIso: absence.window.start,
      });
      superseded = absenceIsSuperseded({
        statedAtIso: raisedAtIso,
        windowStartIso: absence.window.start,
        latestPositive:
          latest === null
            ? null
            : { occurredAtIso: latest.occurredAt, reportedAtIso: latest.reportedAt },
      });
    }

    const verdict = mayPresentOpportunity(
      input.recentMessages,
      {
        kind: observationKind,
        entityName: entity.displayName,
        aliases: entity.aliases,
        raisedAtIso,
        offeredAtIso: opportunity.offeredAt,
        supersededByLaterContact: superseded,
      },
      config,
    );
    if (!verdict.present) {
      logEvent({
        event: "consent.offer_withheld",
        opportunityId: opportunity.id,
        entityId: opportunity.entityId,
        reason: verdict.reason,
        userTurns: verdict.userTurns,
        userCharacters: verdict.userCharacters,
        needTurns: verdict.needTurns,
        needCharacters: verdict.needCharacters,
      });
      continue;
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
      reason: verdict.reason,
    });

    return {
      outcome: "offered",
      opportunityId: offered.id,
      entityId: offered.entityId,
      entityName: entity.displayName,
      renderedText: opportunity.renderedText,
      block: buildOfferBlock({
        entityName: entity.displayName,
        renderedText: opportunity.renderedText,
      }),
      preamble,
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
    (await entityLabelFor(deps, { userId: input.userId, entityId: opportunity.entityId }))
      ?.displayName ?? "them";

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
