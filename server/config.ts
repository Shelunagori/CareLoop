/**
 * M1 conversation-loop configuration. Named constants rather than literals
 * scattered through call sites, so bounds are reviewable in one place.
 */
export const chatConfig = {
  /** Bounded scan for the chat page's pending-offer read. */
  pendingOfferScanLimit: 50,
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

/** M8: the transcription model. Pinned separately from chat and extraction. */
export function transcriptionModel(): string {
  return process.env.OPENAI_TRANSCRIPTION_MODEL?.trim() || "gpt-4o-mini-transcribe";
}

/**
 * The language transcription is told to expect (M9 reliability).
 *
 * PINNED, not detected. Automatic detection is a guess made from the audio,
 * and the shortest utterances - "yes", "no", "okay", "thanks" - are exactly
 * the ones it has least to go on. Live acceptance produced a one-word clip
 * transcribed as a Chinese character, which then travelled correctly through
 * the ordinary pipeline and got a correct answer in Chinese: every layer did
 * its job on a premise that was wrong two steps earlier.
 *
 * This is a DEMO/PRODUCT-LOCALE setting for an English POC. It belongs on the
 * profile or the session eventually - the person's language, not the
 * deployment's - and the environment variable is the seam where that change
 * will happen.
 */
export function transcriptionLanguage(): string {
  return process.env.OPENAI_TRANSCRIPTION_LANGUAGE?.trim() || "en";
}

/**
 * Whether text-to-speech is configured at all.
 *
 * Voice output is optional: CareLoop must remain fully usable - typed AND
 * spoken input - when no synthesis credentials exist. The route answers a
 * clean "unavailable" rather than a 500, and the browser hides the speaker.
 */
export type SpeechEnv = { ELEVENLABS_API_KEY?: string; ELEVENLABS_VOICE_ID?: string };

export function isSpeechSynthesisConfigured(env: SpeechEnv = process.env): boolean {
  return Boolean(env.ELEVENLABS_API_KEY?.trim() && env.ELEVENLABS_VOICE_ID?.trim());
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

/**
 * M5 family loop. The base URL is where the capability link points; it must be
 * reachable by the family member, which localhost is not once this is
 * deployed, so it is configuration rather than a derived value.
 */
export function publicBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env.CARELOOP_PUBLIC_BASE_URL ?? "http://localhost:3000";
}

export const familyConfig = {
  /**
   * The POC channel. A real adapter (email, SMS, WhatsApp) slots in behind the
   * same Notifier port without touching anything above it.
   */
  devChannel: "dev",
  respondPath: "/family/respond",
  /** Closures surfaced to the older adult per turn. One is enough. */
  maxClosuresPerTurn: 1,
  /**
   * How many overdue family requests one opportunistic sweep may retire.
   * Bounded because it runs on a request path: a backlog drains over several
   * turns rather than making one turn pay for all of it.
   */
  expirySweepLimit: 20,
} as const;

export function familyRespondUrl(token: string, env: NodeJS.ProcessEnv = process.env): string {
  return `${publicBaseUrl(env)}${familyConfig.respondPath}/${token}`;
}
