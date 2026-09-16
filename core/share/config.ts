/** Outbound minimization tunables (docs/04 section 11.4). */
export const shareConfig = {
  /**
   * Used when the user has set no family-facing label, or set one the guard
   * would refuse. Neutral by design: the outbound message must never be the
   * place a strange label first has consequences.
   */
  defaultFromDisplayName: "Your family",
  /** A label longer than this is not a name; it is a sentence smuggled in. */
  maxLabelLength: 40,
  /** SharePayload carries at most one third party. */
  maxAlsoMention: 1,
} as const;
