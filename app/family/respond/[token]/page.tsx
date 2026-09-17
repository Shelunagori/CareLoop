import { notFound } from "next/navigation";
import { loadFamilyView } from "@/server/services/family-response";
import { createFamilyResponseDeps } from "@/server/services/deps";
import { QuotedText } from "@/app/_components/ui";

export const dynamic = "force-dynamic";

/**
 * The family surface (docs/04 section 12.4).
 *
 * One message and one reply. Deliberately tiny: the moment this page shows
 * trends, timestamps or wellbeing indicators it becomes surveillance software,
 * and the older adult's side of the product becomes a monitoring device they
 * never consented to. Keeping it to one sentence is a product decision that is
 * also an architectural one - there is NO endpoint that can return the older
 * adult's history to a family member, so the temptation cannot be satisfied
 * later without a deliberate, reviewable change.
 *
 * The URL is the capability. No account, no password, no session.
 */
export default async function FamilyRespondPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ answered?: string; error?: string }>;
}) {
  const { token } = await params;
  const query = await searchParams;
  const view = await loadFamilyView(createFamilyResponseDeps(), token);

  // An unknown token and a wrong token are indistinguishable.
  if (view.outcome === "not_found") notFound();

  if (view.outcome === "expired") {
    return (
      <Shell>
        <h1 className="text-[1.45rem] font-semibold">This reply link has expired.</h1>
        <p className="mt-3 text-[1rem] leading-normal text-[var(--color-muted)]">
          Links stay open for a week. If you would still like to reply, ask them
          to send a new message.
        </p>
      </Shell>
    );
  }

  const answered = query.answered === "1" || view.alreadyAnswered;

  return (
    <Shell>
      <p className="text-[1rem] text-[var(--color-muted)]">
        A message from{" "}
        <span className="font-semibold text-[var(--color-foreground)]">
          {view.fromDisplayName}
        </span>
      </p>

      {/* The approved bytes, exactly as sent. Nothing reformats them. */}
      <div className="mt-4">
        <QuotedText>{view.message}</QuotedText>
      </div>

      {answered ? (
        <p className="mt-6 text-[1rem] leading-normal">
          Thanks — your reply has been sent to {view.fromDisplayName}.
        </p>
      ) : (
        <form
          action={`/api/family/respond/${encodeURIComponent(token)}`}
          method="post"
          className="mt-6"
        >
          {query.error && (
            <p role="alert" className="mb-3 text-[0.95rem] text-[#8a2f2f]">
              Your reply couldn&rsquo;t be saved. Please try again.
            </p>
          )}

          <fieldset className="space-y-2.5">
            <legend className="pb-2.5 text-[1.05rem] font-medium">
              {view.topic === "call" ? "Can you call?" : "Can you visit?"}
            </legend>
            {view.choices.map((choice) => (
              <button
                key={choice.id}
                name="choice"
                value={choice.id}
                type="submit"
                className="block min-h-[2.9rem] w-full rounded-xl border-2 border-[var(--color-line)] bg-[var(--color-surface)] px-4 py-3 text-left text-[1rem] leading-snug hover:border-[var(--color-accent)] hover:bg-[var(--color-accent-soft)]"
              >
                {choice.label}
              </button>
            ))}
          </fieldset>

          <p className="pt-4 text-[0.9rem] leading-normal text-[var(--color-muted)]">
            Your answer is passed on as it is written above. Nothing else is shared.
          </p>
        </form>
      )}
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto w-full max-w-xl px-4 py-8 sm:px-6 sm:py-10">
      <div className="rounded-3xl border border-[var(--color-line)] bg-[var(--color-surface)] p-5 sm:p-6">
        {children}
      </div>
    </main>
  );
}
