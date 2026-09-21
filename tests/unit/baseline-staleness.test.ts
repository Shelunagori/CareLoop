import { describe, expect, it } from "vitest";
import { fixedClock } from "@/server/adapters/clock";
import { baselineConfig } from "@/core/baseline/config";
import type { Baseline } from "@/core/baseline/compute";
import type { InteractionEventRecord } from "@/server/repositories/interaction-events";
import { isStale, readBaseline, recomputeSeries, type BaselineDeps } from "@/server/services/baseline";

const NOW = new Date("2026-09-16T12:00:00.000Z");
const USER = "user-a";
const HOUR = 3_600_000;
const DAY = 86_400_000;

type Row = { entityId: string; eventType: "visit" | "call"; daysAgo: number };

function harness(options: {
  now?: Date;
  rows: Row[];
  stored?: Array<{ entityId: string; eventType: "visit" | "call"; computedAt: string; status?: Baseline["status"] }>;
}) {
  const now = options.now ?? NOW;
  const saved = new Map<string, { baseline: Baseline; computedAt: string }>();
  const listedSeries: string[] = [];
  const savedKeys: string[] = [];

  for (const s of options.stored ?? []) {
    saved.set(`${s.entityId}:${s.eventType}`, {
      computedAt: s.computedAt,
      baseline: {
        status: s.status ?? "ACTIVE",
        medianGapDays: 7,
        madDays: 0,
        dispersion: 0,
        observationCount: 5,
        windowStart: null,
        windowEnd: null,
        reasons: [],
        methodVersion: baselineConfig.methodVersion,
        inputsHash: "stale-hash",
      },
    });
  }

  const deps: BaselineDeps = {
    clock: fixedClock(now),
    interactionEvents: {
      async latestPositiveSince() {
      return null;
    },
    async listRecentPositive() {
        // Not a concern here: the proactive opening is tested on its own.
        return [];
      },
      async insertMany() {},
      async listForSeries({ entityId, eventType, sinceIso }) {
        listedSeries.push(`${entityId}:${eventType}`);
        return options.rows
          .filter((r) => r.entityId === entityId && r.eventType === eventType)
          .map((r, index): InteractionEventRecord => {
            const occurredAt = new Date(now.getTime() - r.daysAgo * DAY);
            return {
              id: `ie-${r.entityId}-${r.eventType}-${r.daysAgo}`,
              entityId: r.entityId,
              eventType: r.eventType,
              occurredAt: occurredAt.toISOString(),
              occurredAtPrecision: "day",
              reportedAt: occurredAt.toISOString(),
              certainty: 0.9,
              polarity: "positive",
              windowStart: null,
              windowEnd: null,
              sourceObservationId: null,
              ingestFingerprint: `fp-${index}`,
            };
          })
          // The repository applies the lookback cutoff; mirror that here.
          .filter((row) => row.occurredAt >= sinceIso);
      },
      // Added to the port in M4; this harness exercises neither.
      async listRecentAbsences() {
        return [];
      },
      async earliestOccurredAt() {
        return null;
      },
    },
    baselines: {
      async save({ entityId, eventType, baseline, computedAt }) {
        savedKeys.push(`${entityId}:${eventType}`);
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
  };

  return { deps, listedSeries, savedKeys, saved, now };
}

const weekly = (entityId: string, eventType: "visit" | "call" = "visit"): Row[] =>
  [35, 28, 21, 14, 7].map((daysAgo) => ({ entityId, eventType, daysAgo }));

describe("isStale", () => {
  it("uses the configured window", () => {
    const justUnder = new Date(NOW.getTime() - (baselineConfig.stalenessHours * HOUR - 1000));
    const justOver = new Date(NOW.getTime() - baselineConfig.stalenessHours * HOUR);
    expect(isStale(justUnder.toISOString(), NOW)).toBe(false);
    expect(isStale(justOver.toISOString(), NOW)).toBe(true);
  });
});

describe("1. a fresh baseline is not recomputed", () => {
  it("returns the persisted row and touches no evidence", async () => {
    const h = harness({
      rows: weekly("e1"),
      stored: [
        { entityId: "e1", eventType: "visit", computedAt: new Date(NOW.getTime() - HOUR).toISOString() },
      ],
    });

    const read = await readBaseline(h.deps, { userId: USER, entityId: "e1", eventType: "visit" });

    expect(read.source).toBe("persisted");
    // One shape out: the caller uses result.baseline on every path.
    expect(read.baseline.inputsHash).toBe("stale-hash");
    expect(read.baseline.status).toBe("ACTIVE");
    expect(read.baseline.medianGapDays).toBe(7);
    // dispersion is reconstructed from the stored statistics.
    expect(read.baseline.dispersion).toBe(0);
    expect(read.computedAt).toBe(new Date(NOW.getTime() - HOUR).toISOString());
    expect(h.listedSeries).toEqual([]); // no evidence reloaded
    expect(h.savedKeys).toEqual([]); // nothing written
  });
});

describe("2. a baseline past the staleness window is recomputed", () => {
  it("reloads evidence, recomputes and persists", async () => {
    const h = harness({
      rows: weekly("e1"),
      stored: [
        {
          entityId: "e1",
          eventType: "visit",
          computedAt: new Date(NOW.getTime() - 25 * HOUR).toISOString(),
        },
      ],
    });

    const read = await readBaseline(h.deps, { userId: USER, entityId: "e1", eventType: "visit" });

    expect(read.source).toBe("recomputed_stale");
    expect(h.listedSeries).toEqual(["e1:visit"]);
    expect(h.savedKeys).toEqual(["e1:visit"]);
    expect(read.baseline.inputsHash).not.toBe("stale-hash");
    expect(read.computedAt).toBe(NOW.toISOString());
  });

  it("computes from scratch when no row exists at all", async () => {
    const h = harness({ rows: weekly("e1") });
    const read = await readBaseline(h.deps, { userId: USER, entityId: "e1", eventType: "visit" });
    expect(read.source).toBe("recomputed_missing");
    expect(read.baseline.status).toBe("ACTIVE");
    expect(read.computedAt).toBe(NOW.toISOString());
  });
});

describe("3. only the requested series is recomputed", () => {
  it("never touches another entity or another event type", async () => {
    const h = harness({
      rows: [...weekly("e1"), ...weekly("e2"), ...weekly("e1", "call")],
      stored: [
        { entityId: "e1", eventType: "visit", computedAt: new Date(NOW.getTime() - 25 * HOUR).toISOString() },
        { entityId: "e2", eventType: "visit", computedAt: new Date(NOW.getTime() - 25 * HOUR).toISOString() },
        { entityId: "e1", eventType: "call", computedAt: new Date(NOW.getTime() - 25 * HOUR).toISOString() },
      ],
    });

    await readBaseline(h.deps, { userId: USER, entityId: "e1", eventType: "visit" });

    expect(h.listedSeries).toEqual(["e1:visit"]);
    expect(h.savedKeys).toEqual(["e1:visit"]);
  });

  it("recomputeSeries is likewise scoped to one series", async () => {
    const h = harness({ rows: [...weekly("e1"), ...weekly("e2")] });
    await recomputeSeries(h.deps, { userId: USER, entityId: "e2", eventType: "visit" });
    expect(h.savedKeys).toEqual(["e2:visit"]);
  });
});

describe("4. silence alone does not demote an ACTIVE baseline", () => {
  it("stays ACTIVE across a stale recompute while evidence is still in window", async () => {
    // Weekly history ending 40 days ago: long silence, but every event is well
    // inside the 180-day evidence window.
    const rows: Row[] = [68, 61, 54, 47, 40].map((daysAgo) => ({
      entityId: "e1",
      eventType: "visit",
      daysAgo,
    }));

    const h = harness({
      rows,
      stored: [
        { entityId: "e1", eventType: "visit", computedAt: new Date(NOW.getTime() - 25 * HOUR).toISOString() },
      ],
    });

    const read = await readBaseline(h.deps, { userId: USER, entityId: "e1", eventType: "visit" });

    expect(read.source).toBe("recomputed_stale");
    expect(read.baseline.status).toBe("ACTIVE");
    expect(read.baseline.medianGapDays).toBe(7);
    expect(read.baseline.observationCount).toBe(5);
  });
});

describe("5. evidence ageing out of the window CAN change the result", () => {
  it("drops to NO_BASELINE once too few events remain inside 180 days", async () => {
    // Five weekly visits, the newest 170 days before `now`: all still inside.
    const rows: Row[] = [198, 191, 184, 177, 170].map((daysAgo) => ({
      entityId: "e1",
      eventType: "visit",
      daysAgo,
    }));

    const early = harness({ rows, now: new Date(NOW.getTime()) });
    // Shift `now` back so the whole series sits inside the window.
    const inWindow = harness({
      rows: rows.map((r) => ({ ...r, daysAgo: r.daysAgo - 170 })),
    });
    const before = await recomputeSeries(inWindow.deps, {
      userId: USER,
      entityId: "e1",
      eventType: "visit",
    });
    expect(before.status).toBe("ACTIVE");
    expect(before.observationCount).toBe(5);

    // With the same rows but `now` far forward, the oldest have aged out.
    const after = await recomputeSeries(early.deps, {
      userId: USER,
      entityId: "e1",
      eventType: "visit",
    });
    expect(after.observationCount).toBeLessThan(5);
    expect(after.status).toBe("NO_BASELINE");
    expect(after.inputsHash).not.toBe(before.inputsHash);
  });
});


describe("every read returns exactly one effective baseline", () => {
  it("gives the same usable shape on all three paths, with no null branch", async () => {
    const fresh = harness({
      rows: weekly("e1"),
      stored: [{ entityId: "e1", eventType: "visit", computedAt: new Date(NOW.getTime() - HOUR).toISOString() }],
    });
    const stale = harness({
      rows: weekly("e1"),
      stored: [{ entityId: "e1", eventType: "visit", computedAt: new Date(NOW.getTime() - 25 * HOUR).toISOString() }],
    });
    const missing = harness({ rows: weekly("e1") });

    const results = await Promise.all([
      readBaseline(fresh.deps, { userId: USER, entityId: "e1", eventType: "visit" }),
      readBaseline(stale.deps, { userId: USER, entityId: "e1", eventType: "visit" }),
      readBaseline(missing.deps, { userId: USER, entityId: "e1", eventType: "visit" }),
    ]);

    expect(results.map((r) => r.source)).toEqual([
      "persisted",
      "recomputed_stale",
      "recomputed_missing",
    ]);

    for (const result of results) {
      // No caller ever has to fall back to a second field.
      expect(result.baseline).toBeDefined();
      expect(result.baseline.status).toBe("ACTIVE");
      expect(result.baseline.medianGapDays).toBe(7);
      expect(result.baseline.madDays).toBe(0);
      expect(typeof result.baseline.inputsHash).toBe("string");
      expect(result.baseline.methodVersion).toBe(baselineConfig.methodVersion);
      expect(typeof result.computedAt).toBe("string");
    }
  });

  it("reconstructs dispersion from a stored row rather than storing it", async () => {
    const h = harness({
      rows: weekly("e1"),
      stored: [{ entityId: "e1", eventType: "visit", computedAt: new Date(NOW.getTime() - HOUR).toISOString() }],
    });
    const read = await readBaseline(h.deps, { userId: USER, entityId: "e1", eventType: "visit" });
    // stored median 7, MAD 0 -> dispersion 0
    expect(read.baseline.dispersion).toBe(0);
  });
});
