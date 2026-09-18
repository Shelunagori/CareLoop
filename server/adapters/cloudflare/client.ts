import "server-only";
import { cloudflareCredentials } from "@/server/config";
import { describeProviderError } from "@/server/adapters/openai/log";

/**
 * The parts of a Cloudflare Workers AI call that every adapter needs, in one
 * place: the endpoint, the credential, and the rule that nothing this
 * deployment knows as a secret is ever printed.
 *
 * `openai/log.ts` is imported for `describeProviderError` and `logProviderCall`
 * despite the folder name - both are provider-neutral and always were. Moving
 * them is churn for a later cleanup, not part of this migration.
 */
export const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";

/** Generous for a long generation, short enough not to outlive a function. */
export const CLOUDFLARE_TIMEOUT_MS = 60_000;

/**
 * An upstream Cloudflare failure, with the provider's prose left behind.
 *
 * One error type for every adapter and every status. 400, 401, 403, 429,
 * a 5xx and an unreadable body all arrive as this, which is what lets each
 * service map "the provider did not answer usefully" to its own existing
 * failure outcome without growing a Cloudflare-shaped switch statement.
 */
export class CloudflareProviderError extends Error {
  readonly name = "CloudflareProviderError";
  constructor(readonly detail: string) {
    super(`cloudflare request failed (${detail})`);
  }
}

export type CloudflareCall = {
  /** Model id, which is also the last path segment of the endpoint. */
  model: string;
  endpoint: string;
  headers: Record<string, string>;
  /** Provider prose with this deployment's own secrets removed. */
  scrub: (text: string | undefined) => string | undefined;
};

/**
 * Everything one request needs, or a throw naming the missing variable.
 *
 * Read per call rather than at construction. A factory that threw for want of
 * a credential would throw inside a route handler but outside the service's
 * try/catch, answering an unhandled 500 instead of that service's ordinary
 * provider-failure response - exactly when a deployment is misconfigured.
 */
export function prepareCall(model: string): CloudflareCall {
  const { accountId, apiToken } = cloudflareCredentials();

  return {
    model,
    endpoint: `${CLOUDFLARE_API}/accounts/${accountId}/ai/run/${model}`,
    headers: {
      // The token lives in this header and nowhere else - not the URL, which
      // lands in access logs and proxies, and not the body.
      authorization: `Bearer ${apiToken}`,
      "content-type": "application/json",
    },
    /**
     * `sanitizeMessage` in log.ts redacts KEY SHAPES - `sk-`, `rk-`,
     * `Bearer ` - which covered everything OpenAI could echo back. A
     * Cloudflare token matches none of them, so a 401 quoting the token
     * printed it verbatim. Shape-matching is always one provider behind; the
     * configured value is known exactly, so it is redacted by value.
     */
    scrub: (text) =>
      text?.split(apiToken).join("[redacted]").split(accountId).join("[account]"),
  };
}

/** Cloudflare's envelope. `result` is the model's own output shape. */
export type CloudflareEnvelope<T> = {
  success?: boolean;
  result?: T | null;
  errors?: Array<{ code?: unknown; message?: unknown }>;
  messages?: unknown;
};

export type CloudflareFailure = {
  detail: string;
  upstreamStatus?: number;
  upstreamCode?: string;
  upstreamMessage?: string;
};

/**
 * What went wrong, in fields that are safe to print.
 *
 * The status and Cloudflare's numeric code are the diagnostic pair worth
 * having: 429 + 3036 is an exhausted free allocation, 429 alone is a rate
 * limit, 401 is a bad token. None of it reaches the browser - every caller
 * maps this to its own generic failure - and none of it carries a prompt, a
 * transcript or a credential.
 */
export function describeCloudflareFailure(
  call: CloudflareCall,
  status: number,
  envelope: CloudflareEnvelope<unknown> | null,
): CloudflareFailure {
  const first = envelope?.errors?.[0];
  const facts = describeProviderError({
    status,
    // Cloudflare's codes are numbers; the log field is a string.
    code: first?.code === undefined ? undefined : String(first.code),
    message: first?.message ?? `cloudflare returned HTTP ${status}`,
  });

  return {
    detail: `status_${status}`,
    upstreamStatus: facts.status,
    upstreamCode: facts.code,
    upstreamMessage: call.scrub(facts.message),
  };
}

/**
 * A Cloudflare response, or a throw.
 *
 * Shared so that "not ok, or `success: false`, is a failure" is decided once.
 * Cloudflare can answer HTTP 200 with `success: false`, and an adapter that
 * only checked `response.ok` would read a null result as a valid answer.
 */
export async function readEnvelope<T>(
  call: CloudflareCall,
  response: Response,
): Promise<{ result: T } | { failure: CloudflareFailure }> {
  const envelope = (await response.json().catch(() => null)) as CloudflareEnvelope<T> | null;

  if (!response.ok || envelope?.success === false || envelope?.result == null) {
    return { failure: describeCloudflareFailure(call, response.status, envelope) };
  }
  return { result: envelope.result };
}
