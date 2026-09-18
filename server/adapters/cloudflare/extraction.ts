import "server-only";
import { cloudflareOutputLimits, cloudflareTextModel } from "@/server/config";
import { errorName, hashText, logProviderCall } from "@/server/adapters/openai/log";
import type {
  ExtractionProvider,
  ExtractionRequest,
  ExtractionResponse,
} from "@/server/adapters/openai/types";
import {
  CLOUDFLARE_TIMEOUT_MS,
  CloudflareProviderError,
  prepareCall,
  readEnvelope,
} from "./client";

/**
 * Post-turn extraction, on Cloudflare JSON Mode.
 *
 * ONE GUARANTEE IS LOST HERE, AND IT MATTERS. OpenAI's `strict: true` made
 * schema conformance a promise of the API: the response WAS the schema.
 * Cloudflare's JSON Mode does not promise that - its own documentation says it
 * "can't guarantee that the model responds according to the requested JSON
 * Schema", and it may answer `JSON Mode couldn't be met` outright.
 *
 * CareLoop was already built for this. `ExtractionResponse.raw` is documented
 * as UNVALIDATED provider output and the ingestion service runs it through
 * zod. What changes is the frequency: a path that used to be theoretical is
 * now ordinary. So malformed JSON and unmet schemas both fail loudly as
 * provider errors here, and the caller's existing validation stays exactly
 * where it is. Nothing half-parsed is ever handed upwards - a partially
 * understood claim about someone's life is worse than no claim.
 */
export function createCloudflareExtraction(): ExtractionProvider {
  return {
    async extract(request: ExtractionRequest): Promise<ExtractionResponse> {
      const startedAt = Date.now();
      const model = cloudflareTextModel();
      const inputHash = hashText(request.promptRef + "|" + request.user);

      const base = {
        event: "llm.extract" as const,
        promptRef: request.promptRef,
        provider: "cloudflare" as const,
        model,
        schemaName: request.schemaName,
        inputHash,
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
            messages: [
              { role: "system", content: request.system },
              { role: "user", content: request.user },
            ],
            /**
             * Cloudflare takes the schema DIRECTLY under `json_schema`, where
             * OpenAI wrapped it in `{ name, strict, schema }`. The name is
             * still carried, into the log line, because knowing which schema
             * failed is most of knowing why.
             */
            response_format: { type: "json_schema", json_schema: request.jsonSchema },
            max_tokens: cloudflareOutputLimits.extraction,
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

      /**
       * In JSON Mode the model's output arrives already parsed as an object.
       * It can still arrive as a string - when the schema was not met, or from
       * a model that ignored the format - so both are handled and neither is
       * trusted. Anything unparseable is a failure, never an empty result:
       * silently returning `{}` would let ingestion record that a turn
       * contained nothing worth remembering.
       */
      const payload = outcome.result.response;
      let raw: unknown;
      if (typeof payload === "string") {
        try {
          raw = JSON.parse(payload);
        } catch {
          /**
           * Two different failures arrive as the same unparseable string, and
           * the difference decides what to do about it. Cloudflare's
           * documented refusal - `JSON Mode couldn't be met` - means the model
           * declined the schema, and the fix is the schema or the model.
           * Anything else is broken JSON, and the fix is usually a bigger
           * `max_tokens`, because the commonest cause is an object cut off at
           * the output ceiling. Collapsing them into one outcome would send
           * every future investigation down the wrong path.
           */
          const outcome = /json mode/i.test(payload) ? "schema_not_met" : "unparseable_json";
          fail(outcome);
          throw new CloudflareProviderError(outcome);
        }
      } else {
        raw = payload;
      }

      if (raw === null || typeof raw !== "object") {
        // Valid JSON, wrong kind: a bare string, number or null where an
        // object was asked for.
        fail("schema_not_met");
        throw new CloudflareProviderError("schema_not_met");
      }

      fail("ok");
      return { raw, model };
    },
  };
}
