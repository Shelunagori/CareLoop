import type { ExtractionV1 } from "./extraction-contract";
import { resolveAbsenceWindow } from "./temporal";

/**
 * Recovering the person's OWN WORDS for an absence window.
 *
 * The immutable observation already holds them: the extraction contract asks
 * the model for the PHRASE the person used ("this week"), never a date it
 * computed (docs/02 section 6). So provenance for an absence assertion is a
 * read, not a new column — `interaction_events.source_observation_id` points
 * at the payload that produced the row.
 *
 * The problem this solves is matching: one observation can carry several
 * interaction claims, and the stored row keeps only the RESOLVED window. So a
 * claim is matched by replaying the same deterministic resolver against the
 * same reference instant and comparing the window it produces. If exactly one
 * claim lands on the stored window, its phrase is the person's. If none does,
 * or more than one does, there is no phrase — and none is invented, because a
 * fabricated quote is worse than no quote.
 */
export const MAX_STATED_PHRASE_LENGTH = 60;

export function recoverStatedAbsencePhrase(input: {
  /** The parsed payload of the observation the event came from. */
  extraction: ExtractionV1;
  eventType: "visit" | "call";
  /** The window as stored on the interaction_event. */
  windowStart: Date;
  windowEnd: Date;
  /** The anchor the window was resolved against: when the person SPOKE. */
  reportedAt: Date;
}): string | null {
  const phrases = input.extraction.interactions
    .filter((claim) => claim.polarity === "absence" && claim.eventType === input.eventType)
    .filter((claim) => {
      const window = resolveAbsenceWindow({
        claim: claim.temporal,
        referenceAt: input.reportedAt,
      });
      return (
        window !== null &&
        window.start.getTime() === input.windowStart.getTime() &&
        window.end.getTime() === input.windowEnd.getTime()
      );
    })
    .map((claim) => claim.temporal.expression)
    .filter((expression): expression is string => typeof expression === "string")
    .map((expression) => expression.trim())
    .filter((expression) => expression.length > 0);

  const distinct = [...new Set(phrases)];
  // Zero matches, or two claims that disagree about the wording: not something
  // to guess at, for the same reason entity resolution refuses an ambiguous
  // mention rather than picking the first.
  if (distinct.length !== 1) return null;

  const phrase = distinct[0];
  // A "phrase" longer than this is not a phrase; it is a sentence that found
  // its way into the wrong field, and it would be quoted back to the user.
  return phrase.length <= MAX_STATED_PHRASE_LENGTH ? phrase : null;
}
