import "server-only";
import OpenAI from "openai";
import { extractionModel } from "@/server/config";
import { errorName, hashText, logProviderCall } from "./log";
import type { ExtractionProvider, ExtractionRequest, ExtractionResponse } from "./types";

/**
 * The extraction chokepoint. Strict structured output, not tool calling:
 * extraction is a transformation, not an action, and framing it as an action
 * invites the model toward agency we have explicitly denied it (docs/05 14.2).
 */
export function createOpenAiExtraction(): ExtractionProvider {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("Missing required environment variable OPENAI_API_KEY.");
  const client = new OpenAI({ apiKey });

  return {
    async extract(request: ExtractionRequest): Promise<ExtractionResponse> {
      const model = extractionModel();
      const startedAt = Date.now();
      const inputHash = hashText(request.promptRef + "|" + request.user);

      try {
        const completion = await client.chat.completions.create({
          model,
          messages: [
            { role: "system", content: request.system },
            { role: "user", content: request.user },
          ],
          response_format: {
            type: "json_schema",
            json_schema: {
              name: request.schemaName,
              strict: true,
              schema: request.jsonSchema as Record<string, unknown>,
            },
          },
        });

        const content = completion.choices[0]?.message?.content ?? "";
        let raw: unknown;
        try {
          raw = JSON.parse(content);
        } catch {
          logProviderCall({
            event: "llm.extract",
            outcome: "unparseable_json",
            promptRef: request.promptRef,
            model,
            inputHash,
            latencyMs: Date.now() - startedAt,
          });
          throw new Error("Extraction response was not valid JSON");
        }

        logProviderCall({
          event: "llm.extract",
          outcome: "ok",
          promptRef: request.promptRef,
          model,
          inputHash,
          latencyMs: Date.now() - startedAt,
          usage: completion.usage
            ? {
                prompt: completion.usage.prompt_tokens,
                completion: completion.usage.completion_tokens,
                total: completion.usage.total_tokens,
              }
            : undefined,
        });

        return { raw, model };
      } catch (error) {
        logProviderCall({
          event: "llm.extract",
          outcome: "request_failed",
          promptRef: request.promptRef,
          model,
          inputHash,
          latencyMs: Date.now() - startedAt,
          errorName: errorName(error),
        });
        throw error;
      }
    },
  };
}
