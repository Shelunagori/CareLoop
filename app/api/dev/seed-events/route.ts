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
 * Development-only evidence seeder for M3.
 *
 * A baseline needs four weeks of history, which is a long time to wait to find
 * out whether the maths works. This creates that history the honest way: it
 * writes real interaction_events through the real repository and recomputes
 * through the real pure function. There is no seed-specific baseline path, and
 * no user is special-cased - the preset only chooses day offsets.
 *
 * It is NOT the M6 demo fixture: no conversation, no extraction, no George.
 */
const PRESETS = {
  /** Weekly, low dispersion -> ACTIVE, median 7, MAD 0, threshold 11. */
  weekly: [35, 28, 21, 14, 7, 0],
  /** Same count and span, wildly uneven -> IRREGULAR. */
  irregular: [75, 35, 32, 2, 0],
  /** Too few events to be a rhythm -> NO_BASELINE. */
  sparse: [30, 15],
} as const;

const SeedRequestSchema = z.object({
  preset: z.enum(["weekly", "irregular", "sparse"]),
  entityName: z.string().trim().min(1).max(80),
  eventType: z.enum(["visit", "call"]).default("visit"),
});

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
    }));

  const offsets = PRESETS[preset];
  await deps.interactionEvents.insertMany(
    offsets.map((daysAgo) => {
      const occurredAt = new Date(
        Date.UTC(
          now.getUTCFullYear(),
          now.getUTCMonth(),
          now.getUTCDate(),
        ) - daysAgo * DAY_MS,
      );
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
        ingestFingerprint: stableHash([
          "dev-seed.v1",
          userId,
          entity.id,
          eventType,
          preset,
          occurredAt.toISOString(),
        ]),
      };
    }),
  );

  // Recomputed and persisted through the ordinary service path - there is no
  // seed-specific baseline logic.
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
