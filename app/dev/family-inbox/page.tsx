import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { authorizeDevSeed, isDebugSurfaceEnabled, isLocalOperatorHost } from "@/server/config";
import { readNotifierInbox } from "@/server/services/dev-tools";
import { QuotedText } from "@/app/_components/ui";

export const dynamic = "force-dynamic";

/**
 * The family inbox. DEVELOPMENT ONLY. A demo prop, not a product surface.
 *
 * It stands where a phone would. The reconnect loop has two ends and only one
 * of them is CareLoop: George approves a sentence, it is delivered, and
 * somebody reads it and replies. Showing that second end from a terminal makes
 * a closed loop look like plumbing, so this page shows it as an inbox instead.
 *
 * WHY IT IS A SERVER COMPONENT, AND WHAT THE GATE ACTUALLY PROVES.
 *
 * This page renders a plaintext capability URL - the one thing the rest of the
 * system works to keep out of logs, out of `/debug` and out of every response
 * body. That is the point of it: the link is what a family member clicks. So
 * the boundary has to be real rather than decorative, and described honestly.
 *
 * Five conditions, all evaluated HERE, on the server:
 *
 *   1. local development
 *   2. not a deployment
 *   3. the demo secret is CONFIGURED
 *   4. ...which the gate below re-checks by supplying it to itself
 *   5. the request arrived on a loopback host
 *
 * Note what 3 and 4 are NOT. A browser navigating to a page cannot present a
 * header, so this page is development-gated, not caller-authenticated: it
 * proves the secret exists, never that whoever opened the page knows it. The
 * way to make that claim true would be to put the secret in a URL, which is
 * worse than the problem. The API route next door is header-authenticated and
 * stays that way; this one is not, and saying otherwise would be inventing a
 * security property.
 *
 * Condition 5 is what keeps the LAN URL `next dev` prints from reaching this.
 * The Host header is client-supplied and forgeable, so it removes the casual
 * path and nothing more. The weight is carried by 1 and 2: there is nowhere
 * this page could be deployed where it renders at all.
 *
 * There is no client component, so nothing on this route is bundled, and no
 * fetch, so there is no header for a browser to fail to send. Every failure is
 * the same 404 - not a refusal, which would confirm the page exists, and not a
 * reason, which would tell a prober which condition they had satisfied.
 *
 * It reads the development notifier's outbox, which is the only place a
 * plaintext token still exists on this side. It does NOT query the database:
 * a second delivery record would be a second source of truth, and the two
 * would disagree the first time one of them was wrong.
 */
export default async function FamilyInboxPage() {
  if (!isDebugSurfaceEnabled(process.env)) notFound();
  // Supplying the configured secret to itself: this asserts that one is set,
  // which is the environment condition. It is not a caller check - see above.
  const auth = authorizeDevSeed(process.env, process.env.CARELOOP_DEV_SEED_SECRET ?? null);
  if (!auth.allowed) notFound();

  const requestHeaders = await headers();
  const local = isLocalOperatorHost({
    host: requestHeaders.get("host"),
    forwardedHost: requestHeaders.get("x-forwarded-host"),
  });
  if (!local) notFound();

  const messages = readNotifierInbox();

  return (
    <main className="mx-auto w-full max-w-md px-4 py-8 sm:px-6">
      <header className="pb-5">
        <h1 className="text-[1.45rem] font-semibold tracking-tight">Family inbox</h1>
        <p className="text-[0.95rem] text-[var(--color-muted)]">
          Demo only — this stands in for a text message.
        </p>
      </header>

      {messages.length === 0 ? (
        <p className="text-[1rem] text-[var(--color-muted)]">No family messages yet.</p>
      ) : (
        <ol className="space-y-4">
          {messages.map((message) => (
            <li
              key={message.requestId}
              className="rounded-2xl border-2 border-[var(--color-line)] bg-[var(--color-surface)] p-4"
            >
              <h2 className="text-[1rem] font-semibold">
                Message for {message.recipientDisplayName ?? message.address}
              </h2>

              {/*
                The approved bytes, straight from the notifier entry. Not
                re-rendered, not re-wrapped, not passed through a model - the
                same component the family page uses, so what is shown here and
                what is shown there cannot drift apart.
              */}
              <div className="mt-3">
                <QuotedText>{message.body}</QuotedText>
              </div>

              {/*
                The capability URL exactly as the notifier recorded it. Not
                rebuilt from a token, not re-minted, not looked up: this page
                has no way to produce a token of its own, which is what keeps
                it a viewer rather than a second issuer.
              */}
              <a
                href={message.responseUrl}
                className="mt-4 inline-flex min-h-[2.75rem] items-center justify-center rounded-xl bg-[var(--color-accent)] px-5 text-[0.95rem] font-medium text-white hover:bg-[#35594a]"
              >
                Open reply
              </a>
            </li>
          ))}
        </ol>
      )}
    </main>
  );
}
