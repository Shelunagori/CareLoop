/**
 * Every pacing and lifecycle tunable for detection, in one reviewable place
 * (docs/03 section 10.3, docs/04 section 11.5).
 *
 * The failure mode that kills this product is nagging. The numbers that
 * prevent it therefore belong in a file a non-engineer can read, not inline at
 * eight call sites.
 */
export const detectionConfig: DetectionConfig = {
  /* --- suppression: pacing per entity (docs/03 section 10.3) --- */
  /** Quiet period after ANY offer for that entity. */
  offerCooldownDays: 7,
  /** Quiet period after a decline for that entity. */
  declineCooldownDays: 30,
  /** Two declines inside this window trigger the long quiet period. */
  declineWindowDays: 30,
  declineCountForQuietPeriod: 2,
  /** Length of that long quiet period, measured from the second decline. */
  declineQuietPeriodDays: 90,

  /* --- suppression: cold start --- */
  /**
   * No CADENCE signal until the account holds this much history. Explicit
   * absence assertions are deliberately exempt: suppressing a person's own
   * statement would be the system ignoring the clearest evidence it will ever
   * get (docs/03 section 9).
   */
  newAccountCadenceQuietDays: 14,

  /* --- suppression: global caps --- */
  maxOffersPerConversation: 1,
  maxOffersPerWeek: 3,
  offerWeekDays: 7,

  /* --- opportunity lifecycle (docs/04 section 11.5) --- */
  /**
   * How long a materialized opportunity stays offerable.
   *
   * M4 IMPLEMENTATION DECISION: the frozen docs fix the other two clocks
   * (consent 72h, family token 7d) but never name this one. 24h is chosen
   * because the claim a draft encodes ("no visit recorded for 13 days") ages:
   * a day later it is a different number, and re-offering a stale sentence
   * would have the system assert something it no longer has evidence for.
   * Expiry is terminal by design; the path back is a fresh signal.
   */
  opportunityOfferabilityHours: 24,

  /** Bumped when detector arithmetic changes, so signals stay reproducible. */
  methodVersion: "detection.v1",
};

/**
 * Declared explicitly rather than inferred with `as const`, because
 * suppression takes a config PARAMETER: a threshold change must be testable
 * by passing a different object, not only by editing this file. Literal types
 * would make every override a type error.
 */
export type DetectionConfig = {
  readonly offerCooldownDays: number;
  readonly declineCooldownDays: number;
  readonly declineWindowDays: number;
  readonly declineCountForQuietPeriod: number;
  readonly declineQuietPeriodDays: number;
  readonly newAccountCadenceQuietDays: number;
  readonly maxOffersPerConversation: number;
  readonly maxOffersPerWeek: number;
  readonly offerWeekDays: number;
  readonly opportunityOfferabilityHours: number;
  readonly methodVersion: string;
};
