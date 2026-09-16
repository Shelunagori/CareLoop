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
  event: "llm.chat" | "llm.extract" | "llm.embed" | "ingest.job";
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
