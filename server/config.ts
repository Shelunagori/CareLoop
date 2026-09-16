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
 * Fast conversational model. Env-driven so it can change without a deploy.
 * The stronger extraction model belongs to M2 and is deliberately absent.
 */
export function chatModel(): string {
  return process.env.OPENAI_CHAT_MODEL ?? "gpt-4o-mini";
}
