import { DAY_MS } from "@/core/baseline/day";
import { stableHash } from "@/core/baseline/hash";
import { detectionConfig } from "@/core/detection/config";
import { DETECTION_METHOD_VERSION } from "@/core/detection/types";
import { buildWellbeingProposal, reportedOnUtc } from "@/core/wellbeing/offer";
import { readWellbeing } from "@/core/wellbeing/self-report";
import { presentableName } from "@/core/memory/provenance";
import { detectionSweepConfig } from "@/server/config";
import type { FamilyContactsRepo } from "@/server/repositories/family-contacts";
import { draftOpportunity, readDetectionKey, type ReconnectDeps } from "./reconnect";

/**
 * The consented wellbeing share (M12e).
 *
 * WHAT THE PRODUCT DOES. The person says they were unwell. CareLoop answers
 * warmly and asks one question — that is the conversation, and it happens
 * whether or not any of this runs. Separately, AFTER the reply has been
 * streamed, this decides whether the person may be OFFERED the chance to
 * pass that on. They are shown the exact sentence, they say yes or no, and
 * only a yes sends anything.
 *
 * WHAT IT IS NOT, stated as constraints the code actually has:
 *
 *   NOT SILENT. Nothing is sent without an explicit approval read by
 *   `readConsent`, a deterministic parser. There is no path from this
 *   function to a notifier.
 *
 *   NOT SURVEILLANCE. It fires only on the person's own words, only on the
 *   turn they say them, and it produces ONE offer that expires in a day. It
 *   does not monitor, accumulate, trend, or run on a schedule — it has no
 *   caller other than a turn the person themselves took.
 *
 *   NOT CLINICAL. The stored claim is "they said they were not feeling
 *   well". There is no severity, symptom, duration or cause anywhere in the
 *   explanation, the proposal, the payload or the message, because none of
 *   those types has a field for one.
 *
 *   NOT A MODEL DECISION. The detector is a phrase rule over their sentence;
 *   the recipient is arithmetic over configured contacts; the message is a
 *   template. The only model in the whole path is the one writing the
 *   conversational reply, which never sees any of this.
 *
 * WHY IT REUSES THE RECONNECT CHAIN. Signal -> opportunity -> offer ->
 * consent grant -> family request -> bounded reply -> verified closure is
 * where every guarantee this needs already lives: exact bytes shown, exact
 * bytes approved, snapshot copied not rebuilt, capability token, no model
 * after approval. A second chain would be a second implementation of
 * consent, and the second one is always the weaker one.
 */

export type WellbeingDeps = ReconnectDeps & {
  familyContacts: Pick<FamilyContactsRepo, "listForUser">;
};

const CONTACT_SCAN_LIMIT = 20;
const ENTITY_SCAN_LIMIT = 400;

export type WellbeingOutcome =
  /** The message said nothing about being unwell. Overwhelmingly the case. */
  | { outcome: "not_a_self_report" }
  /**
   * Language about immediate danger. EVERY proactive path stands down: no
   * signal, no opportunity, no offer. CareLoop is not an emergency service
   * and does not pretend to triage — it simply refuses to answer "I can't
   * breathe" with "shall I let John know?".
   */
  | { outcome: "urgent_stood_down" }
  /** Nobody to offer, or nobody unambiguous. No guessing. */
  | { outcome: "no_recipient"; contacts: number }
  /** This exact message already produced a signal. */
  | { outcome: "already_recorded"; signalId: string }
  | { outcome: "blocked"; reason: string }
  | { outcome: "offer_prepared"; signalId: string; opportunityId: string; entityId: string };

function logEvent(record: Record<string, unknown>): void {
  console.log(JSON.stringify(record));
}

export function wellbeingDetectionKey(sourceMessageId: string): string {
  return stableHash([DETECTION_METHOD_VERSION, "self_reported_wellbeing", sourceMessageId]);
}

/**
 * Runs AFTER the reply is streamed, from the chat route's `after()`.
 *
 * Never on the hot path, and never able to affect the reply: by the time
 * this is called the person has already read the warm answer. The offer, if
 * one is prepared, is shown by `prepareOffer` on the next turn — the same
 * way a reconnect offer has always surfaced.
 */
export async function noteWellbeingSelfReport(
  deps: WellbeingDeps,
  input: {
    userId: string;
    conversationId: string;
    /** The message the person said it in. The identity of this detection. */
    userMessageId: string;
    text: string;
  },
): Promise<WellbeingOutcome> {
  const reading = readWellbeing(input.text);

  if (reading.kind === "urgent") {
    // Logged WITHOUT the phrase. What they said is in the transcript, which
    // is theirs; a log line is not the place to copy it to.
    logEvent({
      event: "wellbeing.stood_down",
      conversationId: input.conversationId,
      reason: "urgent_language",
    });
    return { outcome: "urgent_stood_down" };
  }
  if (reading.kind !== "self_report") return { outcome: "not_a_self_report" };

  const now = deps.clock.now();

  /**
   * IDEMPOTENT ON THE MESSAGE. The identity of this detection is the message
   * they said it in, so a retried `after()` — the ordinary consequence of a
   * reclaimed runtime — re-derives the same key and writes nothing.
   */
  const detectionKey = wellbeingDetectionKey(input.userMessageId);
  const recent = await deps.signals.listRecent(
    input.userId,
    new Date(now.getTime() - detectionSweepConfig.signalHistoryLookbackDays * DAY_MS).toISOString(),
    detectionSweepConfig.signalHistoryLimit,
  );
  const already = recent.find((signal) => readDetectionKey(signal) === detectionKey);
  if (already) return { outcome: "already_recorded", signalId: already.id };

  /**
   * WHO WOULD RECEIVE IT.
   *
   * A reconnect offer is about a person, so its recipient is decided for it.
   * A wellbeing note is about the user, so somebody has to be chosen — and
   * "chosen" is exactly the word that should worry you. The rule is
   * therefore arithmetic with no tie-break: ONE configured family contact
   * means one possible recipient and no choice was made; anything else
   * means CareLoop does not know who this should go to and says nothing.
   *
   * Zero contacts is the common case for a new account and is silent on
   * purpose. Two is silent too. Picking "the most recent" would be the
   * system deciding which relative hears about somebody's health.
   */
  const contacts = await deps.familyContacts.listForUser(input.userId, CONTACT_SCAN_LIMIT);
  const entityIds = [...new Set(contacts.map((contact) => contact.entityId))];
  if (entityIds.length !== 1) {
    logEvent({
      event: "wellbeing.withheld",
      conversationId: input.conversationId,
      reason: "no_single_family_contact",
      contacts: entityIds.length,
    });
    return { outcome: "no_recipient", contacts: entityIds.length };
  }
  const entityId = entityIds[0]!;

  // The same provenance rule every presentation path applies, from the same
  // module (M12e.3). A contact hanging off a development-seeded row is not
  // somebody to write to, and the read below cannot return one anyway.
  /**
   * The same provenance rule every presentation path applies, from the same
   * module (M12e.3). A contact hanging off a development-seeded row is not
   * somebody to write to.
   *
   * ONE reason, not two. The read below excludes `dev` in SQL, so from here
   * a development-seeded entity and a deleted one are the same absence —
   * and inventing a second log code by re-querying unfiltered would buy a
   * word at the cost of a round trip on a path that is already refusing.
   */
  const entities = await deps.entities.listPresentableForUser(input.userId, ENTITY_SCAN_LIMIT);
  const entity = entities.find((row) => row.id === entityId) ?? null;
  if (entity === null || presentableName(entity) === null) {
    logEvent({
      event: "wellbeing.withheld",
      conversationId: input.conversationId,
      reason: "entity_not_presentable",
      entityId,
    });
    return { outcome: "blocked", reason: "entity_not_presentable" };
  }

  const proposal = buildWellbeingProposal({
    entityId,
    entityName: entity.displayName,
    reportedOn: reportedOnUtc(now),
  });
  if (proposal === null) {
    logEvent({
      event: "wellbeing.withheld",
      conversationId: input.conversationId,
      reason: "unpresentable_entity_label",
    });
    return { outcome: "blocked", reason: "unpresentable_entity_label" };
  }

  const signal = await deps.signals.insert({
    userId: input.userId,
    entityId,
    baselineId: null,
    signalType: "self_reported_wellbeing",
    explanation: {
      detector: "self_reported_wellbeing",
      methodVersion: DETECTION_METHOD_VERSION,
      detectionKey,
      entityId,
      // WHICH message, never WHAT it said. The transcript already holds
      // their words; copying them into an explanation row would put a
      // sentence about somebody's health into a second place.
      sourceMessageId: input.userMessageId,
      reportedAt: now.toISOString(),
      conversationId: input.conversationId,
    },
    detectedAt: now.toISOString(),
    // `score` stays null, for the same reason it does on every other
    // detector: an opaque wellbeing number is the monitoring product this
    // design refuses to be.
  });

  const materialized = await deps.opportunities.materialize({
    signalId: signal.id,
    userId: input.userId,
    entityId,
    proposal,
    expiresAt: new Date(
      now.getTime() + detectionConfig.opportunityOfferabilityHours * 3_600_000,
    ).toISOString(),
    now: now.toISOString(),
  });

  if (materialized.opportunityId === null) {
    // `blocked_open_opportunity` is the ordinary one: a reconnect loop for
    // this person is already running, and two open asks about one relative
    // is the nagging every pacing rule in this system exists to prevent.
    logEvent({
      event: "wellbeing.withheld",
      conversationId: input.conversationId,
      signalId: signal.id,
      reason: materialized.outcome,
    });
    return { outcome: "blocked", reason: materialized.outcome };
  }

  // Deterministic text, no renderer — see `draftOpportunity`.
  const draft = await draftOpportunity(deps, {
    userId: input.userId,
    opportunityId: materialized.opportunityId,
  });

  logEvent({
    event: "wellbeing.offer_prepared",
    conversationId: input.conversationId,
    signalId: signal.id,
    opportunityId: materialized.opportunityId,
    entityId,
    draftOutcome: draft.outcome,
    // The proof that no model wrote a sentence about this person's health.
    rendererCalled: draft.rendererCalled,
  });

  return {
    outcome: "offer_prepared",
    signalId: signal.id,
    opportunityId: materialized.opportunityId,
    entityId,
  };
}
