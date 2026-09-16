import { notFound } from "next/navigation";
import { loadFamilyView } from "@/server/services/family-response";
import { createFamilyResponseDeps } from "@/server/services/deps";

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
        <h1 className="text-2xl font-semibold">This link has expired</h1>
        <p className="mt-4 text-lg text-neutral-700">
          Links stay open for a week. If you would still like to reply, ask them
          to send a new message.
        </p>
      </Shell>
    );
  }

  const answered = query.answered === "1" || view.alreadyAnswered;

  return (
    <Shell>
      <p className="text-lg text-neutral-600">
        A message from <span className="font-semibold">{view.fromDisplayName}</span>
      </p>

      {/* The approved bytes, exactly as sent. Nothing reformats them. */}
      <blockquote className="mt-6 rounded-2xl bg-amber-50 p-6 text-2xl leading-relaxed text-neutral-900">
        {view.message}
      </blockquote>

      {answered ? (
        <p className="mt-8 text-lg text-neutral-700">
          Thank you — we&rsquo;ve passed your reply on to {view.fromDisplayName}.
        </p>
      ) : (
        <form
          action={`/api/family/respond/${encodeURIComponent(token)}`}
          method="post"
          className="mt-8 space-y-3"
        >
          {query.error && (
            <p className="text-base text-red-700">
              Sorry, that didn&rsquo;t go through. Please try again.
            </p>
          )}
          {view.choices.map((choice) => (
            <button
              key={choice.id}
              name="choice"
              value={choice.id}
              type="submit"
              className="block w-full rounded-xl border-2 border-amber-200 px-5 py-4 text-left text-lg text-neutral-900 hover:bg-amber-50"
            >
              {choice.label}
            </button>
          ))}
          <p className="pt-2 text-sm text-neutral-500">
            Your answer is passed on as it is written above. Nothing else is shared.
          </p>
        </form>
      )}
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto max-w-xl px-6 py-16">
      <div className="rounded-3xl border border-neutral-200 bg-white p-8 shadow-sm">
        {children}
      </div>
    </main>
  );
}
