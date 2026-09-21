import type { ClosureFact } from "./closure";

/**
 * A DETERMINISTIC BOUNDARY AROUND CLOSURE TURNS.
 *
 * Live acceptance: the closure surfaced correctly - "John replied that they
 * are planning to visit this weekend." - and the model's own continuation
 * immediately followed it with "You're welcome, I hope you hear from John
 * soon." One turn, two contradictory claims about the outside world, and the
 * false one was the one written in the companion's own voice.
 *
 * The prompt already forbids this, in as many words, and the prompt was not
 * enough. It never will be: an instruction is a probability, and a person
 * being told their son has not been in touch when he has is not a thing to
 * leave to probability. So the application checks the generated text on the
 * turns where it knows the answer, and refuses to show a contradiction.
 *
 * WHAT THIS IS NOT. Not a general truthfulness filter, not sentiment analysis,
 * and not a rewrite. It runs ONLY when a verified closure is being surfaced -
 * the one moment the application knows for certain that the waiting is over -
 * and it either passes the model's words through untouched or replaces them
 * wholesale with a sentence derived from the verified fact. There is no
 * partial edit: a sentence that has to be repaired was not safe to show.
 */

/**
 * Ways of saying "no reply yet", written to survive paraphrase.
 *
 * Name-agnostic by construction - `[^.!?]{0,40}` spans whatever the model put
 * between the verb and the person, so "hear from John", "hear from him" and
 * "hear from your son" are one pattern rather than three. Anchoring on the
 * VERBS is what keeps this general: the contradiction lives in "waiting",
 * "hope to hear", "let you know when", never in the name.
 */
const STILL_WAITING = [
  // "I hope you hear from John soon", "hoping to hear back from him"
  { name: "hope_to_hear", pattern: /\bhop(e|ing|es)\b[^.!?]{0,40}\bhear\b/i },
  // "I hope John replies", "hopefully he gets back to you"
  {
    name: "hope_they_reply",
    pattern: /\bhope(fully)?\b[^.!?]{0,40}\b(repl(y|ies)|get(s)? back|respond(s)?|answer(s)?|writes? back)\b/i,
  },
  // "still waiting", "waiting to hear", "we're waiting for John"
  { name: "waiting", pattern: /\bwait(ing)?\b[^.!?]{0,20}\b(to hear|for|on)\b/i },
  { name: "still_waiting", pattern: /\bstill\b[^.!?]{0,20}\bwait(ing)?\b/i },
  // "I haven't heard back", "we have not heard from him yet"
  {
    name: "not_heard",
    pattern: /\b(haven'?t|hasn'?t|have not|has not|not)\b[^.!?]{0,30}\bheard\b/i,
  },
  // "I'll let you know when he replies", "as soon as she answers"
  {
    name: "will_notify",
    pattern: /\b(let you know|as soon as|the moment|once)\b[^.!?]{0,40}\b(repl(y|ies)|get(s)? back|respond(s)?|answer(s)?|hear)\b/i,
  },
  // "no reply yet", "nothing back from him yet"
  { name: "nothing_yet", pattern: /\b(no|nothing|not)\b[^.!?]{0,30}\b(reply|response|word|news)\b[^.!?]{0,20}\byet\b/i },
  // "when he gets back to you", "if she replies"
  {
    name: "conditional_reply",
    pattern: /\b(when|if)\b[^.!?]{0,25}\b(repl(y|ies)|get(s)? back to you|respond(s)?|write(s)? back)\b/i,
  },
] as const;

export type ContradictionVerdict =
  | { contradicts: false }
  /** `rule` names the pattern, for a log line that carries no message text. */
  | { contradicts: true; rule: string };

/**
 * Does this text claim the reply has not arrived?
 *
 * Judged per SENTENCE. A single paragraph can hold a correct acknowledgement
 * and a contradictory afterthought - which is exactly what production
 * produced - and scanning the whole blob at once lets the correct half mask
 * the false one.
 */
export function contradictsClosure(text: string): ContradictionVerdict {
  for (const sentence of text.split(/(?<=[.!?])\s+|\n+/)) {
    for (const { name, pattern } of STILL_WAITING) {
      if (pattern.test(sentence)) return { contradicts: true, rule: name };
    }
  }
  return { contradicts: false };
}

/**
 * What is said instead, derived ONLY from the verified closure.
 *
 * It states no new fact about anyone. The topic and the answer both come from
 * the persisted response, so the most it ever does is wish well for something
 * the family member has actually agreed to - and when they did not agree, it
 * says nothing about the future at all.
 *
 * Deliberately not "I'm sorry to hear that" on a decline: how the person feels
 * about a no is theirs to say, not CareLoop's to assume.
 */
export function safeClosureContinuation(fact: Pick<ClosureFact, "topic" | "responseIntent">): string {
  // "no", "unsure" and "other" all mean nothing was agreed to, so nothing
  // about a visit or a call may be wished well.
  if (fact.responseIntent !== "yes") return "You're welcome.";
  // M12e: a wellbeing closure gets the plainest of the three. "I hope you
  // feel better" would be the system deciding how the person is, which is
  // the one thing this whole path refuses to do — the family member agreed
  // to check in, and that is all that was verified.
  if (fact.topic === "wellbeing") return "You're welcome. I'm glad they'll be in touch.";
  return fact.topic === "call"
    ? "You're welcome. I hope the call goes well."
    : "You're welcome. I hope the visit goes well.";
}
