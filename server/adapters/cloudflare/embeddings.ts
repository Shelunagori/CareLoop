import "server-only";
import { cloudflareEmbeddingModel } from "@/server/config";
import {
  EMBEDDING_STORAGE_DIMENSIONS,
  PROVIDER_EMBEDDING_DIMENSIONS,
  padToStorageDimensions,
} from "@/core/memory/embedding-dimensions";
import { errorName, hashText, logProviderCall } from "@/server/adapters/openai/log";
import type { EmbeddingProvider } from "@/server/adapters/openai/types";
import {
  CLOUDFLARE_TIMEOUT_MS,
  CloudflareProviderError,
  prepareCall,
  readEnvelope,
} from "./client";

/**
 * The embedding chokepoint, on BGE-M3.
 *
 * One port, two callers - the ingestion write path and the retrieval query
 * path - and both pad here. That is deliberate: if padding lived at the call
 * sites, a query vector and a stored vector would be padded identically only
 * for as long as two places kept agreeing about it. Padding at the single
 * source of vectors makes them identical by construction.
 *
 * The vector itself is never logged; only the hash of its input text.
 */
export function createCloudflareEmbeddings(): EmbeddingProvider {
  return {
    async embed(texts: readonly string[]): Promise<number[][]> {
      if (texts.length === 0) return [];

      const startedAt = Date.now();
      const model = cloudflareEmbeddingModel();
      const base = {
        event: "llm.embed" as const,
        provider: "cloudflare" as const,
        model,
        inputHash: hashText(texts.join("|")),
        inputCount: texts.length,
      };
      const fail = (outcome: string, extra: Record<string, unknown> = {}) =>
        logProviderCall({ ...base, outcome, latencyMs: Date.now() - startedAt, ...extra });

      let call: ReturnType<typeof prepareCall>;
      try {
        call = prepareCall(model);
      } catch (error) {
        fail("request_failed", {
          errorName: errorName(error),
          missingVariable: (error as { variable?: string })?.variable,
        });
        throw error;
      }

      let response: Response;
      try {
        response = await fetch(call.endpoint, {
          method: "POST",
          headers: call.headers,
          // BGE takes `text`, where OpenAI took `input`.
          body: JSON.stringify({ text: [...texts] }),
          signal: AbortSignal.timeout(CLOUDFLARE_TIMEOUT_MS),
        });
      } catch (error) {
        fail("request_failed", { errorName: errorName(error) });
        throw new CloudflareProviderError(errorName(error));
      }

      const outcome = await readEnvelope<{ data?: unknown }>(call, response);
      if ("failure" in outcome) {
        fail("request_failed", { errorName: "CloudflareProviderError", ...outcome.failure });
        throw new CloudflareProviderError(outcome.failure.detail);
      }

      const data = outcome.result.data;
      if (!Array.isArray(data) || data.length !== texts.length) {
        // A short batch would silently mis-pair vectors with their episodes,
        // which is worse than no embedding at all: every later similarity
        // search would quietly return the wrong memories.
        fail("malformed_response", { returnedCount: Array.isArray(data) ? data.length : null });
        throw new CloudflareProviderError("malformed_response");
      }

      /**
       * 1024 in, 1536 out. `padToStorageDimensions` throws on any other width,
       * which is what stops a leftover OpenAI vector or a different BGE
       * variant from entering the index, where it would be compared happily
       * and meaninglessly against everything else.
       */
      // Observed, not assumed. The 1024 this code is built around comes from
      // BGE-M3's model card rather than Cloudflare's own docs, so the width
      // the provider actually sends is worth recording on every call.
      const observedDimensions = Array.isArray(data[0]) ? (data[0] as unknown[]).length : null;

      let vectors: number[][];
      try {
        vectors = (data as unknown[]).map((vector) =>
          padToStorageDimensions(vector as number[]),
        );
      } catch (error) {
        fail("wrong_dimensions", {
          errorName: errorName(error),
          expectedDimensions: PROVIDER_EMBEDDING_DIMENSIONS,
          // WHAT THE MODEL ACTUALLY RETURNED. Without it this log says only
          // that the width was wrong, which is the least useful half of the
          // fact: a swap to a 768-wide BGE variant and a leftover 1536-wide
          // OpenAI vector are the same line. A count is not content.
          receivedDimensions: observedDimensions,
          storageDimensions: EMBEDDING_STORAGE_DIMENSIONS,
        });
        throw new CloudflareProviderError("wrong_dimensions");
      }

      fail("ok", {
        providerDimensions: observedDimensions,
        storageDimensions: EMBEDDING_STORAGE_DIMENSIONS,
      });
      return vectors;
    },
  };
}
