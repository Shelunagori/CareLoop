import "server-only";
import { cloudflareTranscriptionConfig } from "@/server/config";
import { describeProviderError, errorName, logProviderCall } from "@/server/adapters/openai/log";
import type { SpeechToTextProvider, TranscribeResponse } from "@/server/adapters/openai/types";

/**
 * Speech to text, through Cloudflare Workers AI.
 *
 * It satisfies the existing `SpeechToTextProvider` port unchanged - bytes and
 * a mime type in, one string out - so the route, the service and every test
 * above this file are untouched. Swapping the provider is a change to one line
 * of the composition root, which is the whole reason the port exists.
 *
 * WHAT THE PROVIDER IS ASKED FOR. Whisper via Workers AI takes the audio as a
 * BASE64 STRING in a JSON body, not as multipart. That is a transport
 * encoding, not a transcode: the WebM/Opus bytes the browser recorded are the
 * exact bytes that arrive, base64 adds no loss, and nothing here re-encodes,
 * resamples or converts a container. The `.webm` filename the OpenAI adapter
 * had to construct is not part of this API at all - there is no filename to
 * get wrong.
 *
 * WHAT IT IS NOT. There is no fallback to OpenAI. A misconfigured deployment
 * fails by name rather than quietly spending the office's OpenAI credits,
 * which is the point of the migration.
 *
 * Nothing about the audio is logged - not the bytes, not a hash, and on a
 * SUCCESSFUL call not even a size. A failure records the upload size because a
 * tiny upload and a real one have to be distinguishable from a log.
 */
const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";

/** Generous for a 60s clip, short enough not to outlive a serverless function. */
const TIMEOUT_MS = 30_000;

/**
 * An upstream failure with the provider's prose removed.
 *
 * Cloudflare echoes an `errors[]` array whose messages can quote the request.
 * Only the status and the machine-readable code cross this boundary; the
 * sanitized message goes to the log, never into the thrown error.
 */
export class CloudflareTranscriptionError extends Error {
  readonly name = "CloudflareTranscriptionError";
  constructor(readonly detail: string) {
    super(`cloudflare transcription failed (${detail})`);
  }
}

/** Cloudflare's envelope. `result.text` is the transcript. */
type CloudflareEnvelope = {
  success?: boolean;
  result?: { text?: unknown } | null;
  errors?: Array<{ code?: unknown; message?: unknown }>;
};

export function createCloudflareTranscription(): SpeechToTextProvider {
  return {
    async transcribe({ audio, mimeType }): Promise<TranscribeResponse> {
      const uploadBytes = audio.byteLength;
      const startedAt = Date.now();

      /**
       * Configuration is read HERE, not in the factory.
       *
       * The composition root is called inside the route handler, outside the
       * service's own try/catch. A factory that threw on a missing variable
       * would escape that catch and answer an unhandled 500, losing the
       * `{ error: "transcription_failed" }` contract exactly when a
       * deployment is misconfigured - the moment it matters most. Thrown from
       * in here, the same named error becomes `provider_failed` and a 502
       * like any other upstream fault, and is logged on the way.
       *
       * The M8 invariant this restores is broader than transcription: no
       * factory in deps.ts may throw for want of a credential.
       */
      let config;
      try {
        config = cloudflareTranscriptionConfig();
      } catch (error) {
        logProviderCall({
          event: "voice.transcribe",
          outcome: "not_configured",
          provider: "cloudflare",
          latencyMs: Date.now() - startedAt,
          errorName: errorName(error),
          // Which variable, from the error's own field. Never a value.
          missingVariable: (error as { variable?: string })?.variable,
          uploadBytes,
        });
        throw error;
      }

      const { model, language } = config;

      /**
       * Provider prose with this deployment's own secrets removed.
       *
       * `sanitizeMessage` in log.ts redacts KEY SHAPES - `sk-...`, `rk-...`,
       * `Bearer ...` - which is everything OpenAI could echo. A Cloudflare
       * token looks like none of those, so a 401 whose message quoted the
       * token back printed it verbatim. Shape-matching is always one provider
       * behind; the configured value is known exactly, so it is redacted by
       * value and the account id with it.
       */
      const scrub = (text: string | undefined) =>
        text
          ?.split(config.apiToken)
          .join("[redacted]")
          .split(config.accountId)
          .join("[account]");

      const fail = (detail: string, upstream?: ReturnType<typeof describeProviderError>) => {
        logProviderCall({
          event: "voice.transcribe",
          outcome: "request_failed",
          provider: "cloudflare",
          model,
          language,
          latencyMs: Date.now() - startedAt,
          errorName: "CloudflareTranscriptionError",
          upstreamStatus: upstream?.status,
          upstreamCode: upstream?.code ?? detail,
          upstreamMessage: scrub(upstream?.message),
          sentMimeType: mimeType,
          uploadBytes,
        });
        return new CloudflareTranscriptionError(detail);
      };

      let response: Response;
      try {
        response = await fetch(`${CLOUDFLARE_API}/accounts/${config.accountId}/ai/run/${model}`, {
          method: "POST",
          headers: {
            // The token lives in this header and nowhere else - not the URL,
            // not the body, not a log line.
            authorization: `Bearer ${config.apiToken}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            // The recorded bytes, base64 for transport. Not a conversion.
            audio: Buffer.from(audio).toString("base64"),
            task: "transcribe",
            language,
          }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (error) {
        // A fetch rejection can carry the request URL, which contains the
        // account id. Only the error's name crosses.
        throw fail(errorName(error));
      }

      const envelope = (await response.json().catch(() => null)) as CloudflareEnvelope | null;

      if (!response.ok || envelope?.success === false) {
        // 429 and a free-tier exhaustion both land here, as does 401/403 and
        // any 5xx: every one becomes the same narrow transport error, which
        // the service turns into `provider_failed` and the route into a
        // generic `transcription_failed`. The distinguishing detail is in the
        // log line above, not in anything the browser receives.
        const first = envelope?.errors?.[0];
        throw fail(
          `status_${response.status}`,
          describeProviderError({
            status: response.status,
            // Cloudflare's codes are numbers; the log field is a string.
            code: first?.code === undefined ? undefined : String(first.code),
            message: first?.message ?? `cloudflare returned HTTP ${response.status}`,
          }),
        );
      }

      const text = typeof envelope?.result?.text === "string" ? envelope.result.text.trim() : null;
      if (text === null) {
        // A 200 whose shape is not what the schema promises. Treated as a
        // provider failure rather than as silence: "no speech" is a real
        // outcome with its own meaning downstream, and guessing it here would
        // tell the person CareLoop did not catch them when in fact the
        // response was malformed.
        throw fail(
          "malformed_response",
          describeProviderError({
            status: response.status,
            message: "cloudflare returned 200 without a string result.text",
          }),
        );
      }

      logProviderCall({
        event: "voice.transcribe",
        outcome: "ok",
        provider: "cloudflare",
        model,
        language,
        latencyMs: Date.now() - startedAt,
        // Length only. The transcript is the person's own speech and has no
        // business in a log line.
        transcriptLength: text.length,
      });

      return { text, model };
    },
  };
}
