import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUserId } from "@/server/auth/current-user";
import { authorizeDevSeed } from "@/server/config";
import { DAY_MS } from "@/core/baseline/day";
import { stableHash } from "@/core/baseline/hash";
import { computeCadenceThreshold } from "@/core/baseline/compute";
import { recomputeSeries } from "@/server/services/baseline";
import { createM3SeedDeps } from "@/server/services/deps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Development-only evidence seeder (M3, extended for M4).
 *
 * A baseline needs four weeks of history, which is a long time to wait to find
 * out whether the maths works. This creates that history the honest way: it
 * writes real interaction_events through the real repository and recomputes
 * through the real pure function. There is no seed-specific baseline path, no
 * seed-specific detector path, and no user is special-cased - the preset only
 * chooses day offsets and a polarity.
 *
 * It is NOT the M6 demo fixture: no conversation, no extraction, no George.
 */
type Preset =
  | { kind: "positive"; offsets: readonly number[] }
  | { kind: "absence"; windowDays: number };

const PRESETS = {
  /** Weekly, last contact today -> ACTIVE, median 7, MAD 0, no cadence gap. */
  weekly: { kind: "positive", offsets: [35, 28, 21, 14, 7, 0] },
  /**
   * Weekly, last contact 13 days ago -> ACTIVE, median 7, MAD 0,
   * threshold 11, 13 > 11 -> cadence_gap fires. The margin is deliberately
   * two days, so a threshold regression breaks this loudly (R5).
   */
  "cadence-gap": { kind: "positive", offsets: [48, 41, 34, 27, 20, 13] },
  /** Same count and span, wildly uneven -> IRREGULAR, detector must not run. */
  irregular: { kind: "positive", offsets: [75, 35, 32, 2, 0] },
  /** Too few events to be a rhythm -> NO_BASELINE. */
  sparse: { kind: "positive", offsets: [30, 15] },
  /**
   * One explicit absence assertion over a week, and nothing else. Produces
   * NO_BASELINE, which is the point: the user's own statement needs no rhythm.
   */
  absence: { kind: "absence", windowDays: 7 },
} as const satisfies Record<string, Preset>;

const SeedRequestSchema = z.object({
  preset: z.enum(["weekly", "cadence-gap", "irregular", "sparse", "absence"]),
  entityName: z.string().trim().min(1).max(80),
  eventType: z.enum(["visit", "call"]).default("visit"),
});

function utcMidnight(now: Date, daysAgo: number): Date {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - daysAgo * DAY_MS,
  );
}

export async function POST(request: Request) {
  // Fail closed. Anything other than local development with a configured and
  // matching secret gets a 404: the route does not advertise its own existence.
  const auth = authorizeDevSeed(process.env, request.headers.get("x-careloop-dev-secret"));
  if (!auth.allowed) {
    return new NextResponse("Not Found", { status: 404 });
  }

  const userId = await getCurrentUserId();
  if (!userId) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const parsed = SeedRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_request", detail: parsed.error.issues }, { status: 400 });
  }
  const { preset, entityName, eventType } = parsed.data;

  const deps = createM3SeedDeps();
  const now = new Date();

  // Reuse the entity if it already exists, so re-running is idempotent.
  const existing = await deps.entities.listForUser(userId, 200);
  const entity =
    existing.find((e) => e.displayName.toLowerCase() === entityName.toLowerCase()) ??
    (await deps.entities.create({
      userId,
      type: "person",
      subtype: null,
      displayName: entityName,
      /**
       * STAMPED, so the presentation path can refuse it (M12e).
       *
       * This route is where "M4ABSENCE1789574558" came from: an operator
       * types a name, and until now the row it created was indistinguishable
       * from a person the user had told CareLoop about. A label filter caught
       * that particular string because it had digits in it; it could never
       * have caught "TestPersonA". The row now says what it is.
       */
      origin: "dev",
    }));

  const spec: Preset = PRESETS[preset];

  const fingerprint = (parts: readonly (string | number)[]) =>
    stableHash(["dev-seed.v1", userId, entity.id, eventType, preset, ...parts]);

  if (spec.kind === "positive") {
    await deps.interactionEvents.insertMany(
      spec.offsets.map((daysAgo) => {
        const occurredAt = utcMidnight(now, daysAgo);
        return {
          userId,
          entityId: entity.id,
          eventType,
          occurredAt: occurredAt.toISOString(),
          occurredAtPrecision: "day" as const,
          reportedAt: occurredAt.toISOString(),
          certainty: 0.9,
          polarity: "positive" as const,
          windowStart: null,
          windowEnd: null,
          sourceObservationId: null,
          // Deterministic, so re-running the same preset writes nothing new.
          ingestFingerprint: fingerprint([occurredAt.toISOString()]),
        };
      }),
    );
  } else {
    const windowStart = utcMidnight(now, spec.windowDays);
    // The window ends at the moment it was reported, exactly as the temporal
    // resolver does for a week-scale phrase like "this week".
    const windowEnd = now;
    await deps.interactionEvents.insertMany([
      {
        userId,
        entityId: entity.id,
        eventType,
        occurredAt: windowStart.toISOString(),
        occurredAtPrecision: "day" as const,
        reportedAt: windowEnd.toISOString(),
        certainty: 0.9,
        polarity: "absence" as const,
        windowStart: windowStart.toISOString(),
        windowEnd: windowEnd.toISOString(),
        sourceObservationId: null,
        // Bucketed to the day so repeated seeding within one day is idempotent.
        ingestFingerprint: fingerprint([
          "absence",
          windowStart.toISOString(),
          windowEnd.toISOString().slice(0, 10),
        ]),
      },
    ]);
  }

  // Recomputed and persisted through the ordinary service path - there is no
  // seed-specific baseline logic. For the absence preset this deliberately
  // yields NO_BASELINE: an absence assertion is never positive cadence.
  const baseline = await recomputeSeries(deps, { userId, entityId: entity.id, eventType });

  return NextResponse.json({
    entity: { id: entity.id, name: entity.displayName },
    eventType,
    preset,
    eventsInSeries: baseline.observationCount,
    baseline: {
      status: baseline.status,
      medianGapDays: baseline.medianGapDays,
      madDays: baseline.madDays,
      dispersion: baseline.dispersion,
      // Derived on the fly, never stored (docs/03 section 10.1).
      derivedThresholdDays:
        baseline.status === "ACTIVE" && baseline.medianGapDays !== null && baseline.madDays !== null
          ? computeCadenceThreshold(baseline.medianGapDays, baseline.madDays)
          : null,
      gaps: baseline.gaps,
      spanDays: baseline.spanDays,
      statisticalDayCount: baseline.statisticalDayCount,
      reasons: baseline.reasons,
      inputsHash: baseline.inputsHash,
      methodVersion: baseline.methodVersion,
    },
  });
}
