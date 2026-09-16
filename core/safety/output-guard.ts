import type { ClosedReconnectQuestion } from "@/core/detection/proposal";
import { findCausalInference, findDeniedTerm } from "./deny-list";

/**
 * The deterministic output guard (docs/03 section 10.4).
 *
 * Why a guard and not just a good prompt: "never diagnose" as a prompt
 * instruction is a request to a non-deterministic system. As a post-generation
 * check with a template fallback it is a property of the system — it holds at
 * every temperature, on every sample, and under any injection in the user's
 * own speech. There is deliberately NO model-based safety judge here: a
 * probabilistic check on a probabilistic output is not a check.
 *
 * Pure. Text in, verdict out.
 */
export const GUARD_LIMITS = {
  minLength: 20,
  maxLength: 320,
} as const;

export type GuardFailure =
  | { code: "empty" }
  | { code: "too_short"; length: number; min: number }
  | { code: "too_long"; length: number; max: number }
  | { code: "denied_term"; term: string }
  | { code: "causal_inference"; match: string }
  | { code: "question_missing"; question: ClosedReconnectQuestion }
  | { code: "no_question_mark" }
  | { code: "link_or_markup"; match: string }
  | { code: "numeric_claim"; match: string };

export type GuardVerdict =
  | { accepted: true; text: string }
  | { accepted: false; failures: GuardFailure[] };

/**
 * Lexical evidence that the intended question survived rendering.
 *
 * The guard cannot read intent, so it checks for the vocabulary the question
 * cannot be asked without. A renderer that dropped the ask entirely — which is
 * the realistic failure, not a malicious one — has no way past this.
 */
const QUESTION_MARKERS: Record<ClosedReconnectQuestion, RegExp> = {
  ask_if_visiting:
    /\b(visit|visits|visiting|come over|coming over|come round|coming round|come by|coming by|pop in|pop by|pop round|pop over|drop in|drop by|drop round|see him|see her|see them)\b/i,
  ask_if_calling:
    /\b(call|calls|calling|ring|rings|ringing|phone|phones|speak to|chat to|catch up on the phone)\b/i,
};

/** A renderer has no business emitting a link, an address, or markup. */
const LINK_OR_MARKUP = /(https?:\/\/|www\.|\S+@\S+\.\S+|<[a-z/!]|\]\(|\*\*|__|\{\{)/i;

/**
 * Any quantity is a hallucination by construction: the SharePayload carries no
 * numbers at all, so "13 days" can only have been invented — and inventing an
 * elapsed-time claim is precisely the leak the minimization exists to prevent.
 */
const NUMERIC_CLAIM = /\b\d+\s*(day|days|week|weeks|month|months|year|years|time|times)\b/i;

export function checkOutboundText(
  text: string,
  requirements: { question: ClosedReconnectQuestion },
): GuardVerdict {
  const failures: GuardFailure[] = [];
  const trimmed = text.trim();

  if (trimmed.length === 0) {
    return { accepted: false, failures: [{ code: "empty" }] };
  }
  if (trimmed.length < GUARD_LIMITS.minLength) {
    failures.push({ code: "too_short", length: trimmed.length, min: GUARD_LIMITS.minLength });
  }
  if (trimmed.length > GUARD_LIMITS.maxLength) {
    failures.push({ code: "too_long", length: trimmed.length, max: GUARD_LIMITS.maxLength });
  }

  const denied = findDeniedTerm(trimmed);
  if (denied !== null) failures.push({ code: "denied_term", term: denied });

  const causal = findCausalInference(trimmed);
  if (causal !== null) failures.push({ code: "causal_inference", match: causal });

  if (!trimmed.includes("?")) failures.push({ code: "no_question_mark" });
  if (!QUESTION_MARKERS[requirements.question].test(trimmed)) {
    failures.push({ code: "question_missing", question: requirements.question });
  }

  const markup = LINK_OR_MARKUP.exec(trimmed);
  if (markup) failures.push({ code: "link_or_markup", match: markup[0] });

  const numeric = NUMERIC_CLAIM.exec(trimmed);
  if (numeric) failures.push({ code: "numeric_claim", match: numeric[0] });

  if (failures.length > 0) return { accepted: false, failures };
  // The accepted text is the TRIMMED string, and it is what gets hashed and
  // stored. Nothing normalizes it afterwards — see docs/04 section 11.3.
  return { accepted: true, text: trimmed };
}
