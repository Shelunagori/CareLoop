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

/**
 * Extraction (M2). A separate port from LlmProvider on purpose: the
 * conversational path must not be able to reach the extraction model, and the
 * conversation service's tests should not have to stub a capability it never
 * calls. docs/01 §1.3 sketches both on one interface; splitting them keeps the
 * hot path's dependencies honest.
 */
export type ExtractionRequest = {
  promptRef: string;
  system: string;
  user: string;
  /** Name of the strict JSON schema the provider must satisfy. */
  schemaName: string;
  jsonSchema: unknown;
};

export type ExtractionResponse = {
  /** Unvalidated provider output. The caller runs it through zod. */
  raw: unknown;
  model: string;
};

export interface ExtractionProvider {
  extract(request: ExtractionRequest): Promise<ExtractionResponse>;
}

/**
 * Embeddings (M2). Used by exactly one caller, for exactly one column:
 * episodes.embedding (D5/R2).
 */
export interface EmbeddingProvider {
  embed(texts: readonly string[]): Promise<number[][]>;
}
