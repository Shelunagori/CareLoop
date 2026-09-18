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
  /**
   * WHO IT IS FOR. The family contact - John.
   *
   * Distinct from `senderDisplayName` below, and the distinction is the whole
   * reason both exist. This port used to carry only this one, so the email
   * adapter had nothing else to address the message FROM and used the
   * recipient: every delivered email said "A message from John" to John.
   * Nothing caught it because both names are strings and either one renders
   * into a grammatical sentence.
   */
  recipientDisplayName: string | null;
  /**
   * WHO IT IS FROM. The older adult - Dad.
   *
   * Required rather than nullable: an email that cannot say who it is from has
   * no business being sent, and a default here is how the wrong name gets in
   * again. It comes from the approved SharePayload, the same field the family
   * response page renders, so the email and the page cannot disagree.
   */
  senderDisplayName: string;
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
 * The development notifier's outbox. PROCESS-GLOBAL, EPHEMERAL, DEV ONLY.
 *
 * This was a module-level `const devInbox = new Map()`, and that was wrong in
 * a way nothing caught until the demo was run for real: the delivery said
 * delivered, the capability URL worked when opened by hand, and the inbox page
 * said "No family messages yet."
 *
 * A module-level binding belongs to a MODULE EVALUATION, not to a process.
 * Next 16 with Turbopack builds separate server bundles for a route handler
 * and a server component, so a module reachable from both is instantiated once
 * per bundle - and again on every hot reload. The delivery path wrote Map A,
 * the page read Map B, and nothing anywhere reported an error. Every unit test
 * passed because each one imported the writer and the reader from the same
 * cached module, which is the one arrangement the bug cannot appear in.
 *
 * So the Map hangs off `globalThis` under a registered symbol, and all three
 * entry points resolve it through `devInbox()`. One Map per Node process,
 * shared by every module evaluation in it, unaffected by a reload.
 *
 * WHAT IT IS NOT. Not a delivery record - that is the `family_requests` row,
 * and it is what any question about what was sent should be answered from.
 * Not production architecture: a deployment swaps the Notifier adapter for a
 * real provider and this file is never constructed. Not durable - it dies with
 * the dev server, and it is cleared by the demo reset on purpose.
 *
 * It holds the plaintext capability URL, which nothing else in this system
 * durably holds, for one reason: it is the local stand-in for the external
 * delivery channel, and that URL is exactly what the channel would have
 * carried. It stays in memory, on the operator's own machine, behind a
 * development-only loopback-gated page.
 */
const DEV_INBOX_KEY: unique symbol = Symbol.for("careloop.dev.family-inbox");

type DevInboxHost = { [DEV_INBOX_KEY]?: Map<string, DevInboxEntry> };

/**
 * The one resolver. Every read, write and clear goes through it, so there is
 * no path that can reach a Map other than this process's.
 */
function devInbox(): Map<string, DevInboxEntry> {
  const host = globalThis as unknown as DevInboxHost;
  const existing = host[DEV_INBOX_KEY];
  if (existing) return existing;
  const created = new Map<string, DevInboxEntry>();
  host[DEV_INBOX_KEY] = created;
  return created;
}

export function readDevInbox(): DevInboxEntry[] {
  return [...devInbox().values()].sort((a, b) => b.deliveredAt.localeCompare(a.deliveredAt));
}

export function clearDevInbox(): void {
  devInbox().clear();
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
      devInbox().set(message.requestId, { ...delivery, ...message });

      // The capability URL is NOT printed. It used to be, because copying it
      // out of the terminal was the only way to open the family page; the
      // inbox at /dev/family-inbox replaced that, and a token in scrollback is
      // a token in a screen share, a screenshot and a shell history file. The
      // message body is local development only and is the point of the line.
      console.log(
        `\n[careloop dev notifier] to ${message.recipientDisplayName ?? message.address}\n` +
          `${message.body}\n` +
          `open /dev/family-inbox to reply\n`,
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
