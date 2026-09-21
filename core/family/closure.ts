import type { ShareTopic } from "@/core/share/payload";
import type { FamilyReplyIntent } from "./response";

/**
 * Closing the loop (docs/04 section 12.3).
 *
 * A closure is a persisted obligation, not something the model is trusted to
 * remember. An unacknowledged promise - "I'll ask John" - is the most damaging
 * thing this product can do, so it is a row you can query for, and alert on,
 * rather than a hope.
 *
 * The fact is structured. The sentence below is deterministic and factual:
 * what the family member actually answered, and nothing about what it means.
 * "John misses you", "that should cheer you up" and "John is worried" are all
 * inferences about an internal state, and none of them were said.
 */
export type ClosureFact = {
  opportunityId: string;
  familyRequestId: string;
  responseId: string;
  entityName: string;
  topic: ShareTopic;
  responseIntent: FamilyReplyIntent;
  timeframe?: string;
  createdAt: string;
};

/** The minimal marker conversational context may receive (section 23). */
export type ClosureMarker = {
  type: "family_response";
  entityName: string;
  response: FamilyReplyIntent;
  timeframe?: string;
};

export function closureMarker(fact: ClosureFact): ClosureMarker {
  const marker: ClosureMarker = {
    type: "family_response",
    entityName: fact.entityName,
    response: fact.responseIntent,
  };
  if (fact.timeframe) marker.timeframe = fact.timeframe;
  return marker;
}

/**
 * The factual sentence. Reports the answer; asserts nothing beyond it.
 *
 * Deliberately not a template the model fills in: the one thing the companion
 * must get right here is not overstating what a family member said.
 */
export function renderClosureSentence(fact: ClosureFact): string {
  const when = fact.timeframe ? ` ${fact.timeframe}` : " soon";
  // The stored answer is a bare polarity; the TOPIC supplies the verb (M12e
  // adds the third). A wellbeing reply is a promise to check in — never a
  // statement about the person's health, which the reader was never asked
  // about and has no way to send.
  const action =
    fact.topic === "call" ? "call" : fact.topic === "wellbeing" ? "check in" : "visit";

  // The stored answer is a bare polarity; the TOPIC supplies the verb. That is
  // why "yes" to a call renders as a call and never as a visit.
  switch (fact.responseIntent) {
    case "yes":
      return `${fact.entityName} replied that they are planning to ${action}${when}.`;
    case "no":
      return `${fact.entityName} replied that they are not able to ${action} just now.`;
    case "unsure":
      return `${fact.entityName} replied that they are not sure yet.`;
    case "other":
      return `${fact.entityName} replied to the message.`;
  }
}
