/**
 * The outbound deny-list (docs/03 section 10.4).
 *
 * A blunt instrument, deliberately. It will occasionally cost a nicer
 * sentence; the trade is correct, because the product invariant it enforces —
 * "no inference about internal state" — is unacceptable-in-kind to break, and
 * the cost of a rejection is a slightly flatter template, never a failed turn.
 *
 * Grouped so the corpus is reviewable by a non-engineer and so a false
 * positive can be argued about against the group's intent rather than a flat
 * list of words.
 */

/** Claims about how the person feels. Not ours to make. */
export const AFFECT_TERMS = [
  "lonely", "loneliness", "lonesome", "isolated", "isolation", "alone",
  "sad", "sadness", "unhappy", "depressed", "depression", "miserable",
  "distressed", "upset", "anxious", "anxiety", "withdrawn", "withdrawing",
  "struggling", "suffering", "low mood", "not coping", "down in the dumps",
  "longing", "pining", "misses you", "miss you", "missing you", "missed you",
  "feeling low", "in low spirits",
] as const;

/** Claims about health, capacity or care. Not a medical device (docs/06 s18). */
export const CLINICAL_TERMS = [
  "diagnosis", "diagnosed", "symptom", "symptoms", "dementia", "alzheimer",
  "alzheimers", "cognitive", "confused", "confusion", "memory loss",
  "forgetful", "frail", "frailty", "decline", "declining", "deteriorating",
  "deterioration", "unwell", "ill", "illness", "health", "medical",
  "medication", "carer", "care home", "nursing home", "condition",
  "mental health", "therapy", "hospital",
] as const;

/** Language that reframes a companion as a monitoring product. */
export const MONITORING_TERMS = [
  "monitoring", "monitored", "tracking", "tracked", "surveillance",
  "flagged", "our system", "we noticed", "we have noticed", "wellbeing",
  "well-being", "at risk", "risk of", "checking up on", "check up on",
  "keeping an eye", "keeping tabs", "care plan", "assessment",
] as const;

/** Alarm. A reconnect nudge is not an alert. */
export const ALARM_TERMS = [
  "worried", "worry", "worrying", "concerned", "concern", "alarmed",
  "alarming", "urgent", "urgently", "emergency", "immediately",
] as const;

export const DENIED_TERMS: readonly string[] = [
  ...AFFECT_TERMS,
  ...CLINICAL_TERMS,
  ...MONITORING_TERMS,
  ...ALARM_TERMS,
];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Lowercase and collapse whitespace. Apostrophes are deliberately KEPT:
 * stripping them would turn "I'll" into "ill" and reject a perfectly warm
 * sentence for a word nobody wrote.
 */
export function normalizeForGuard(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

const DENIED_PATTERNS: ReadonlyArray<{ term: string; pattern: RegExp }> = DENIED_TERMS.map(
  (term) => ({ term, pattern: new RegExp(`\\b${escapeRegExp(term)}\\b`, "i") }),
);

export function findDeniedTerm(text: string): string | null {
  const normalized = normalizeForGuard(text);
  for (const { term, pattern } of DENIED_PATTERNS) {
    if (pattern.test(normalized)) return term;
  }
  return null;
}

/**
 * Causal inference: linking a lack of contact to anything about the person.
 *
 * Two independent halves must BOTH appear. That is what makes the rule survive
 * vocabulary the deny-list has never seen — "Dad has been quiet because you
 * haven't visited" carries no listed word and is exactly the sentence this
 * product must never send.
 */
export const ABSENCE_CONSTRUCTION =
  /\b(has|have|had)\s*n[o']?t\b|\bnot\s+(been|seen|heard|visited|called|spoken|in touch)\b|\bno\s+(visit|visits|call|calls|contact|word|news)\b|\bwithout\s+(a\s+)?(visit|call|word)\b/i;

export const CAUSAL_CONNECTIVE =
  /\b(because|since|that'?s why|thats why|which is why|due to|as a result|after not|from not|owing to|ever since|so he|so she|so they)\b/i;

export function findCausalInference(text: string): string | null {
  const normalized = normalizeForGuard(text);
  const absence = ABSENCE_CONSTRUCTION.exec(normalized);
  if (!absence) return null;
  const connective = CAUSAL_CONNECTIVE.exec(normalized);
  if (!connective) return null;
  return `${connective[0]} + ${absence[0]}`;
}
