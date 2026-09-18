import "server-only";
import { cloudflareOutputLimits, cloudflareTextModel } from "@/server/config";
import { errorName, hashText, logProviderCall } from "@/server/adapters/openai/log";
import { buildFamilyRenderMessagesV2 } from "@/server/prompts/family-render.v2";
import { serializeSharePayload } from "@/core/share/payload";
import type {
  FamilyRenderProvider,
  FamilyRenderRequest,
  FamilyRenderResponse,
} from "@/server/adapters/openai/types";
import {
  CLOUDFLARE_TIMEOUT_MS,
  CloudflareProviderError,
  prepareCall,
  readEnvelope,
} from "./client";

/**
 * The outbound family message, on Cloudflare.
 *
 * This port stays separate from `LlmProvider` for the reason it always was:
 * it takes a SharePayload - six whitelisted fields - and has no parameter that
 * could carry a transcript, a memory or free text. Changing the provider
 * changes none of that. The payload is hashed for the log and never printed,
 * because it is about a real person's private life and is not log material.
 */
export function createCloudflareFamilyRender(): FamilyRenderProvider {
  return {
    async render(request: FamilyRenderRequest): Promise<FamilyRenderResponse> {
      const startedAt = Date.now();
      const model = cloudflareTextModel();
      const messages = buildFamilyRenderMessagesV2(request.payload);

      const base = {
        event: "llm.family_render" as const,
        promptRef: request.promptRef,
        provider: "cloudflare" as const,
        model,
        inputHash: hashText(serializeSharePayload(request.payload)),
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
          body: JSON.stringify({
            messages,
            stream: false,
            max_tokens: cloudflareOutputLimits.familyRender,
          }),
          signal: AbortSignal.timeout(CLOUDFLARE_TIMEOUT_MS),
        });
      } catch (error) {
        fail("request_failed", { errorName: errorName(error) });
        throw new CloudflareProviderError(errorName(error));
      }

      const outcome = await readEnvelope<{ response?: unknown }>(call, response);
      if ("failure" in outcome) {
        fail("request_failed", { errorName: "CloudflareProviderError", ...outcome.failure });
        throw new CloudflareProviderError(outcome.failure.detail);
      }

      const text = typeof outcome.result.response === "string" ? outcome.result.response : "";
      fail(text.trim().length > 0 ? "ok" : "empty", { outputChars: text.length });

      // Unguarded on purpose: the caller runs the output guard, and this
      // adapter is not allowed to decide what is safe to send to a family
      // member.
      return { text, model };
    },
  };
}
