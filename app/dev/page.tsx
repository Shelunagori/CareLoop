import Link from "next/link";
import { notFound } from "next/navigation";
import { resetDemoAction } from "@/app/_actions/demo";
import { DemoResetControl, FamilyInboxLink } from "@/app/_components/dev-operator";
import { operatorAccessAllowed } from "@/server/auth/operator-access";

export const dynamic = "force-dynamic";

/**
 * THE OPERATOR'S SURFACE. DEVELOPMENT ONLY (M12e.3).
 *
 * WHY IT EXISTS. "Reset demo — development only" and "Family inbox (dev)"
 * used to sit in the chat header. Every one of them was correctly gated and
 * none of them reached production, so the code was right and the product
 * was wrong: a reviewer recording the primary conversation surface had
 * scaffolding in shot, and marking a control "(dev)" explains it without
 * removing it. The controls were never product UI; they now live where
 * they belong instead of being labelled as not belonging.
 *
 * THE GATE IS THE SAME FOUR CONDITIONS as `/dev/family-inbox`, deliberately
 * copied rather than loosened: local development, not a deployment, a
 * configured dev secret, and a loopback host. Anything else is a bare 404 —
 * the route does not advertise its own existence, and there is no token, no
 * query parameter and no header a stranger could supply to reach it. This
 * is not a back door; it is the same door, with the controls behind it.
 */
export default async function DevOperatorPage() {
  // The same four conditions as every other operator surface, from one
  // function (M12f). A bare 404 otherwise: the route does not advertise
  // its own existence.
  if (!(await operatorAccessAllowed())) notFound();

  return (
    <main className="mx-auto max-w-2xl space-y-8 px-6 py-10">
      <header className="space-y-2">
        <h1 className="text-[1.7rem] font-semibold tracking-tight">CareLoop operator</h1>
        <p className="text-[var(--color-muted)]">
          Development only. None of this is part of the product, and none of it
          renders on the CareLoop page.
        </p>
      </header>

      <section className="space-y-3">
        <h2 className="text-[1.15rem] font-semibold">Demo data</h2>
        <p className="text-[0.95rem] text-[var(--color-muted)]">
          Deletes the rows this fixture owns and seeds them again through the
          production pipeline. Conversations and messages are left alone.
        </p>
        <DemoResetControl action={resetDemoAction} note="development only" />
      </section>

      <section className="space-y-3">
        <h2 className="text-[1.15rem] font-semibold">The family side</h2>
        <p className="text-[0.95rem] text-[var(--color-muted)]">
          Where an approved message is delivered when CareLoop runs locally —
          the real bytes and the real capability link, with no provider in the
          way.
        </p>
        <FamilyInboxLink />
      </section>

      <section className="space-y-3">
        <h2 className="text-[1.15rem] font-semibold">Inspect</h2>
        <p className="text-[0.95rem] text-[var(--color-muted)]">
          Baselines, signals, opportunities, consent grants and family
          requests, as stored.
        </p>
        <Link
          href="/debug"
          className="inline-flex min-h-[2.75rem] items-center justify-center rounded-xl border-2 border-[var(--color-line)] bg-[var(--color-surface)] px-4 text-[0.95rem] font-medium hover:bg-[var(--color-surface-muted)]"
        >
          Open /debug
        </Link>
      </section>

      <section className="space-y-3">
        <h2 className="text-[1.15rem] font-semibold">Demo opening line</h2>
        <p className="text-[0.95rem] text-[var(--color-muted)]">
          The canonical first turn: &ldquo;I haven&rsquo;t seen John this
          week.&rdquo;
        </p>
      </section>

      <Link href="/" className="inline-block text-[0.95rem] underline">
        Back to CareLoop
      </Link>
    </main>
  );
}
