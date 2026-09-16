import type { ClosedReconnectQuestion } from "@/core/detection/proposal";
import type { SharePayload } from "./payload";

/**
 * The deterministic fallback (docs/03 section 10.4).
 *
 * Built from the SharePayload and nothing else, so it is available whenever
 * the renderer is not: an API failure, an empty completion, malformed output,
 * or a guard rejection. Never a second model call to "repair" the first —
 * repairing unsafe output with the same class of component that produced it is
 * not a safety mechanism, it is a retry with extra steps.
 *
 * Every template here passes the output guard by construction: the only
 * interpolated values are labels that minimize() has already sanitized.
 */
export function buildFallbackText(payload: SharePayload): string {
  const from = payload.fromDisplayName;

  if (payload.question === "ask_if_calling") {
    return `${from} was wondering — could you give them a call soon?`;
  }

  if (payload.aboutEntityName) {
    return `${from} was wondering — are you and ${payload.aboutEntityName} able to visit soon?`;
  }
  return `${from} was wondering — are you able to visit soon?`;
}

/**
 * Used only if the interpolated fallback itself fails the guard, which
 * sanitization is supposed to make impossible. It interpolates nothing, so it
 * cannot fail for a data reason. Cheap insurance against the one path in the
 * system that has nowhere left to fall back to.
 */
export function lastResortText(question: ClosedReconnectQuestion): string {
  return question === "ask_if_calling"
    ? "A message from your family — could you give them a call soon?"
    : "A message from your family — are you able to visit soon?";
}
