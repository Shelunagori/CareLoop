import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { authorizeDevSeed, isDebugSurfaceEnabled } from "@/server/config";
import { fixedClock } from "@/server/adapters/clock";
import type { Baseline } from "@/core/baseline/compute";
import { computeBaseline, computeCadenceThreshold } from "@/core/baseline/compute";
import { loadBaselineDerivations, type BaselineDebugDeps } from "@/server/services/baseline-debug";
import type { EntityRecord } from "@/server/repositories/entities";

const NOW = new Date("2026-09-16T10:00:00.000Z");
const USER = "user-a";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function entity(id: string, name: string): EntityRecord {
  return {
    id,
    type: "person",
    subtype: null,
    displayName: name,
    aliases: [],
    status: "active",
    lastMentionedAt: null,
  };
}

const saved = new Map<string, { baseline: Baseline; computedAt: string }>();

function deps(options: {
  entities: EntityRecord[];
  events: Array<{ entityId: string; eventType: "visit" | "call"; daysAgo: number; certainty?: number; polarity?: "positive" | "absence" }>;
  onList?: (userId: string) => void;
}): BaselineDebugDeps {
  return {
    entities: {
      async listForUser() {
        return options.entities;
      },
      async listRecentlyMentioned() {
        return [];
      },
      async create() {
        throw new Error("unused");
      },
      async addAlias() {},
      async touchMention() {},
      async flagNeedsConfirmation() {},
    },
    baselines: {
      async save({ entityId, eventType, baseline, computedAt }) {
        saved.set(`${entityId}:${eventType}`, { baseline, computedAt });
      },
      async find({ entityId, eventType }) {
        const hit = saved.get(`${entityId}:${eventType}`);
        if (!hit) return null;
        return {
          id: "bl",
          entityId,
          eventType,
          status: hit.baseline.status,
          medianGapDays: hit.baseline.medianGapDays,
          madDays: hit.baseline.madDays,
          observationCount: hit.baseline.observationCount,
          windowStart: null,
          windowEnd: null,
          reasons: hit.baseline.reasons,
          methodVersion: hit.baseline.methodVersion,
          inputsHash: hit.baseline.inputsHash,
          computedAt: hit.computedAt,
        };
      },
      async listForUser() {
        return [];
      },
    },
    clock: fixedClock(NOW),
    interactionEvents: {
      async insertMany() {},
      async listForSeries({ userId, entityId, eventType }) {
        options.onList?.(userId);
        return options.events
          .filter((e) => e.entityId === entityId && e.eventType === eventType)
          .map((e, index) => {
            const occurredAt = new Date(NOW.getTime() - e.daysAgo * 86_400_000);
            return {
              id: `ie-${index}`,
              entityId: e.entityId,
              eventType: e.eventType,
              occurredAt: occurredAt.toISOString(),
              occurredAtPrecision: "day" as const,
              reportedAt: NOW.toISOString(),
              certainty: e.certainty ?? 0.9,
              polarity: e.polarity ?? ("positive" as const),
              windowStart: null,
              windowEnd: null,
              ingestFingerprint: `fp-${index}`,
            };
          });
      },
    },
  };
}

describe("25. the debug derivation matches the core result", () => {
  it("reproduces computeBaseline exactly, rather than restating a stored row", async () => {
    const events = [35, 28, 21, 14, 7, 0].map((daysAgo) => ({
      entityId: "e1",
      eventType: "visit" as const,
      daysAgo,
    }));

    const [derivation] = await loadBaselineDerivations(
      deps({ entities: [entity("e1", "John")], events }),
      { userId: USER, now: NOW },
    );

    const expected = computeBaseline(
      events.map((e, index) => ({
        id: `ie-${index}`,
        occurredAt: new Date(NOW.getTime() - e.daysAgo * 86_400_000),
        occurredAtPrecision: "day" as const,
        certainty: 0.9,
        polarity: "positive" as const,
      })),
      NOW,
    );

    expect(derivation.status).toBe(expected.status);
    expect(derivation.gaps).toEqual(expected.gaps);
    expect(derivation.medianGapDays).toBe(expected.medianGapDays);
    expect(derivation.madDays).toBe(expected.madDays);
    expect(derivation.inputsHash).toBe(expected.inputsHash);
    expect(derivation.methodVersion).toBe(expected.methodVersion);
    // The threshold is derived on read from the statistics, not persisted.
    expect(derivation.derivedThresholdDays).toBe(
      computeCadenceThreshold(expected.medianGapDays!, expected.madDays!),
    );
  });

  it("explains why an event was excluded", async () => {
    const [derivation] = await loadBaselineDerivations(
      deps({
        entities: [entity("e1", "John")],
        events: [
          { entityId: "e1", eventType: "visit", daysAgo: 21 },
          { entityId: "e1", eventType: "visit", daysAgo: 14 },
          { entityId: "e1", eventType: "visit", daysAgo: 7 },
          { entityId: "e1", eventType: "visit", daysAgo: 0 },
          { entityId: "e1", eventType: "visit", daysAgo: 3, polarity: "absence" },
          { entityId: "e1", eventType: "visit", daysAgo: 4, certainty: 0.2 },
        ],
      }),
      { userId: USER, now: NOW },
    );

    expect(derivation.evidenceCount).toBe(4);
    const reasons = derivation.excludedEvents.map((e) => e.reason);
    expect(reasons.some((r) => r.includes("absence"))).toBe(true);
    expect(reasons.some((r) => r.includes("certainty"))).toBe(true);
  });
});

describe("26. the debug surface is unavailable outside local development", () => {
  it("is enabled only for exactly NODE_ENV=development off Vercel", () => {
    expect(isDebugSurfaceEnabled({ NODE_ENV: "development" })).toBe(true);
    expect(isDebugSurfaceEnabled({ NODE_ENV: "development", VERCEL: "1" })).toBe(false);
  });

  it("fails closed for every other environment", () => {
    for (const value of [undefined, "", "production", "Production", "PRODUCTION", "test", "staging", "prod", "development "]) {
      expect(isDebugSurfaceEnabled({ NODE_ENV: value })).toBe(false);
    }
  });

  it("the page calls notFound() rather than rendering a guarded message", () => {
    const page = readFileSync(path.join(root, "app/debug/page.tsx"), "utf8");
    expect(page).toMatch(/if \(!isDebugSurfaceEnabled\(process\.env\)\) notFound\(\);/);
  });

  it("the dev seeder routes its decision through authorizeDevSeed and 404s", () => {
    const route = readFileSync(path.join(root, "app/api/dev/seed-events/route.ts"), "utf8");
    expect(route).toMatch(/authorizeDevSeed\(\s*process\.env,/);
    expect(route).toMatch(/if \(!auth\.allowed\)/);
    expect(route).toMatch(/status: 404/);
    // Identity comes from the session; the body cannot name a user.
    expect(route).toMatch(/const userId = await getCurrentUserId\(\)/);
    expect(route).not.toMatch(/userId:\s*(parsed|body)/);
  });
});

describe("dev seed authorization", () => {
  const SECRET = "local-dev-secret";
  const localDev = { NODE_ENV: "development", CARELOOP_DEV_SEED_SECRET: SECRET };

  it("allows only local development with a configured, matching secret", () => {
    expect(authorizeDevSeed(localDev, SECRET)).toEqual({ allowed: true });
  });

  it("refuses in production even with the right secret", () => {
    expect(
      authorizeDevSeed({ NODE_ENV: "production", CARELOOP_DEV_SEED_SECRET: SECRET }, SECRET),
    ).toEqual({ allowed: false, reason: "not_development" });
  });

  it("refuses on Vercel even when NODE_ENV claims development", () => {
    expect(authorizeDevSeed({ ...localDev, VERCEL: "1" }, SECRET)).toEqual({
      allowed: false,
      reason: "deployed",
    });
  });

  it("refuses when no secret is configured", () => {
    expect(authorizeDevSeed({ NODE_ENV: "development" }, SECRET)).toEqual({
      allowed: false,
      reason: "secret_not_configured",
    });
    // A blank env var must not open the route to a blank header.
    expect(authorizeDevSeed({ NODE_ENV: "development", CARELOOP_DEV_SEED_SECRET: "" }, "")).toEqual({
      allowed: false,
      reason: "secret_not_configured",
    });
  });

  it("refuses a wrong or missing supplied secret", () => {
    expect(authorizeDevSeed(localDev, "wrong")).toEqual({
      allowed: false,
      reason: "secret_mismatch",
    });
    expect(authorizeDevSeed(localDev, null)).toEqual({
      allowed: false,
      reason: "secret_mismatch",
    });
  });

  it("fails closed for every unexpected NODE_ENV", () => {
    for (const value of [undefined, "", "test", "staging", "prod", "Production", "development "]) {
      expect(
        authorizeDevSeed({ NODE_ENV: value, CARELOOP_DEV_SEED_SECRET: SECRET }, SECRET).allowed,
      ).toBe(false);
    }
  });
});

describe("27. no arbitrary cross-user debug lookup", () => {
  it("scopes every query to the signed-in user", async () => {
    const seen: string[] = [];
    await loadBaselineDerivations(
      deps({
        entities: [entity("e1", "John")],
        events: [{ entityId: "e1", eventType: "visit", daysAgo: 1 }],
        onList: (userId) => seen.push(userId),
      }),
      { userId: USER, now: NOW },
    );
    expect(new Set(seen)).toEqual(new Set([USER]));
  });

  it("accepts no user identifier from the request", () => {
    const page = readFileSync(path.join(root, "app/debug/page.tsx"), "utf8");
    // Identity comes from the session, never from a param or search param.
    expect(page).toMatch(/const userId = await getCurrentUserId\(\)/);
    expect(page).not.toMatch(/searchParams/);
    expect(page).not.toMatch(/params\.userId/);
  });
});
