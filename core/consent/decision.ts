/**
 * The consent decision parser (docs/04 section 11.1).
 *
 * Deterministic, ordered, and deliberately conservative: it recognises a small
 * vocabulary of clear answers and calls everything else unclear. Consent is
 * never inferred from sentiment, enthusiasm, topic or silence.
 *
 * ORDER IS LOAD-BEARING. Ambiguity is checked first because "not sure"
 * contains a negation; refusal is checked before agreement because "don't send
 * it" contains "send it". Checking agreement first would turn a refusal into a
 * send, which is the single worst bug this product can have.
 *
 * AND A YES IS THE WHOLE SENTENCE, NOT ITS FIRST WORD. "yes but later"
 * approved, because the affirmative opener is anchored at the start while the
 * deferral vocabulary was either anchored too ("later") or required an exact
 * bigram ("maybe later"). A message that OPENED affirmative and then took it
 * back matched only the opener. Dictation made that unacceptable rather than
 * merely wrong: a transcript is punctuated by a speech-to-text model, not by
 * the person, so "yes but later" and "yes, but maybe later" are one sentence
 * arriving with different commas, and one of them used to send a message to
 * somebody's family. Qualifiers are therefore unanchored and disqualifying,
 * and punctuation is removed before anything is matched.
 */
export type ConsentDecision = "approve" | "decline" | "unclear";

export type ConsentReading = {
  decision: ConsentDecision;
  /**
   * Which rule fired, or null when nothing in the message was an answer at
   * all. `unclear` with a null rule means the person said something unrelated
   * - they changed the subject rather than hesitated - and the caller should
   * carry on with ordinary conversation instead of asking again.
   */
  matchedRule: string | null;
};

type Rule = { name: string; pattern: RegExp };

/** Hesitation and deferral. Never consent, and never a refusal either. */
const AMBIGUOUS: readonly Rule[] = [
  { name: "maybe", pattern: /^(maybe|perhaps|possibly)\b/ },
  { name: "maybe_later", pattern: /\bmaybe later\b/ },
  { name: "not_sure", pattern: /\b(not sure|unsure|no idea)\b/ },
  { name: "i_guess", pattern: /\bi (guess|suppose)\b/ },
  { name: "later", pattern: /^(later|another time|some other time)\b/ },
  { name: "defer_to_you", pattern: /\b(whatever you think|you decide|up to you|as you like)\b/ },
  { name: "dont_know", pattern: /\bi (don'?t|do not) know\b|\bdunno\b/ },
  { name: "think_about_it", pattern: /\b(think about it|let me think)\b/ },
];

/** Refusal. Checked before agreement so "don't send it" cannot read as "send it". */
const DECLINE: readonly Rule[] = [
  { name: "no", pattern: /^(no|nope|nah|naw)\b/ },
  { name: "no_thanks", pattern: /\bno,? thank(s| you)\b/ },
  { name: "dont_send", pattern: /\b(don'?t|do not|dont) send\b/ },
  { name: "not_now", pattern: /\bnot (now|today|this time|yet)\b/ },
  { name: "rather_not", pattern: /\b(rather not|prefer not)\b/ },
  { name: "cancel", pattern: /\b(cancel|forget it|leave it|never mind|nevermind)\b/ },
  { name: "dont_bother", pattern: /\b(don'?t|do not|dont) bother\b/ },
];

/** Agreement. Anchored or bounded; never a bare substring. */
const APPROVE: readonly Rule[] = [
  {
    name: "affirmative_opener",
    pattern: /^(yes|yeah|yep|yup|aye|ok|okay|sure|absolutely|definitely|certainly|please do|go ahead|go on)\b/,
  },
  { name: "send_it", pattern: /\b(send it|send that|send the message|please send|send it please)\b/ },
  { name: "go_ahead", pattern: /\bgo ahead\b/ },
  { name: "thats_fine", pattern: /\bthat'?s (fine|good|great|lovely|perfect)\b/ },
  { name: "sounds_good", pattern: /\b(sounds (good|lovely|fine)|fine by me|that works)\b/ },
  { name: "yes_please", pattern: /\byes,? please\b/ },
];

/**
 * Qualifiers that disqualify an affirmative, wherever they appear.
 *
 * Unanchored ON PURPOSE - that is the whole fix. These are not new meanings;
 * every one of them already makes a message ambiguous or a refusal when it
 * stands alone. What changes is that they now also count when they arrive
 * AFTER a "yes", which is how people actually hedge: "yes, but not this week".
 *
 * Deliberately not here: "but", "however", "although". A message can turn on
 * one of those without deferring anything ("yes, but keep it short"), and a
 * parser that treated contrast as hesitation would start refusing consent
 * people had actually given.
 *
 * Also deliberately not here: outright refusal words. "don't send it" already
 * contains "send it", so it matches an affirmative rule; if refusal were also
 * a qualifier it would come out UNCLEAR, and a plain "no, don't send it" would
 * stop being a decline. Refusal stays one step further down, where it has
 * always been, and wins.
 */
const QUALIFIER: readonly Rule[] = [
  { name: "later", pattern: /\b(later|another time|some other time|in a (bit|while))\b/ },
  { name: "maybe", pattern: /\b(maybe|perhaps|possibly)\b/ },
  { name: "not_now", pattern: /\bnot (now|today|yet|this time|this week)\b/ },
  { name: "not_sure", pattern: /\b(not sure|unsure|no idea)\b/ },
];

/**
 * Lowercase, drop sentence punctuation, collapse whitespace.
 *
 * The punctuation goes because a transcriber put it there. Apostrophes are
 * KEPT - stripping them would merge "don't" into "dont" only by accident of
 * the patterns above, and both spellings are handled explicitly instead.
 */
export function normalizeReply(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[.,;:!?\u2026\u2013\u2014"\u201c\u201d()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function firstMatch(rules: readonly Rule[], text: string): string | null {
  for (const rule of rules) {
    if (rule.pattern.test(text)) return rule.name;
  }
  return null;
}

export function readConsent(raw: string): ConsentReading {
  const text = normalizeReply(raw);
  if (text.length === 0) return { decision: "unclear", matchedRule: null };

  const ambiguous = firstMatch(AMBIGUOUS, text);
  if (ambiguous) return { decision: "unclear", matchedRule: ambiguous };

  const approve = firstMatch(APPROVE, text);

  // A yes that takes itself back decides nothing. Checked BEFORE refusal so a
  // contradiction ("yes, not now") asks once more rather than terminating the
  // opportunity on a sentence that said both things - and only when an
  // affirmative is actually present, so a bare "not now" is still a decline.
  if (approve) {
    const qualifier = firstMatch(QUALIFIER, text);
    if (qualifier) return { decision: "unclear", matchedRule: `qualified_${qualifier}` };
  }

  const decline = firstMatch(DECLINE, text);
  if (decline) return { decision: "decline", matchedRule: decline };

  if (approve) return { decision: "approve", matchedRule: approve };

  // Not an answer to the question. The caller carries on talking.
  return { decision: "unclear", matchedRule: null };
}

/**
 * The seam for an LLM normaliser (docs/04, this milestone's section 4).
 *
 * DECLARED, NOT IMPLEMENTED. If natural speech ever outgrows the vocabulary
 * above, a model may return one of these three labels and nothing else - no
 * free text, no transition, no side effect. The deterministic service still
 * decides, from the label plus the opportunity's current state. M5 makes no
 * model call on the consent path at all, which is the strongest version of
 * "the LLM is never the decision-maker".
 */
export type ConsentClassification = { decision: ConsentDecision };

export interface ConsentClassifierProvider {
  classify(input: { reply: string }): Promise<ConsentClassification>;
}
