import { isDebugSurfaceEnabled } from "@/server/config";
import { tokenHashPrefix } from "@/core/family/token";

/**
 * The Notifier port (docs/01 section 1.3).
 *
 * Deliberately narrow: a recipient, a body and a link. There is no parameter
 * for a transcript, a summary or a payload, so the code that delivers a family
 * message cannot reach the older adult's conversation even by mistake - the
 * same structural argument as the family renderer's port in M4.
 *
 * `body` is a byte copy of the approved text. Nothing in this layer generates,
 * edits or re-wraps it.
 */
export type NotifierMessage = {
  requestId: string;
  channel: string;
  address: string;
  recipientDisplayName: string | null;
  /** EXACTLY the approved bytes. */
  body: string;
  /** The capability URL. Contains the plaintext token; never logged. */
  responseUrl: string;
};

export type NotifierDelivery = {
  channel: string;
  /** Provider-side handle, for correlating a complaint with a delivery. */
  reference: string;
  deliveredAt: string;
};

export interface Notifier {
  send(message: NotifierMessage): Promise<NotifierDelivery>;
}

export type DevInboxEntry = NotifierDelivery & {
  requestId: string;
  recipientDisplayName: string | null;
  address: string;
  body: string;
  responseUrl: string;
};

/**
 * In-process inbox for the development notifier.
 *
 * Module-level and therefore per-runtime: on a serverless instance it does not
 * survive a cold start, which is fine because it is a local acceptance aid,
 * not a delivery record. The delivery record is the `family_requests` row.
 */
const devInbox = new Map<string, DevInboxEntry>();

export function readDevInbox(): DevInboxEntry[] {
  return [...devInbox.values()].sort((a, b) => b.deliveredAt.localeCompare(a.deliveredAt));
}

export function clearDevInbox(): void {
  devInbox.clear();
}

export class NotifierUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotifierUnavailableError";
  }
}

/**
 * The development notifier.
 *
 * It refuses to exist outside local development. The whole point of it is to
 * surface a capability URL so a human can click it, and a component whose job
 * is to print a token must not be constructible anywhere that token could
 * reach a log aggregator.
 *
 * Idempotent per request id: a retry after a crash overwrites its own entry
 * rather than appending a second one, which is the POC's answer to
 * at-least-once delivery. A real provider would need an idempotency key; that
 * is noted rather than pretended.
 */
export function createDevNotifier(env: NodeJS.ProcessEnv = process.env): Notifier {
  if (!isDebugSurfaceEnabled(env)) {
    throw new NotifierUnavailableError(
      "The development notifier is available only in local development.",
    );
  }

  return {
    async send(message) {
      const delivery: NotifierDelivery = {
        channel: message.channel,
        reference: `dev-inbox:${message.requestId}`,
        deliveredAt: new Date().toISOString(),
      };
      devInbox.set(message.requestId, { ...delivery, ...message });

      // Local development only, and the URL is the point of the tool. The
      // structured log below is what a deployed notifier would emit.
      console.log(
        `\n[careloop dev notifier] to ${message.recipientDisplayName ?? message.address}\n` +
          `${message.body}\n` +
          `respond: ${message.responseUrl}\n`,
      );
      return delivery;
    },
  };
}

/**
 * Content-free delivery logging. Ids, a channel, a token-hash prefix and a
 * latency - never the plaintext token, never the message, never a transcript.
 */
export function logDelivery(record: {
  requestId: string;
  opportunityId: string;
  channel: string;
  tokenHash: string;
  outcome: "delivered" | "failed";
  latencyMs: number;
  errorName?: string;
}): void {
  console.log(
    JSON.stringify({
      event: "family.delivery",
      requestId: record.requestId,
      opportunityId: record.opportunityId,
      channel: record.channel,
      tokenHashPrefix: tokenHashPrefix(record.tokenHash),
      outcome: record.outcome,
      latencyMs: record.latencyMs,
      errorName: record.errorName,
    }),
  );
}
