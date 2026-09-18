import "server-only";
import { renderFamilyEmail } from "@/core/family/email";
import type { Notifier, NotifierDelivery, NotifierMessage } from "@/server/adapters/notifier";

/**
 * Family delivery by email, through Brevo's transactional API.
 *
 * It satisfies the existing Notifier port unchanged, which is the point: the
 * port already carries exactly what a transport needs - a recipient, a body
 * and a link - and nothing it should not. There is no parameter for a
 * transcript, a payload or a reason, so this adapter cannot hand Brevo the
 * older adult's conversation even by mistake.
 *
 * WHAT "DELIVERED" MEANS HERE. A 201 from Brevo means the PROVIDER ACCEPTED
 * the email. It does not mean it was sent, arrived, escaped a spam filter or
 * was read. CareLoop's `delivered` status has always meant "handed to the
 * transport", and this adapter does not change that; open and click webhooks
 * would be a different milestone and a different claim.
 *
 * TRACKING IS DECLINED PER RECIPIENT. Every send carries
 * `contactPixelTrackingConsent: false`, which tells Brevo this recipient
 * declined tracking; Brevo then measures neither opens nor clicks for the
 * email. That matters because click tracking rewrites links into
 * individualized redirects - with it on, the Reply href would stop being our
 * capability URL and become a Brevo URL resolving to it, putting a live family
 * token through their redirector and into their click logs.
 *
 * The field is honoured only when per-contact tracking consent is enabled on
 * the Brevo account (Settings > Contacts > Per-contact pixel tracking consent,
 * with unknown contacts set to No). That account setting is a documented
 * precondition; this field is sent anyway rather than relying on the default,
 * because a default is something somebody can change without reading this
 * file. What the delivered email actually contains is checked at live
 * acceptance by inspecting the Reply link - no code can assert what a provider
 * does with what it was told.
 */
const BREVO_ENDPOINT = "https://api.brevo.com/v3/smtp/email";

/** How long we wait before deciding the provider is not answering. */
const TIMEOUT_MS = 10_000;

export class FamilyEmailNotConfiguredError extends Error {
  readonly name = "FamilyEmailNotConfiguredError";
  constructor(variable: string) {
    // The NAME of the missing variable, never any value.
    super(`${variable} is required for family email delivery. See .env.example.`);
  }
}

/**
 * A transport failure, with the provider's own words removed.
 *
 * A provider that echoes the request back - and they do - would otherwise put
 * the recipient's address, the capability URL and the approved message into an
 * exception that CareLoop stores as a delivery error. So the message carries a
 * status and nothing else, and the caller's structured log stays content-free.
 */
export class FamilyEmailTransportError extends Error {
  readonly name = "FamilyEmailTransportError";
  constructor(readonly detail: string) {
    super(`family email transport failed (${detail})`);
  }
}

type BrevoEnv = {
  BREVO_API_KEY?: string;
  BREVO_SENDER_EMAIL?: string;
  BREVO_SENDER_NAME?: string;
};

function required(env: BrevoEnv, key: keyof BrevoEnv): string {
  const value = env[key]?.trim();
  if (!value) throw new FamilyEmailNotConfiguredError(key);
  return value;
}

export function createBrevoEmailNotifier(env: BrevoEnv = process.env): Notifier {
  // Read at construction, so a misconfigured deployment fails where the
  // notifier is composed rather than half-way through a send.
  const apiKey = required(env, "BREVO_API_KEY");
  const senderEmail = required(env, "BREVO_SENDER_EMAIL");
  const senderName = required(env, "BREVO_SENDER_NAME");

  return {
    async send(message: NotifierMessage): Promise<NotifierDelivery> {
      const email = renderFamilyEmail({
        // EXACTLY the approved bytes. The renderer is pure and escapes for
        // HTML; it does not touch the text.
        body: message.body,
        responseUrl: message.responseUrl,
        // The SENDER. This read `recipientDisplayName` and put the recipient's
        // own name in the From line - John received "A message from John".
        fromDisplayName: message.senderDisplayName,
      });

      const response = await post(apiKey, {
        sender: { email: senderEmail, name: senderName },
        // Exactly one recipient: the configured contact, nobody copied.
        to: [
          {
            email: message.address,
            name: message.recipientDisplayName ?? undefined,
            /**
             * TRACKING DECLINED, ALWAYS. Not caller-controlled: the Notifier
             * port has no tracking field and this adapter takes no options, so
             * there is no path to `true`.
             *
             * `false` tells Brevo the recipient declined pixel tracking, and
             * Brevo then tracks neither opens NOR clicks for this email. The
             * clicks half is why it is here: click tracking works by rewriting
             * links into individualized redirects, which would turn the Reply
             * href from our capability URL into a Brevo URL that resolves to
             * it - putting a live family token through their redirector and
             * into their click logs.
             *
             * It is sent explicitly rather than left to the account's
             * unknown-contact default, because a default is a setting somebody
             * can change without reading this file.
             *
             * Honoured only when per-contact tracking consent is enabled on
             * the Brevo account (Settings > Contacts), so the account setting
             * is a documented precondition and this field is the belt to its
             * braces. What the delivered email actually contains is verified
             * at live acceptance by inspecting the Reply link; code cannot
             * assert what a provider does with what it was told.
             */
            contactPixelTrackingConsent: false,
          },
        ],
        subject: email.subject,
        htmlContent: email.htmlContent,
        textContent: email.textContent,
        headers: {
          /**
           * OUR id, never a fresh one. `family_requests.id` is already
           * CareLoop's stable transport idempotency key, so a retry of the
           * same obligation presents the same key by construction.
           *
           * Brevo's TTL for it is 30 MINUTES. Inside that window a repeat is
           * refused rather than re-sent; outside it, the key is forgotten and
           * a retry would send a second email. So this is not exactly-once
           * delivery and is not claimed as any. What is durable is CareLoop's
           * own invariant: one family_request, one set of approved bytes, and
           * retries against that request - the person is never asked to
           * approve anything twice.
           */
          idempotencyKey: message.requestId,
        },
      });

      if (response.ok) {
        const body = (await response.json().catch(() => ({}))) as { messageId?: string };
        return {
          channel: "email",
          reference: body.messageId ?? `brevo:${message.requestId}`,
          deliveredAt: new Date().toISOString(),
        };
      }

      // A duplicate is an ACCEPTANCE, not a failure. The key is our own
      // request id, so `duplicate_parameter` can only mean an earlier attempt
      // of this same obligation was already accepted - which is what a retry
      // after a timeout looks like from here. Calling it a failure would mark
      // a delivered message undelivered and retry it forever.
      const problem = await readProblem(response);
      if (problem.code === "duplicate_parameter") {
        return {
          channel: "email",
          reference: `brevo:duplicate:${message.requestId}`,
          deliveredAt: new Date().toISOString(),
        };
      }

      // Status and provider CODE only. The provider's prose can contain the
      // payload it was sent.
      throw new FamilyEmailTransportError(
        problem.code ? `${response.status} ${problem.code}` : String(response.status),
      );
    },
  };
}

async function post(apiKey: string, payload: unknown): Promise<Response> {
  try {
    return await fetch(BREVO_ENDPOINT, {
      method: "POST",
      headers: {
        "api-key": apiKey,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    // A fetch rejection can carry the request URL and, in some runtimes, the
    // body. Only the error's NAME crosses this boundary.
    throw new FamilyEmailTransportError(error instanceof Error ? error.name : "network_error");
  }
}

/** The provider's machine-readable code, and nothing else it said. */
async function readProblem(response: Response): Promise<{ code?: string }> {
  try {
    const body = (await response.json()) as { code?: unknown };
    return typeof body.code === "string" ? { code: body.code } : {};
  } catch {
    return {};
  }
}
