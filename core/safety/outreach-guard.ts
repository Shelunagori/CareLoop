/**
 * Who may offer to contact somebody (M12c).
 *
 * Observed in the browser, in ordinary smalltalk:
 *
 *   "...Would you like to send a message to someone, by the way?"
 *
 * immediately before the application's own reconnect card. Two authorities
 * proposing the same action, one of which had decided nothing.
 *
 * WHY A GUARD AND NOT A BETTER PROMPT. Because there already IS a prompt
 * rule — v4 says "You never contact anyone on your own initiative, and you
 * never offer to" — and the model wrote the sentence anyway. That is the
 * lesson this codebase has now learned three times: an instruction is a
 * probability, and the failures worth preventing are not the kind to leave
 * to one. The prompt is sharpened in v5 as the second line of defence; this
 * is the first.
 *
 * WHAT IT REMOVES, AND WHEN. Whole sentences in which the assistant PROPOSES
 * an outreach action, and only on turns where the application is not itself
 * presenting an offer. When there IS an offer, the application appends its
 * own block — which legitimately ends "Would you like me to send it?" — and
 * that block is authoritative and never passes through here.
 *
 * WHAT IT DOES NOT TOUCH. Anything the PERSON did or might do of their own
 * accord: "Did you ring Margaret back?", "Are you seeing John this weekend?"
 * are questions about their life, not offers of an action CareLoop would
 * take. The patterns are anchored on the proposing shapes.
 *
 * Blunt by design, like the deny-list, and for the same reason: the cost of
 * a false positive is a slightly flatter sentence, and the cost of a miss is
 * the product appearing to decide something it did not.
 *
 * Pure. Text in, text out.
 */

/** Verbs that mean "make contact on the person's behalf, or at all". */
const CONTACT_VERB =
  "(?:send|sending|message|messaging|text|texting|write|writing|contact|contacting|" +
  "reach out|reaching out|get in touch|getting in touch|call|calling|ring|ringing|" +
  "pass\\s+(?:\\w+\\s+)?(?:on|along)|let (?:him|her|them|somebody|someone|[A-Z][a-z]+) know|reconnect|reconnecting)";

/**
 * The proposing shapes. Each one is the assistant putting an outreach action
 * on the table; none of them is a question about the person's own week.
 */
const OUTREACH_OFFERS: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  // "Would you like me to send...", "Do you want me to ring..."
  { name: "offer_to_act", pattern: new RegExp(`\\b(?:would|do|shall|should|can|could)\\s+you\\s+(?:like|want)?\\s*me\\s+to\\s+\\w*\\s*${CONTACT_VERB}`, "i") },
  // "Shall I send...", "Should I let him know..."
  { name: "shall_i", pattern: new RegExp(`\\b(?:shall|should|can|could|may)\\s+i\\s+\\w*\\s*${CONTACT_VERB}`, "i") },
  /**
   * "I can send...", "I'd be happy to pass that on."
   *
   * The contracted forms are spelled out rather than left to `\\s+`: "I'd"
   * has no space in it, and a pattern that assumed one silently let the
   * most natural phrasing through — which is how a guard ends up looking
   * like it works.
   */
  { name: "i_can_act", pattern: new RegExp(`\\b(?:i\\s+(?:can|could|am able to|will|would|shall)|i['\u2019](?:d|ll)|i\\s+would|i['\u2019]m)\\s+(?:be\\s+)?(?:happy|glad|able)?\\s*(?:to\\s+)?\\w*\\s*${CONTACT_VERB}`, "i") },
  // "Would you like to send a message to someone?" — the observed sentence.
  { name: "offer_to_them", pattern: new RegExp(`\\b(?:would|do)\\s+you\\s+(?:like|want)\\s+to\\s+\\w*\\s*${CONTACT_VERB}`, "i") },
  // "Want me to ask him?" — the same offer with the opener dropped.
  { name: "want_me_to", pattern: new RegExp(`\\b(?:want|like)\\s+me\\s+to\\s+\\w*\\s*(?:${CONTACT_VERB}|ask)`, "i") },
  // "Let me know if you'd like me to get in touch with anyone."
  { name: "standing_offer", pattern: new RegExp(`\\bif\\s+you\\s*(?:'d|\\s+would)?\\s*(?:ever\\s+)?(?:like|want)\\s+(?:me\\s+to\\s+)?\\w*\\s*${CONTACT_VERB}`, "i") },
];

export type OutreachVerdict = {
  /** The text with any proposing sentences removed. */
  text: string;
  /** The rule names that fired, for the log. Never the sentences. */
  removed: string[];
};

/**
 * What is said when the whole turn was an outreach offer.
 *
 * Vanishingly rare, and it still must not be empty: an empty completion
 * fails the turn, which would turn a tone problem into a broken reply. It
 * asserts nothing about anybody.
 */
export const OUTREACH_FALLBACK = "Tell me more.";

/** Splits on sentence ends and newlines, keeping the separators' effect. */
function sentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+|\n+/);
}

export function stripUnpromptedOutreach(text: string): OutreachVerdict {
  const removed: string[] = [];
  const kept: string[] = [];

  for (const sentence of sentences(text)) {
    const rule = OUTREACH_OFFERS.find(({ pattern }) => pattern.test(sentence));
    if (rule) {
      // The RULE, never the sentence. A suppressed line is still the
      // person's conversation, and it is not log material.
      removed.push(rule.name);
      continue;
    }
    kept.push(sentence);
  }

  if (removed.length === 0) return { text, removed };

  const remainder = kept.join(" ").replace(/\s+/g, " ").trim();
  return { text: remainder.length > 0 ? remainder : OUTREACH_FALLBACK, removed };
}

/** Whether a fragment contains a proposing shape. Used by the stream guard. */
export function offersOutreach(fragment: string): boolean {
  return OUTREACH_OFFERS.some(({ pattern }) => pattern.test(fragment));
}

/**
 * Could this partial sentence still turn into an offer?
 *
 * Streaming and checking are only incompatible if EVERYTHING is buffered.
 * Ordinary prose streams token by token as it always has; a sentence that
 * has begun like an offer is held back until it is complete and can be
 * judged. Holding back "Would you…" for the length of one sentence is
 * imperceptible; showing somebody "Would you like me to send him a message?"
 * and retracting it is not.
 *
 * Matching is two-way on purpose: a two-character partial is a PREFIX of an
 * opener, and a long partial STARTS WITH one. Both mean "not yet safe to
 * show".
 */
const OFFER_OPENERS: readonly string[] = [
  "would you", "do you", "shall i", "should i", "can i", "could i", "may i",
  "i can", "i could", "i will", "i would", "i am able", "i'd", "i\u2019d",
  "i'll", "i\u2019ll", "i'm happy", "i\u2019m happy", "i'm glad to", "i\u2019m glad to",
  "want me", "like me", "if you", "let me know if", "just say the word",
];

export function mayStillBecomeOutreach(partialSentence: string): boolean {
  const value = partialSentence.replace(/\s+/g, " ").trimStart().toLowerCase();
  if (value.length === 0) return false;
  return OFFER_OPENERS.some(
    (opener) => opener.startsWith(value) || value.startsWith(opener),
  );
}
