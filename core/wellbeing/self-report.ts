/**
 * "I wasn't feeling good today." — the person's own words, and nothing else
 * (M12e).
 *
 * WHAT THIS IS. A deterministic reader of one sentence, looking for the
 * person SAYING they were unwell or in pain. It is the application's own
 * evidence, of exactly the same kind as an explicit absence assertion: a
 * report by the only person who actually knows.
 *
 * WHAT THIS IS EMPHATICALLY NOT, and the type makes each impossible rather
 * than discouraged:
 *
 *   not a mood, loneliness or cognitive inference — there is no field for
 *   one and no model in the path;
 *   not a severity — `WellbeingSelfReport` has no number;
 *   not a diagnosis, symptom record or trend — the matched phrase is kept
 *   for the log and never travels outward;
 *   not "the model thinks they seem unwell" — no model is consulted, here
 *   or anywhere downstream of here.
 *
 * WHY A PHRASE RULE AND NOT A CLASSIFIER. A classifier would make an
 * inference about a person's health the load-bearing part of a path that
 * can send a message to their family. A phrase rule can only ever fire on
 * something they typed or said out loud, which means the worst case is that
 * CareLoop offers to pass on a sentence the person really did utter.
 *
 * IT UNDER-DETECTS ON PURPOSE. "My knee has been playing up" and "I've had
 * a rough few days" are not matched. A missed report costs one unremarkable
 * conversational turn; a false one puts words about somebody's health in
 * front of them, and offers to forward them. The asymmetry is not close.
 */

/**
 * Lowercase, collapse whitespace, and EXPAND CONTRACTIONS.
 *
 * Expanding first is what keeps the rules below readable: "I wasn't", "I
 * was not", "I've been" and "I have been" become one shape each, so a
 * pattern says what it means instead of enumerating apostrophes. No
 * stemming and no synonym list — this is spelling, not meaning.
 */
function normalize(text: string): string {
  return text
    .replace(/[\u2018\u2019\u02BC]/g, "'")
    .toLowerCase()
    .replace(/\bi'm\b/g, "i am")
    .replace(/\bi've\b/g, "i have")
    .replace(/\bi'd\b/g, "i would")
    .replace(/\bit's\b/g, "it is")
    .replace(/\byou're\b/g, "you are")
    .replace(/\byou've\b/g, "you have")
    .replace(/\b(was|is|were|are|had|have|has|did|do|does|could|would|should|ai)n't\b/g, "$1 not")
    .replace(/\bcan't\b/g, "can not")
    .replace(/\bcannot\b/g, "can not")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Phrases that mean somebody ELSE, or nobody in particular, is the subject.
 *
 * Checked first and applied to the WHOLE message, so "I hope you are not
 * feeling unwell" and "the doctor said if I feel unwell I should call" are
 * refused before any positive rule runs.
 */
const SUBJECT_IS_NOT_THEM: readonly RegExp[] = [
  /\byou (?:are|were|have)?\s*(?:not )?(?:feel|feeling|felt|unwell|ill|sick|poorly)\b/,
  /\bhope\b/,
  /\bif i\b/,
  /\bwhen i\b/,
  /\bwhenever\b/,
  /\bwould (?:feel|be)\b/,
  /\bdo not want to (?:feel|be)\b/,
  /\bin case\b/,
];

/** Hedges that may sit between the verb and the state. */
const HEDGE = "(?:a bit |a little |quite |rather |very |really |pretty |so |too |that |all )*";

/** First-person statements of being unwell or in pain. */
const SELF_REPORT: readonly RegExp[] = [
  // "I was not feeling well" / "I have not been feeling great"
  new RegExp(
    `\\bi (?:was|am|were|have been|had been|has been) not ${HEDGE}(?:feeling|felt) ${HEDGE}(?:good|well|great|myself|right|ok|okay|fine)\\b`,
  ),
  // "I did not feel well"
  new RegExp(`\\bi (?:did|do) not feel ${HEDGE}(?:good|well|great|myself|right|ok|okay|fine)\\b`),
  // "I have been unwell" / "I felt rough" / "I am ill"
  new RegExp(
    `\\bi (?:am|was|were|have been|had been|got|feel|felt|have felt|am feeling|was feeling) ${HEDGE}(?:unwell|ill|sick|poorly|under the weather|rough|lousy)\\b`,
  ),
  // "I was in pain"
  /\bi (?:am|was|were|have been) in (?:a lot of |some |quite a lot of )?pain\b/,
  /\bi (?:am|was|were|have been) hurting\b/,
  // "my back was really hurting"
  /\bmy \w+(?: \w+)? (?:was|is|has been|were|have been) (?:really |very |quite |so )?(?:hurting|sore|painful|aching|playing up)\b/,
  // "I had a bad day" is NOT here on purpose: a bad day is not a statement
  // about health, and reading it as one is the inference this module
  // exists to refuse.
];

/**
 * "Not feeling like <doing something>" is a preference, not a symptom.
 * Checked after the positive rules so it can veto a loose match.
 */
const NOT_ABOUT_HEALTH: readonly RegExp[] = [
  /\bfeel(?:ing)? like\b/,
  /\bfeel(?:ing)? up to\b/,
];

/**
 * Language that is not an ordinary self-report at all.
 *
 * THIS IS A ROUTING DECISION, NOT A TRIAGE SCORE. It has one job: keep a
 * statement about immediate danger out of the ordinary wellbeing-share and
 * reconnect flows, because "would you like me to let John know?" is a
 * grotesque answer to somebody saying they cannot breathe. What happens
 * INSTEAD is unchanged from v1 of the conversation prompt: say plainly that
 * CareLoop cannot help with this and that they should speak to someone who
 * can.
 *
 * CareLoop is not medically validated and is not an emergency service. This
 * list does not assess anything, does not rank anything, does not contact
 * anybody, and is not a substitute for the deterministic escalation a
 * production system would need — see docs/08 P9.
 */
const URGENT: readonly RegExp[] = [
  /\bchest pain(?:s)?\b/,
  /\bcan not breathe\b/,
  /\btrouble breathing\b/,
  /\bstruggling to breathe\b/,
  /\bi (?:have )?fallen\b/,
  /\bi fell (?:and|down)\b/,
  /\bi can not (?:get|stand) up\b/,
  /\bbleeding\b/,
  /\bambulance\b/,
  /\bemergency\b/,
  /\b999\b|\b911\b|\b112\b/,
  /\bheart attack\b/,
  /\bstroke\b/,
  /\bpassed out\b/,
  /\bblacked out\b/,
  /\bcollapsed\b/,
  /\bunbearable pain\b/,
  /\bsevere pain\b/,
  /\bwant to (?:die|end it)\b/,
  /\bkill myself\b/,
  /\bharm myself\b/,
  /\bhurt myself\b/,
];

export type WellbeingReading =
  /** Nothing in the message says they were unwell. The common case. */
  | { kind: "none" }
  /**
   * They said so. `matchedPhrase` is the normalised sentence fragment that
   * fired, kept for the log and for a human reading it back — it is NEVER
   * put in a message, a payload or a prompt.
   */
  | { kind: "self_report"; matchedPhrase: string }
  /**
   * Language about immediate danger. Every proactive path stands down.
   */
  | { kind: "urgent"; matchedPhrase: string };

export function readWellbeing(text: string): WellbeingReading {
  const normalized = normalize(text);
  if (normalized.length === 0) return { kind: "none" };

  for (const pattern of URGENT) {
    const hit = pattern.exec(normalized);
    if (hit) return { kind: "urgent", matchedPhrase: hit[0] };
  }

  if (SUBJECT_IS_NOT_THEM.some((pattern) => pattern.test(normalized))) {
    return { kind: "none" };
  }
  if (NOT_ABOUT_HEALTH.some((pattern) => pattern.test(normalized))) {
    return { kind: "none" };
  }

  for (const pattern of SELF_REPORT) {
    const hit = pattern.exec(normalized);
    if (hit) return { kind: "self_report", matchedPhrase: hit[0] };
  }

  return { kind: "none" };
}

/** True only for an ordinary explicit self-report. Urgent language is not one. */
export function isSelfReportedUnwell(text: string): boolean {
  return readWellbeing(text).kind === "self_report";
}

/**
 * Should every proactive path stand down for this message?
 *
 * Used by the turn to suppress the reconnect card and the wellbeing share.
 * It suppresses; it never escalates.
 */
export function suppressesProactiveOffers(text: string): boolean {
  return readWellbeing(text).kind === "urgent";
}
