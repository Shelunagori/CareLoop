import { daysBetween } from "@/core/baseline/day";
import { baselineConfig, type BaselineConfig } from "@/core/baseline/config";

/**
 * One bounded proactive opening (M12d).
 *
 * THE POINT, AND ITS LIMIT. CareLoop should be able to open a conversation
 * rather than only answer one — "How did the visit with Margaret go
 * yesterday?" is the difference between a companion and a text box. It
 * should NOT become an agent that decides to say things. So this is one
 * sentence, at most once per session, about one event the person themselves
 * reported, and it exists only when a specific deterministic test passes.
 *
 * WHAT MAY POWER IT: a stored `interaction_event` with positive polarity,
 * certainty at or above the baseline's own floor, exact or day precision,
 * and a date inside a short window. Nothing else. That row exists because
 * the person said the thing happened and the extractor resolved it to an
 * entity — it is the same evidence the cadence baseline is computed from,
 * and it cannot describe an event nobody reported.
 *
 * WHAT MAY NOT: episodes (LLM-written summaries, which can carry inference),
 * baselines (a statistic is not an event), absence assertions (raising
 * somebody's absence unprompted as a greeting is the one thing this product
 * must never feel like), family replies (application-owned, and they have
 * their own deterministic surface), and anything at all about mood, health
 * or how often somebody visits.
 *
 * WHY THE SENTENCE IS DETERMINISTIC. The brief could be handed to the model
 * to phrase, and the shape of that is left open below. It is not done here
 * because the failure mode is specific and this codebase has met it twice:
 * a model given a name and a date writes what it imagines happened. A
 * template given a name and a date cannot.
 */

export type OpeningEventType = "visit" | "call";

/** The only kind of row that may power an opening. */
export type OpeningCandidate = {
  entityId: string;
  /** Already checked against the presentation rule by the caller. */
  entityName: string;
  eventType: OpeningEventType;
  occurredAt: Date;
  occurredAtPrecision: "exact" | "day" | "week" | "unknown";
  certainty: number;
  polarity: "positive" | "negative" | "absence";
};

export type OpeningConfig = {
  /** No opening about something older than this. A stale question is worse than none. */
  readonly maxAgeDays: number;
  /** Nor about today: "how did it go" about this morning is presumptuous. */
  readonly minAgeDays: number;
};

export const OPENING_CONFIG: OpeningConfig = {
  minAgeDays: 1,
  maxAgeDays: 3,
};

export type OpeningDecision =
  | { open: true; entityId: string; entityName: string; eventType: OpeningEventType; daysAgo: number }
  | {
      open: false;
      reason:
        | "no_candidate"
        | "conversation_already_underway"
        | "open_consent_flow"
        | "unresolved_draft"
        | "already_surfaced";
    };

export type OpeningInput = {
  /** Positive, recent events the caller has already loaded. */
  candidates: readonly OpeningCandidate[];
  now: Date;
  /** Messages in the CURRENT sitting. A greeting interrupts nothing. */
  messagesInSitting: number;
  /** Any opportunity awaiting an answer, or any message awaiting a reply. */
  openConsentFlow: boolean;
  /** Text already sitting in the composer. */
  unresolvedDraft: boolean;
  /** This browser session has already had one. */
  alreadySurfaced: boolean;
  config?: OpeningConfig;
  baseline?: BaselineConfig;
};

/**
 * Whether to open, and about what.
 *
 * Order matters and is not incidental: reasons the PERSON has something
 * outstanding come before the absence of anything to say, so the log reads
 * as an explanation rather than a shrug.
 */
export function decideOpening(input: OpeningInput): OpeningDecision {
  if (input.alreadySurfaced) return { open: false, reason: "already_surfaced" };
  // A conversation in progress is not an opening. Reusing the sitting idea
  // from cadence pacing on purpose: a conversation row outlives a
  // conversation, and "they have just arrived" is a fact about timestamps.
  if (input.messagesInSitting > 0) return { open: false, reason: "conversation_already_underway" };
  if (input.openConsentFlow) return { open: false, reason: "open_consent_flow" };
  if (input.unresolvedDraft) return { open: false, reason: "unresolved_draft" };

  const config = input.config ?? OPENING_CONFIG;
  const baseline = input.baseline ?? baselineConfig;

  const eligible = input.candidates
    .filter((candidate) => {
      if (candidate.polarity !== "positive") return false;
      if (candidate.certainty < baseline.minCertainty) return false;
      if (candidate.occurredAtPrecision !== "exact" && candidate.occurredAtPrecision !== "day") {
        return false;
      }
      if (candidate.entityName.trim().length === 0) return false;
      const daysAgo = daysBetween(candidate.occurredAt, input.now);
      return daysAgo >= config.minAgeDays && daysAgo <= config.maxAgeDays;
    })
    // Most recent first, then a stable tie-break so two runs never disagree.
    .sort((a, b) => {
      const byDate = b.occurredAt.getTime() - a.occurredAt.getTime();
      return byDate !== 0 ? byDate : a.entityId < b.entityId ? -1 : 1;
    });

  const best = eligible[0];
  if (!best) return { open: false, reason: "no_candidate" };

  return {
    open: true,
    entityId: best.entityId,
    entityName: best.entityName,
    eventType: best.eventType,
    daysAgo: daysBetween(best.occurredAt, input.now),
  };
}

/** "yesterday" / "two days ago" — from the number, never from a guess. */
function whenWord(daysAgo: number): string {
  if (daysAgo === 1) return "yesterday";
  if (daysAgo === 2) return "the day before yesterday";
  return `${daysAgo} days ago`;
}

/**
 * The sentence, built from the decision and nothing else.
 *
 * It asks; it never asserts anything beyond the event the person reported,
 * and it carries no time of day, no mood, no pattern and no statistic. A
 * greeting with nothing behind it — "Good morning, how are you?" — is not
 * reachable from here: without an eligible event there is no decision to
 * render.
 */
export function renderOpening(
  decision: Extract<OpeningDecision, { open: true }>,
): string {
  const when = whenWord(decision.daysAgo);
  return decision.eventType === "call"
    ? `How was your call with ${decision.entityName} ${when}?`
    : `How did the visit with ${decision.entityName} go ${when}?`;
}
