import "server-only";
import { createHash } from "node:crypto";

/**
 * Structured, single-line, deliberately content-free observability for every
 * provider call (docs/05 §14.5).
 *
 * Prompts, completions, transcripts, embeddings and API keys never appear
 * here. The input hash is enough to correlate a complaint with a call without
 * retaining what was said.
 */
export type ProviderLog = {
  event:
    | "llm.chat"
    | "llm.extract"
    | "llm.embed"
    | "llm.family_render"
    // M8. Named for what they are rather than "llm.*": neither is a model
    // deciding anything, and a log reader should be able to tell at a glance
    // that no reasoning happened on these lines.
    | "voice.transcribe"
    | "voice.synthesize"
    | "ingest.job";
  outcome: string;
  latencyMs: number;
  model?: string;
  promptRef?: string;
  inputHash?: string;
  [key: string]: unknown;
};

export function logProviderCall(record: ProviderLog): void {
  console.log(JSON.stringify(record));
}

export function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

export function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "UnknownError";
}

/**
 * What a provider actually said, with everything unsafe removed.
 *
 * The failure log used to carry `errorName` alone - "BadRequestError" - which
 * says a request was rejected and nothing about why. That is enough to see
 * that transcription is broken and not enough to fix it, which is how a 502
 * survives three rounds of correct guesses about its cause.
 *
 * So: the status, the provider's machine-readable code and type, its request
 * id (the thing to quote to the provider), and a TRUNCATED, REDACTED message.
 * The message is the only free-text field, and provider prose can echo the
 * request back, so an API key shape is redacted before anything is printed and
 * the whole thing is capped. Prompts, transcripts, audio and auth headers have
 * no path into this at all - they are not passed in.
 */
export type ProviderErrorFacts = {
  status?: number;
  code?: string;
  type?: string;
  requestId?: string;
  message: string;
};

/** How much provider prose is worth keeping in a log line. */
const MAX_MESSAGE = 300;

export function describeProviderError(error: unknown): ProviderErrorFacts {
  const candidate = error as {
    status?: unknown;
    code?: unknown;
    type?: unknown;
    requestID?: unknown;
    request_id?: unknown;
    message?: unknown;
    error?: { code?: unknown; type?: unknown; message?: unknown };
  } | null;

  const text = (value: unknown): string | undefined =>
    typeof value === "string" && value.length > 0 ? value : undefined;

  return {
    status: typeof candidate?.status === "number" ? candidate.status : undefined,
    code: text(candidate?.code) ?? text(candidate?.error?.code),
    type: text(candidate?.type) ?? text(candidate?.error?.type),
    requestId: text(candidate?.requestID) ?? text(candidate?.request_id),
    message: sanitizeMessage(
      text(candidate?.error?.message) ?? text(candidate?.message) ?? errorName(error),
    ),
  };
}

function sanitizeMessage(message: string): string {
  return message
    // Any API-key-shaped token, whoever echoed it back.
    .replace(/\b(sk|rk)-[A-Za-z0-9_-]{8,}/g, "[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_MESSAGE);
}
