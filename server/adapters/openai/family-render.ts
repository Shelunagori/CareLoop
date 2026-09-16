import "server-only";
import OpenAI from "openai";
import { familyRenderModel } from "@/server/config";
import { serializeSharePayload } from "@/core/share/payload";
import { buildFamilyRenderMessages } from "@/server/prompts/family-render.v1";
import { errorName, hashText, logProviderCall } from "./log";
import type {
  FamilyRenderProvider,
  FamilyRenderRequest,
  FamilyRenderResponse,
} from "./types";

/**
 * The isolated family renderer (docs/05 section 14.1, call #3).
 *
 * Its own model setting, its own prompt version, its own log event — and its
 * own construction of the request, which is the part that matters: the ONLY
 * thing that reaches the provider is the system prompt plus the serialized
 * SharePayload. There is no conversation, no memory retrieval, no tools, and
 * no streaming; this is not the companion's voice.
 *
 * One attempt. No repair pass, no second sample. A failure here is not an
 * outage — the caller falls back to a deterministic template built from the
 * same payload, and the reconnect loop continues.
 */
function apiKey(): string {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("Missing required environment variable OPENAI_API_KEY.");
  return key;
}

export function createOpenAiFamilyRender(): FamilyRenderProvider {
  const client = new OpenAI({ apiKey: apiKey() });

  return {
    async render(request: FamilyRenderRequest): Promise<FamilyRenderResponse> {
      const model = familyRenderModel();
      const startedAt = Date.now();
      const messages = buildFamilyRenderMessages(request.payload);
      const base = {
        event: "llm.family_render" as const,
        promptRef: request.promptRef,
        model,
        // Identifies the payload without recording it. The payload is small
        // and user-derived; it is not log material.
        inputHash: hashText(serializeSharePayload(request.payload)),
      };

      try {
        const completion = await client.chat.completions.create({
          model,
          messages,
          stream: false,
        });
        const text = completion.choices[0]?.message?.content ?? "";
        logProviderCall({
          ...base,
          outcome: text.trim().length > 0 ? "ok" : "empty",
          latencyMs: Date.now() - startedAt,
          outputChars: text.length,
          usage: completion.usage
            ? {
                prompt: completion.usage.prompt_tokens,
                completion: completion.usage.completion_tokens,
                total: completion.usage.total_tokens,
              }
            : undefined,
        });
        return { text, model: completion.model ?? model };
      } catch (error) {
        logProviderCall({
          ...base,
          outcome: "request_failed",
          latencyMs: Date.now() - startedAt,
          errorName: errorName(error),
        });
        throw error;
      }
    },
  };
}
