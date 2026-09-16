import "server-only";
import { createHash } from "node:crypto";
import OpenAI from "openai";
import { chatModel } from "@/server/config";
import type { LlmChatRequest, LlmMessage, LlmProvider } from "./types";

/**
 * The single OpenAI chokepoint (docs/01 §1.4, docs/05 §14.5).
 *
 * Every model call in CareLoop goes through here. That is what makes prompt
 * versions, latency and token spend observable in one place, and what keeps
 * the API key off every other code path — including the browser.
 */

type CallOutcome = "ok" | "request_failed" | "stream_failed";

type LlmLogRecord = {
  event: "llm.chat";
  promptRef: string;
  model: string;
  outcome: CallOutcome;
  /** Identifies the input without recording it. */
  inputHash: string;
  messageCount: number;
  latencyMs: number;
  ttftMs?: number;
  outputChars?: number;
  usage?: { prompt: number; completion: number; total: number };
  errorName?: string;
};

/**
 * Structured, single-line, and deliberately content-free: prompt and
 * completion text never reach ordinary logs. The hash is enough to correlate
 * a complaint with a call without retaining what was said.
 */
function logLlmCall(record: LlmLogRecord): void {
  console.log(JSON.stringify(record));
}

function hashMessages(messages: LlmMessage[]): string {
  const canonical = messages.map((m) => `${m.role}:${m.content}`).join("\n");
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

function apiKey(): string {
  const key = process.env.OPENAI_API_KEY;
  if (!key) {
    throw new Error("Missing required environment variable OPENAI_API_KEY.");
  }
  return key;
}

export function createOpenAiLlm(): LlmProvider {
  const client = new OpenAI({ apiKey: apiKey() });

  return {
    async streamChat(request: LlmChatRequest): Promise<AsyncIterable<string>> {
      const model = chatModel();
      const startedAt = Date.now();
      const base = {
        event: "llm.chat" as const,
        promptRef: request.promptRef,
        model,
        inputHash: hashMessages(request.messages),
        messageCount: request.messages.length,
      };

      let stream;
      try {
        stream = await client.chat.completions.create({
          model,
          messages: request.messages,
          stream: true,
          stream_options: { include_usage: true },
        });
      } catch (error) {
        logLlmCall({
          ...base,
          outcome: "request_failed",
          latencyMs: Date.now() - startedAt,
          errorName: error instanceof Error ? error.name : "UnknownError",
        });
        throw error;
      }

      return (async function* () {
        let ttftMs: number | undefined;
        let outputChars = 0;
        let usage: LlmLogRecord["usage"];

        try {
          for await (const chunk of stream) {
            if (chunk.usage) {
              usage = {
                prompt: chunk.usage.prompt_tokens,
                completion: chunk.usage.completion_tokens,
                total: chunk.usage.total_tokens,
              };
            }
            const delta = chunk.choices[0]?.delta?.content;
            if (delta) {
              ttftMs ??= Date.now() - startedAt;
              outputChars += delta.length;
              yield delta;
            }
          }
        } catch (error) {
          logLlmCall({
            ...base,
            outcome: "stream_failed",
            latencyMs: Date.now() - startedAt,
            ttftMs,
            outputChars,
            usage,
            errorName: error instanceof Error ? error.name : "UnknownError",
          });
          throw error;
        }

        logLlmCall({
          ...base,
          outcome: "ok",
          latencyMs: Date.now() - startedAt,
          ttftMs,
          outputChars,
          usage,
        });
      })();
    },
  };
}
