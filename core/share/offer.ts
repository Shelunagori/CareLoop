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
