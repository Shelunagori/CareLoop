/**
 * M1 conversation-loop configuration. Named constants rather than literals
 * scattered through call sites, so bounds are reviewable in one place.
 */
export const chatConfig = {
  /** Rejected above this length by the API's zod schema (characters). */
  maxMessageLength: 2_000,
  /**
   * How many recent messages go to the model. Context must stay bounded
   * regardless of how long a conversation gets (docs/01 §2.1) — a companion
   * that grows slower and vaguer the longer someone uses it is the opposite
   * of the product thesis.
   */
  recentTurnLimit: 20,
} as const;

/**
 * Fast conversational model — latency and warmth. Env-driven so it can change
 * without a deploy.
 */
export function chatModel(): string {
  return process.env.OPENAI_CHAT_MODEL ?? "gpt-4o-mini";
}

/**
 * Extraction model — accuracy and structure, off the critical path. Separate
 * from the chat model on purpose: the two have opposite requirements, and one
 * model tuned for both is worse at both (docs/05 §14.1).
 */
export function extractionModel(): string {
  return process.env.OPENAI_EXTRACTION_MODEL ?? "gpt-4o";
}

/**
 * Family-message renderer. Separately configurable on purpose: it is a
 * different job with different requirements from conversation (one short
 * sentence, no history, maximum conservatism), and being able to pin or
 * downgrade it without touching the companion's voice is the point of the
 * split. Falls back to the chat model so a missing variable is not an outage —
 * the CALL SITE, prompt id and logging stay distinct either way (docs/05 s14.1).
 */
export function familyRenderModel(): string {
  return process.env.OPENAI_FAMILY_RENDER_MODEL ?? chatModel();
}

export function embeddingModel(): string {
  return process.env.OPENAI_EMBEDDING_MODEL ?? "text-embedding-3-small";
}

/** M2 memory retrieval. Every bound here exists to keep context flat over time. */
export const memoryConfig = {
  /** Episodes retrieved by vector similarity for one turn. */
  episodeTopK: 4,
  /** Entity cards injected per turn. */
  entityCardLimit: 5,
  /** Facts about the user in the profile card. */
  profileFactLimit: 8,
  /** Entities considered "recently active" without being mentioned. */
  recentEntityDays: 7,
  /** Minimum cosine similarity for an episode to be worth injecting. */
  episodeMinSimilarity: 0.2,
} as const;

/** M2 ingestion. */
export const ingestionConfig = {
  /** Pending jobs a single request will opportunistically drain. */
  drainLimit: 2,
  /** How long a claimed job is leased before another attempt may take it. */
  leaseSeconds: 90,
  /** Backoff applied after a failed attempt. */
  retryBackoffSeconds: 30,
  /** Attempts after which a job stops being retried automatically. */
  maxAttempts: 5,
  /** Episode candidates accepted per ingested turn. */
  maxEpisodesPerTurn: 2,
  /** Claims below this extraction confidence are discarded outright. */
  minClaimConfidence: 0.35,
} as const;


/**
 * Whether the M3 derivation inspector is available.
 *
 * An ALLOW-LIST, and fail-closed, for the same reason the development user
 * fallback is (server/auth/resolve-user.ts): a deny-list on "production"
 * quietly opens on any unexpected NODE_ENV, including undefined. The debug
 * surface reads one person's entire social history in raw form, so it must be
 * absent - not merely guarded - anywhere that is not local development.
 */
export type DebugEnv = { NODE_ENV?: string; VERCEL?: string };

export function isDebugSurfaceEnabled(env: DebugEnv): boolean {
  if (env.NODE_ENV !== "development") return false;
  // Never on a deployment, even if NODE_ENV were tampered with.
  if (env.VERCEL) return false;
  return true;
}

/**
 * Authorization for the development-only M3 seeding route.
 *
 * Four conditions, all required, evaluated as an allow-list so any unexpected
 * environment fails closed: local development, not a deployment, a secret
 * actually configured, and the supplied secret matching it. A configured-but-
 * empty secret is treated as absent - otherwise a blank env var would open the
 * route to anyone who sends a blank header.
 */
export type DevSeedAuth =
  | { allowed: true }
  | { allowed: false; reason: "not_development" | "deployed" | "secret_not_configured" | "secret_mismatch" };

export function authorizeDevSeed(
  env: DebugEnv & { CARELOOP_DEV_SEED_SECRET?: string },
  suppliedSecret: string | null,
): DevSeedAuth {
  if (env.NODE_ENV !== "development") return { allowed: false, reason: "not_development" };
  if (env.VERCEL) return { allowed: false, reason: "deployed" };

  const configured = env.CARELOOP_DEV_SEED_SECRET;
  if (!configured) return { allowed: false, reason: "secret_not_configured" };
  if (suppliedSecret !== configured) return { allowed: false, reason: "secret_mismatch" };

  return { allowed: true };
}


/**
 * M4 detection. Every number here is a BOUND: a sweep runs on an ordinary
 * request, so it must cost a predictable amount no matter how much history an
 * account has accumulated. Nothing full-scans.
 */
export const detectionSweepConfig = {
  /** ACTIVE baseline series examined for a cadence gap in one sweep. */
  maxSeriesPerSweep: 10,
  /** Absence assertions examined in one sweep. */
  maxAbsenceEventsPerSweep: 10,
  /** How far back a not-yet-detected absence assertion stays eligible. */
  absenceLookbackDays: 14,
  /** Window used to recognise a detection this system already made. */
  signalHistoryLookbackDays: 180,
  signalHistoryLimit: 200,
  /** Window used to assemble the suppression snapshot. */
  opportunityHistoryLookbackDays: 180,
  opportunityHistoryLimit: 100,
  openOpportunityLimit: 20,
  /** New signals persisted per sweep. */
  maxSignalsPerSweep: 3,
  /**
   * Renders per sweep. One, so a single request can never turn into a burst of
   * model calls, and so the cost of a sweep has a hard ceiling.
   */
  maxDraftsPerSweep: 1,
  /** Confirmed related entities that may be mentioned outbound. */
  maxRelatedEntities: 1,
} as const;
