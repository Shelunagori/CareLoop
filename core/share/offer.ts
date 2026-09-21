import type { DetectorEventType } from "@/core/detection/types";
import type { ReconnectProposal } from "@/core/detection/proposal";

/**
 * The verbatim offer block (F1, docs/04 section 11.2a).
 *
 * The model's authority in this transition is two things: whether now is a
 * good moment, and an optional lead-in sentence of its own words. The draft
 * itself is inserted by THIS function, from storage, byte for byte.
 *
 * Why that distinction is load-bearing and not pedantry: consent has to attach
 * to the bytes that will actually be sent. If the model paraphrases the draft
 * when presenting it - "I'll ask John about the weekend" - then the user has
 * approved the paraphrase while the system sends something else. Both might be
 * perfectly reasonable sentences; they are still not the same sentence, and
 * the user's "yes" provably referred to the one they were shown.
 *
 * The model cannot paraphrase this because it never receives it: conversational
 * context carries only `{ entityId, entityName, status: 'drafted' }` (E1).
 */
export const OFFER_CLOSING_QUESTION = "Would you like me to send it?";

export function buildOfferBlock(input: {
  entityName: string;
  /** Exactly as stored on the opportunity. Never reformatted. */
  renderedText: string;
}): string {
  return [
    `I can send ${input.entityName} this message:`,
    "",
    input.renderedText,
    "",
    OFFER_CLOSING_QUESTION,
  ].join("\n");
}

export type TranscriptMessage = { role: string; content: string; createdAt: string };

/**
 * Whether a transcript already carries this exact draft. Substring on the
 * exact stored bytes, so a paraphrase would not satisfy it.
 */
export function transcriptShowsDraft(
  messages: ReadonlyArray<{ role: string; content: string }>,
  renderedText: string,
): boolean {
  return messages.some(
    (message) => message.role === "assistant" && message.content.includes(renderedText),
  );
}

/**
 * Whether an already-`offered` opportunity still needs showing.
 *
 * Two different situations look alike from the database, and telling them
 * apart is the whole job here:
 *
 *   a CONCURRENT turn has just marked it offered and is streaming the block
 *   right now - say nothing, or the person sees the same message twice;
 *
 *   an EARLIER turn marked it offered and then died before the block was
 *   persisted - show it, because otherwise the person is waiting on an
 *   opportunity they were never shown.
 *
 * The discriminator is the transcript: a turn that presented the draft leaves
 * an assistant message dated at or after `offered_at`. No such message means
 * nobody has finished presenting it yet, so this turn stays quiet. What is
 * never in question is WHICH bytes get shown - always the stored draft.
 */
export function needsRepresenting(
  messages: ReadonlyArray<TranscriptMessage>,
  input: { renderedText: string; offeredAt: string },
): boolean {
  const since = Date.parse(input.offeredAt);
  const after = messages.filter(
    (message) => message.role === "assistant" && Date.parse(message.createdAt) >= since,
  );
  if (after.length === 0) return false;
  return !after.some((message) => message.content.includes(input.renderedText));
}

/* ------------------------------------------------------------------------ */
/* WHY the offer appeared                                                    */
/* ------------------------------------------------------------------------ */

/**
 * The cadence preamble (M12).
 *
 * A cadence-gap offer is the application noticing something on its own. Live
 * observation: after "hello" and "good and u", CareLoop surfaced "I can send
 * John this message...". The detector was correct - six visits, median 7
 * days, MAD 0, threshold 11, last visit 13 days ago - and the person was told
 * none of it. Correct proactivity that arrives without its reason reads as
 * arbitrary.
 *
 * So the reason is stated, and it is stated HERE: from the stored proposal,
 * by a total function, with no model anywhere in the path. The model never
 * receives the proposal (E1) and so cannot invent how often somebody visits,
 * how long it has been, or why the gap exists - the four claims that would be
 * most convincing and least checkable.
 *
 * It is deliberately NOT part of `buildOfferBlock`. The block's bytes are the
 * ones consent attaches to and the ones the browser strips to draw the card;
 * a sentence folded into them would be invisible to the person and would
 * change the string the transcript is searched for.
 */

/** Days -> how often, in words. Buckets, so the wording is stable and total. */
export function cadencePhrase(medianGapDays: number): string {
  if (medianGapDays < 2) return "most days";
  if (medianGapDays < 4) return "every few days";
  if (medianGapDays < 11) return "about once a week";
  if (medianGapDays < 19) return "about every couple of weeks";
  if (medianGapDays < 46) return "about once a month";
  // Math.max keeps the plural branch honest: no input reaching it may render
  // as "about every 1 months".
  return `about every ${Math.max(2, Math.round(medianGapDays / 30))} months`;
}

/** "see"/"saw" for a visit, "hear from"/"heard from" for a call. */
function contactVerb(eventType: DetectorEventType): { present: string; past: string } {
  return eventType === "call"
    ? { present: "hear from", past: "heard from" }
    : { present: "see", past: "saw" };
}

function days(count: number): string {
  return count === 1 ? "1 day" : `${count} days`;
}

/**
 * The sentence shown above a cadence offer, or null when there should be none.
 *
 * Null for `user_stated_absence`: the person supplied that context themselves,
 * in this conversation, and restating it back at them would be the system
 * explaining the person to themselves. The two triggers stay separate.
 */
export function buildCadencePreamble(proposal: ReconnectProposal): string | null {
  if (proposal.observation.kind !== "no_mention_since") return null;

  const elapsed = proposal.observation.days;
  const verb = contactVerb(proposal.eventType);
  const median = proposal.pattern?.medianGapDays;

  // A rhythm claim needs a usable rhythm. `pattern` is always present on a
  // cadence signal today - the detector requires an ACTIVE baseline - so this
  // is the row written by a deploy that did not, or a median that is not a
  // number to divide by. Either way the elapsed time is still a fact, and it
  // is stated alone rather than dressed up with an invented pattern.
  if (median === undefined || !Number.isFinite(median) || median <= 0) {
    return `It's been ${days(elapsed)} since you last ${verb.past} ${proposal.entityName}.`;
  }

  return `You usually ${verb.present} ${proposal.entityName} ${cadencePhrase(median)}, and it's been ${days(elapsed)}.`;
}
