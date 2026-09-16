import { notFound } from "next/navigation";
import { isDebugSurfaceEnabled } from "@/server/config";
import { getCurrentUserId } from "@/server/auth/current-user";
import { loadBaselineDerivations } from "@/server/services/baseline-debug";
import { createBaselineDebugDeps } from "@/server/services/deps";

export const dynamic = "force-dynamic";

/**
 * M3 derivation inspector. Development only.
 *
 * This shows one person's raw social history, so it is absent rather than
 * merely guarded outside local development: notFound() means the route does
 * not advertise its own existence. It takes no user parameter - the identity
 * is whoever is signed in - so it can never become a cross-user data browser.
 */
export default async function DebugPage() {
  if (!isDebugSurfaceEnabled(process.env)) notFound();

  const userId = await getCurrentUserId();
  if (!userId) {
    return (
      <main className="mx-auto max-w-3xl p-8">
        <h1 className="text-lg font-semibold">Baseline derivation</h1>
        <p className="mt-2 text-neutral-600">No signed-in companion user.</p>
      </main>
    );
  }

  const derivations = await loadBaselineDerivations(createBaselineDebugDeps(), {
    userId,
    now: new Date(),
  });

  return (
    <main className="mx-auto max-w-3xl space-y-8 p-8 font-mono text-sm">
      <header className="font-sans">
        <h1 className="text-lg font-semibold">Baseline derivation</h1>
        <p className="text-neutral-600">
          Recomputed live from stored interaction events, through the same pure
          function ingestion uses. Development only.
        </p>
      </header>

      {derivations.length === 0 && (
        <p className="font-sans text-neutral-500">
          No interaction events yet. Nothing to derive.
        </p>
      )}

      {derivations.map((d) => (
        <section key={`${d.entityId}:${d.eventType}`} className="space-y-2 border-t pt-4">
          <h2 className="font-sans text-base font-semibold">
            {d.entityName} — {d.eventType}{" "}
            <span
              className={
                d.status === "ACTIVE"
                  ? "text-green-700"
                  : d.status === "IRREGULAR"
                    ? "text-amber-700"
                    : "text-neutral-500"
              }
            >
              {d.status}
            </span>
          </h2>

          <dl className="grid grid-cols-[13rem_1fr] gap-x-4 gap-y-1">
            <dt>qualifying events</dt>
            <dd>{d.evidenceCount}</dd>
            <dt>statistical days</dt>
            <dd>
              {d.statisticalDayCount} — {d.statisticalDays.join(", ") || "none"}
            </dd>
            <dt>gaps (days)</dt>
            <dd>[{d.gaps.join(", ")}]</dd>
            <dt>span (days)</dt>
            <dd>{d.spanDays}</dd>
            <dt>median gap</dt>
            <dd>{d.medianGapDays ?? "—"}</dd>
            <dt>MAD</dt>
            <dd>{d.madDays ?? "—"}</dd>
            <dt>dispersion (MAD/median)</dt>
            <dd>{d.dispersion === null ? "—" : d.dispersion.toFixed(4)}</dd>
            <dt>threshold (days)</dt>
            <dd>
              {d.derivedThresholdDays ?? "—"}{" "}
              <span className="font-sans text-xs text-neutral-500">
                derived on read, not stored — M4&rsquo;s detector calls the same
                function
              </span>
            </dd>
            <dt>baseline read</dt>
            <dd>
              {d.baselineSource === "persisted"
                ? `served from the persisted row (computed ${d.baselineComputedAt})`
                : d.baselineSource === "recomputed_stale"
                  ? `row was stale — recomputed on this read (${d.baselineComputedAt})`
                  : `no row existed — computed on this read (${d.baselineComputedAt})`}
              {d.persistedDisagrees && (
                <span className="text-red-700">
                  {" "}
                  — live derivation disagrees with it
                </span>
              )}
            </dd>
            <dt>method version</dt>
            <dd>{d.methodVersion}</dd>
            <dt>inputs hash</dt>
            <dd>{d.inputsHash}</dd>
          </dl>

          {d.reasons.length > 0 && (
            <div>
              <p className="font-sans font-medium">gate failures</p>
              <ul className="list-inside list-disc">
                {d.reasons.map((r) => (
                  <li key={r.code}>{JSON.stringify(r)}</li>
                ))}
              </ul>
            </div>
          )}

          {d.excludedEvents.length > 0 && (
            <div>
              <p className="font-sans font-medium">excluded from statistics</p>
              <ul className="list-inside list-disc">
                {d.excludedEvents.map((e) => (
                  <li key={`${e.occurredAt}-${e.reason}`}>
                    {e.occurredAt.slice(0, 10)} — {e.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      ))}
    </main>
  );
}
