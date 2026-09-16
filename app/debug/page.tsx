import { notFound } from "next/navigation";
import { isDebugSurfaceEnabled } from "@/server/config";
import { getCurrentUserId } from "@/server/auth/current-user";
import { loadBaselineDerivations } from "@/server/services/baseline-debug";
import { loadDetectionDebug } from "@/server/services/detection-debug";
import { loadConsentDebug } from "@/server/services/consent-debug";
import {
  createBaselineDebugDeps,
  createConsentDebugDeps,
  createDetectionDebugDeps,
} from "@/server/services/deps";

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

  const now = new Date();
  const [derivations, signals, consent] = await Promise.all([
    loadBaselineDerivations(createBaselineDebugDeps(), { userId, now }),
    loadDetectionDebug(createDetectionDebugDeps(), { userId, now }),
    loadConsentDebug(createConsentDebugDeps(), { userId, now }),
  ]);

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

      <section className="space-y-4 border-t-4 pt-6">
        <header className="font-sans">
          <h2 className="text-base font-semibold">Detection &rarr; draft (M4)</h2>
          <p className="text-neutral-600">
            Every signal this account has produced, why it was or was not acted
            on, and the exact bytes that would be sent. Development only.
          </p>
        </header>

        {signals.length === 0 && (
          <p className="font-sans text-neutral-500">No signals yet.</p>
        )}

        {signals.map((s) => (
          <article key={s.id} className="space-y-2 border-t pt-4">
            <h3 className="font-sans text-base font-semibold">
              {s.entityName} &mdash; {s.signalType}{" "}
              <span
                className={
                  s.status === "materialized"
                    ? "text-green-700"
                    : s.status === "suppressed"
                      ? "text-amber-700"
                      : "text-neutral-500"
                }
              >
                {s.status}
              </span>
            </h3>

            <dl className="grid grid-cols-[13rem_1fr] gap-x-4 gap-y-1">
              <dt>detected at</dt>
              <dd>{s.detectedAt}</dd>
              <dt>materialized at</dt>
              <dd>{s.materializedAt ?? "\u2014"}</dd>
              <dt>suppression reason</dt>
              <dd className={s.suppressionReason ? "text-amber-700" : ""}>
                {s.suppressionReason ?? "\u2014"}
              </dd>
              <dt>explanation</dt>
              <dd className="whitespace-pre-wrap break-all">
                {JSON.stringify(s.explanation, null, 2)}
              </dd>
            </dl>

            {s.opportunity === null ? (
              <p className="font-sans text-neutral-500">No opportunity.</p>
            ) : (
              <dl className="grid grid-cols-[13rem_1fr] gap-x-4 gap-y-1 border-l-2 pl-4">
                <dt>opportunity</dt>
                <dd>
                  {s.opportunity.id} &mdash;{" "}
                  <span className="font-semibold">{s.opportunity.status}</span>
                </dd>
                <dt>expires at</dt>
                <dd>
                  {s.opportunity.expiresAt}{" "}
                  {s.opportunity.expired && (
                    <span className="text-red-700">(past &mdash; not offerable)</span>
                  )}
                </dd>
                <dt>proposal</dt>
                <dd className="whitespace-pre-wrap break-all">
                  {JSON.stringify(s.opportunity.proposal, null, 2)}
                </dd>
                <dt>share payload (outbound)</dt>
                <dd className="whitespace-pre-wrap break-all">
                  {s.opportunity.sharePayload
                    ? JSON.stringify(s.opportunity.sharePayload, null, 2)
                    : "\u2014"}
                </dd>
                <dt>rendered text</dt>
                <dd className="whitespace-pre-wrap">
                  {s.opportunity.renderedText ?? "\u2014"}
                </dd>
                <dt>rendered text hash</dt>
                <dd className="break-all">
                  {s.opportunity.renderedTextHash ?? "\u2014"}
                </dd>
                <dt>hash recomputes</dt>
                <dd
                  className={
                    s.opportunity.hashMatchesText === false ? "text-red-700" : ""
                  }
                >
                  {s.opportunity.hashMatchesText === null
                    ? "\u2014"
                    : s.opportunity.hashMatchesText
                      ? "yes"
                      : "NO \u2014 stored hash does not match stored text"}
                </dd>
                <dt>fallback used</dt>
                <dd>
                  {s.opportunity.fallbackUsed === null
                    ? "\u2014"
                    : s.opportunity.fallbackUsed
                      ? "yes (deterministic template)"
                      : "no (renderer output passed the guard)"}
                </dd>
              </dl>
            )}
          </article>
        ))}
      </section>

      <section className="space-y-4 border-t-4 pt-6">
        <header className="font-sans">
          <h2 className="text-base font-semibold">Consent &amp; family loop (M5)</h2>
          <p className="text-neutral-600">
            The chain of custody, recomputed rather than restated: shown &rarr;
            approved &rarr; sent. No token is ever displayed here.
          </p>
        </header>

        {consent.length === 0 && (
          <p className="font-sans text-neutral-500">No opportunities yet.</p>
        )}

        {consent.map((row) => (
          <article key={row.opportunityId} className="space-y-2 border-t pt-4">
            <h3 className="font-sans text-base font-semibold">
              {row.entityName}{" "}
              <span
                className={
                  row.status === "consumed"
                    ? "text-green-700"
                    : row.status === "declined" || row.status === "expired"
                      ? "text-neutral-500"
                      : "text-amber-700"
                }
              >
                {row.status}
              </span>
            </h3>

            <dl className="grid grid-cols-[13rem_1fr] gap-x-4 gap-y-1">
              <dt>offered / resolved</dt>
              <dd>
                {row.offeredAt ?? "\u2014"} / {row.resolvedAt ?? "\u2014"}
              </dd>
              <dt>offerable until</dt>
              <dd>
                {row.expiresAt} {row.expired && <span className="text-red-700">(past)</span>}
              </dd>
              <dt>rendered text</dt>
              <dd className="whitespace-pre-wrap">{row.renderedText ?? "\u2014"}</dd>
              <dt>rendered text hash</dt>
              <dd className="break-all">{row.renderedTextHash ?? "\u2014"}</dd>
            </dl>

            {row.grant === null ? (
              <p className="font-sans text-neutral-500">No consent grant.</p>
            ) : (
              <dl className="grid grid-cols-[13rem_1fr] gap-x-4 gap-y-1 border-l-2 pl-4">
                <dt>grant</dt>
                <dd>
                  {row.grant.id} &mdash;{" "}
                  <span className="font-semibold">{row.grant.state}</span>
                </dd>
                <dt>granted / expires</dt>
                <dd>
                  {row.grant.grantedAt} &rarr; {row.grant.expiresAt}
                </dd>
                <dt>used / revoked</dt>
                <dd>
                  {row.grant.usedAt ?? "\u2014"} / {row.grant.revokedAt ?? "\u2014"}
                </dd>
                <dt>scope</dt>
                <dd className="whitespace-pre-wrap break-all">
                  {JSON.stringify(row.grant.scope)}
                </dd>
                <dt>snapshot hash recomputes</dt>
                <dd className={row.grant.snapshotHashRecomputes ? "" : "text-red-700"}>
                  {row.grant.snapshotHashRecomputes ? "yes" : "NO"}
                </dd>
                <dt>approved == stored draft</dt>
                <dd className={row.grant.matchesOpportunityText ? "" : "text-red-700"}>
                  {row.grant.matchesOpportunityText ? "yes" : "NO"}
                </dd>
                <dt>payload snapshot matches</dt>
                <dd className={row.grant.matchesOpportunityPayload ? "" : "text-red-700"}>
                  {row.grant.matchesOpportunityPayload ? "yes" : "NO"}
                </dd>
              </dl>
            )}

            {row.request !== null && (
              <dl className="grid grid-cols-[13rem_1fr] gap-x-4 gap-y-1 border-l-2 pl-4">
                <dt>family request</dt>
                <dd>
                  {row.request.id} &mdash;{" "}
                  <span className="font-semibold">{row.request.status}</span>
                </dd>
                <dt>sent == approved bytes</dt>
                <dd className={row.request.bodyMatchesGrant ? "" : "text-red-700"}>
                  {row.request.bodyMatchesGrant ? "yes" : "NO"}
                </dd>
                <dt>delivered / opened</dt>
                <dd>
                  {row.request.deliveredAt ?? "\u2014"} / {row.request.openedAt ?? "\u2014"}
                </dd>
                <dt>attempts / last error</dt>
                <dd>
                  {row.request.deliveryAttempts} / {row.request.lastDeliveryError ?? "\u2014"}
                </dd>
                <dt>token window</dt>
                <dd>
                  until {row.request.tokenExpiresAt}{" "}
                  {row.request.tokenExpired && <span className="text-red-700">(past)</span>}
                </dd>
                <dt>token hash prefix</dt>
                <dd>
                  {row.request.tokenHashPrefix}&hellip;{" "}
                  <span className="font-sans text-xs text-neutral-500">
                    the token itself exists only in the family member&rsquo;s link
                  </span>
                </dd>
              </dl>
            )}

            {row.response !== null && (
              <dl className="grid grid-cols-[13rem_1fr] gap-x-4 gap-y-1 border-l-2 pl-4">
                <dt>family response</dt>
                <dd>{row.response.receivedAt}</dd>
                <dt>parsed</dt>
                <dd className="whitespace-pre-wrap break-all">
                  {JSON.stringify(row.response.parsed)}
                </dd>
                <dt>closure</dt>
                <dd>
                  {row.closure
                    ? `${row.closure.id} — surfaced ${row.closure.surfacedAt ?? "not yet"}`
                    : "\u2014"}
                </dd>
              </dl>
            )}
          </article>
        ))}
      </section>
    </main>
  );
}
