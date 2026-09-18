import "server-only";
import { cloudflareOutputLimits, cloudflareTextModel, CLOUDFLARE_INPUT_TOKEN_BUDGET } from "@/server/config";
import { boundToBudget } from "@/core/llm/context-budget";
import { errorName, hashText, logProviderCall } from "@/server/adapters/openai/log";
import type { LlmChatRequest, LlmMessage, LlmProvider } from "@/server/adapters/openai/types";
import { CLOUDFLARE_TIMEOUT_MS, CloudflareProviderError, describeCloudflareFailure, prepareCall } from "./client";
import { readSseText } from "./sse";

/**
 * George's voice, on Cloudflare Workers AI.
 *
 * The `LlmProvider` port is unchanged, including the part of its contract that
 * matters most here: `streamChat` resolves only once the provider has ACCEPTED
 * the request. An auth failure, an exhausted quota or a refused model must
 * reject before the route has written a single byte of its HTTP body, because
 * once that body is open the only way to report a failure is to stop
 * mid-sentence. `fetch` gives us exactly that seam - the promise settles on
 * response headers - so the status check below happens before any text is
 * yielded, and mid-stream faults surface as a throw from the iterable.
 *
 * Nothing about what was said is logged. The prompt is hashed so one
 * complaint can be matched to one call; the reply is counted, never recorded.
 */
type CallOutcome = "ok" | "request_failed" | "stream_failed";

function hashMessages(messages: readonly LlmMessage[]): string {
  return hashText(messages.map((m) => `${m.role}:${m.content}`).join("\n"));
}

export function createCloudflareLlm(): LlmProvider {
  return {
    async streamChat(request: LlmChatRequest): Promise<AsyncIterable<string>> {
      const startedAt = Date.now();
      const model = cloudflareTextModel();

      /**
       * The 24k window applies before anything is sent. In practice
       * `chatConfig.recentTurnLimit` and the `memoryConfig` caps have already
       * bounded this; `droppedMessages` is logged so that if the backstop ever
       * does fire, it is visible rather than a silently shorter memory.
       */
      const bounded = boundToBudget(request.messages, CLOUDFLARE_INPUT_TOKEN_BUDGET);

      const base = {
        event: "llm.chat" as const,
        promptRef: request.promptRef,
        provider: "cloudflare" as const,
        model,
        inputHash: hashMessages(bounded.messages),
        messageCount: bounded.messages.length,
        droppedMessages: bounded.droppedMessages,
      };

      const fail = (outcome: CallOutcome, extra: Record<string, unknown>) =>
        logProviderCall({ ...base, outcome, latencyMs: Date.now() - startedAt, ...extra });

      let call: ReturnType<typeof prepareCall>;
      try {
        call = prepareCall(model);
      } catch (error) {
        // A missing credential, named. Thrown from here rather than from the
        // factory so it lands inside the caller's failure handling.
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
            messages: bounded.messages,
            stream: true,
            // Workers AI defaults to 256, which cuts George off mid-sentence.
            max_tokens: cloudflareOutputLimits.chat,
          }),
          signal: AbortSignal.timeout(CLOUDFLARE_TIMEOUT_MS),
        });
      } catch (error) {
        // A rejected fetch can carry the request URL, and the URL carries the
        // account id. Only the error's name crosses.
        fail("request_failed", { errorName: errorName(error) });
        throw new CloudflareProviderError(errorName(error));
      }

      if (!response.ok || response.body === null) {
        // Cloudflare answers a refusal as JSON even when streaming was asked
        // for, so the envelope is readable here.
        const envelope = await response.json().catch(() => null);
        const failure = describeCloudflareFailure(call, response.status, envelope);
        fail("request_failed", { errorName: "CloudflareProviderError", ...failure });
        throw new CloudflareProviderError(failure.detail);
      }

      const stream = response.body;

      return (async function* () {
        let ttftMs: number | undefined;
        let outputChars = 0;

        try {
          for await (const delta of readSseText(stream)) {
            ttftMs ??= Date.now() - startedAt;
            outputChars += delta.length;
            yield delta;
          }
        } catch (error) {
          fail("stream_failed", { ttftMs, outputChars, errorName: errorName(error) });
          throw new CloudflareProviderError(errorName(error));
        }

        logProviderCall({
          ...base,
          outcome: "ok",
          latencyMs: Date.now() - startedAt,
          ttftMs,
          // A length, not a transcript.
          outputChars,
        });
      })();
    },
  };
}
