import "server-only";
import OpenAI from "openai";
import { embeddingModel } from "@/server/config";
import { errorName, hashText, logProviderCall } from "./log";
import type { EmbeddingProvider } from "./types";

/**
 * The embedding chokepoint. One caller, one destination column:
 * episodes.embedding. Vectors never touch entities, relationships or facts -
 * those are answered by relational lookups (D5/R2).
 *
 * The vector itself is never logged; only the hash of its input text.
 */
export function createOpenAiEmbeddings(): EmbeddingProvider {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("Missing required environment variable OPENAI_API_KEY.");
  const client = new OpenAI({ apiKey });

  return {
    async embed(texts: readonly string[]): Promise<number[][]> {
      if (texts.length === 0) return [];
      const model = embeddingModel();
      const startedAt = Date.now();
      const inputHash = hashText(texts.join("|"));

      try {
        const response = await client.embeddings.create({ model, input: [...texts] });
        logProviderCall({
          event: "llm.embed",
          outcome: "ok",
          model,
          inputHash,
          inputCount: texts.length,
          latencyMs: Date.now() - startedAt,
        });
        return response.data.map((item) => item.embedding);
      } catch (error) {
        logProviderCall({
          event: "llm.embed",
          outcome: "request_failed",
          model,
          inputHash,
          inputCount: texts.length,
          latencyMs: Date.now() - startedAt,
          errorName: errorName(error),
        });
        throw error;
      }
    },
  };
}
