import { NoraConfigured } from "./config";

/**
 * Whether Nora may run, as a value (M12).
 *
 * Deterministic, total, and decided from a clock plus configuration. No model
 * is consulted, and no part of this is a judgement: "is the wake word
 * available" is exactly the kind of question that must have one answer the
 * whole system agrees on, because the wrong answer leaves a microphone
 * listener running past the date it was allowed to.
 */
export type NoraUnavailableReason =
  | "expired"
  | "not_configured"
  | "unsupported_browser"
  | "microphone_denied"
  | "initialization_failed";

export type NoraAvailability =
  | { available: true; availableUntil: string }
  | { available: false; reason: NoraUnavailableReason; availableUntil: string };

/**
 * The server's half of the answer: time and configuration.
 *
 * The three browser reasons — unsupported, denied, failed — cannot be decided
 * here and are produced by the client after it has actually tried. That split
 * is the point: the client may only ever make Nora LESS available than the
 * server said, never more.
 *
 * Precedence puts `expired` first. After the cutoff the honest thing to tell
 * a person is that the feature has ended, whatever else is also true; sending
 * them to check a microphone for something that no longer exists would be a
 * small lie with a real cost.
 */
export function evaluateNoraAvailability(input: {
  now: Date;
  availableUntil: string;
  accessKeyPresent: boolean;
  keywordPresent: boolean;
}): NoraAvailability {
  const { availableUntil } = input;
  const deadline = Date.parse(availableUntil);

  // Fail closed. A deployment that cannot say when its access ends does not
  // get to keep a wake-word listener alive on the strength of it.
  if (Number.isNaN(deadline)) {
    return { available: false, reason: "expired", availableUntil };
  }

  // Inclusive: `now <= availableUntil`. Stated here, asserted in the tests,
  // and the only place the comparison is written.
  if (input.now.getTime() > deadline) {
    return { available: false, reason: "expired", availableUntil };
  }

  if (!input.accessKeyPresent || !input.keywordPresent) {
    return { available: false, reason: "not_configured", availableUntil };
  }

  return { available: true, availableUntil };
}

/** Convenience for a caller that already holds a `NoraConfigured`. */
export function evaluateFromConfig(
  now: Date,
  availableUntil: string,
  configured: NoraConfigured,
): NoraAvailability {
  return evaluateNoraAvailability({ now, availableUntil, ...configured });
}
