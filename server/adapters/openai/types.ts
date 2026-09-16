/**
 * The LLM port. Pure types — no SDK import, no secrets — so services and their
 * tests can depend on this without pulling in a network client.
 *
 * docs/01 §1.3 sketches `LlmProvider { complete, extract }`. M1 implements the
 * streaming conversational capability only; `extract()` arrives in M2 with the
 * post-turn ingestion job.
 */
export type LlmRole = "system" | "user" | "assistant";

export type LlmMessage = {
  role: LlmRole;
  content: string;
};

export type LlmChatRequest = {
  /** Versioned prompt identifier, logged on every call. */
  promptRef: string;
  messages: LlmMessage[];
};

export interface LlmProvider {
  /**
   * Resolves once the provider has accepted the request and the response has
   * begun — so an auth, quota, or connectivity failure rejects HERE, before
   * the caller has started writing an HTTP body. Mid-stream failures surface
   * as an error thrown by the returned iterable.
   */
  streamChat(request: LlmChatRequest): Promise<AsyncIterable<string>>;
}
