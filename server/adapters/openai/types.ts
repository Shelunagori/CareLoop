import type { SharePayload } from "@/core/share/payload";

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

/**
 * Family message rendering (M4). A THIRD port, deliberately separate from both
 * LlmProvider and ExtractionProvider.
 *
 * The separation is the privacy guarantee in type form. This interface takes a
 * SharePayload — six whitelisted fields — and nothing else. There is no
 * parameter for messages, history, memory or free text, so the code that
 * builds the outbound prompt cannot reach a transcript even by mistake. A
 * shared `LlmProvider.complete(messages)` would have made "no history in
 * context" a matter of every future call site remembering (docs/04 s11.4).
 */
export type FamilyRenderRequest = {
  promptRef: string;
  payload: SharePayload;
};

export type FamilyRenderResponse = {
  /** Raw provider text. Unguarded — the caller runs the output guard. */
  text: string;
  model: string;
};

export interface FamilyRenderProvider {
  render(request: FamilyRenderRequest): Promise<FamilyRenderResponse>;
}

/**
 * Speech to text (M8). A FOURTH port, and the narrowest one yet.
 *
 * It takes bytes and returns a string. It has no access to the conversation,
 * no memory, no entities and no way to ask a model what the person "meant" -
 * because a transcript is evidence of what was said, and anything that could
 * improve it towards what CareLoop expects to hear would be the voice layer
 * quietly making decisions the text pipeline is supposed to make.
 */
export type TranscribeRequest = {
  audio: Uint8Array;
  /** Base media type, already validated against the allow-list. */
  mimeType: string;
};

export type TranscribeResponse = {
  /** Exactly what the provider returned, trimmed. Never corrected. */
  text: string;
  model: string;
};

export interface SpeechToTextProvider {
  transcribe(request: TranscribeRequest): Promise<TranscribeResponse>;
}

/**
 * Text to speech (M8). The mirror image, and just as narrow.
 *
 * It takes text that has ALREADY been shown to the person and returns audio of
 * it. There is no prompt here, no model choosing phrasing, and no second pass
 * to make a sentence "sound better" - what is heard has to be what is read, or
 * the two channels can disagree about what CareLoop said.
 */
export type SynthesizeRequest = {
  /** User-visible text, verbatim. */
  text: string;
};

export type SynthesizeResponse = {
  audio: Uint8Array;
  mimeType: string;
};

export interface VoiceProvider {
  synthesize(request: SynthesizeRequest): Promise<SynthesizeResponse>;
}

/**
 * The declared failure mode of `VoiceProvider`, and the reason it lives on the
 * PORT rather than inside the ElevenLabs adapter.
 *
 * Text to speech is optional. CareLoop must boot, hold a typed conversation
 * and - given OpenAI credentials - still transcribe speech when no synthesis
 * credentials exist anywhere. So an unconfigured provider is a provider that
 * exists and refuses, not a constructor that throws: an optional dependency
 * that can fail composition is an optional dependency in name only, and the
 * alternative is an environment check scattered through every caller.
 */
export class SpeechUnavailableError extends Error {
  readonly name = "SpeechUnavailableError";
  constructor() {
    super("Speech synthesis is not configured.");
  }
}

/** A provider that exists, satisfies the port, and declines every request. */
export function unavailableVoice(): VoiceProvider {
  return {
    async synthesize(): Promise<SynthesizeResponse> {
      throw new SpeechUnavailableError();
    },
  };
}
