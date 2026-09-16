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
