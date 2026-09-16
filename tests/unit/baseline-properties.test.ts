import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { baselineConfig } from "@/core/baseline/config";
import { computeBaseline, computeCadenceThreshold, type BaselineInputEvent } from "@/core/baseline/compute";

/**
 * Property tests for the baseline engine.
 *
 * Example tests pin the cases we thought of; these pin the ones we did not.
 * Seeded so a failure is reproducible rather than a story about a build that
 * went red once.
 */
const NOW = new Date("2026-09-16T00:00:00.000Z");
const DAY = 86_400_000;
const RUNS = { numRuns: 400, seed: 20260916 };

/** Events at the given day-offsets before NOW, all qualifying. */
function eventsAt(daysAgo: readonly number[]): BaselineInputEvent[] {
  return daysAgo.map((d, index) => ({
    id: `e${index}-${d}`,
    occurredAt: new Date(NOW.getTime() - d * DAY),
    occurredAtPrecision: "day" as const,
    certainty: 0.9,
    polarity: "positive" as const,
  }));
}

/** A series of distinct day offsets inside the lookback window. */
const daySeries = (minLength: number, maxLength: number) =>
  fc
    .uniqueArray(fc.integer({ min: 0, max: baselineConfig.lookbackDays - 1 }), {
      minLength,
      maxLength,
    })
    .map((days) => [...days].sort((a, b) => b - a));

describe("Property A: below the evidence gates, never ACTIVE", () => {
  it("holds for any series with too few distinct days", () => {
    fc.assert(
      fc.property(daySeries(0, baselineConfig.minEvents - 1), (days) => {
        const baseline = computeBaseline(eventsAt(days), NOW);
        expect(baseline.status).toBe("NO_BASELINE");
        expect(baseline.medianGapDays).toBeNull();
      }),
      RUNS,
    );
  });

  it("holds for any series whose span is too short", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.integer({ min: 0, max: baselineConfig.minSpanDays - 1 }), {
          minLength: 4,
          maxLength: 12,
        }),
        (days) => {
          const baseline = computeBaseline(eventsAt(days), NOW);
          expect(baseline.status).toBe("NO_BASELINE");
        },
      ),
      RUNS,
    );
  });
});

describe("Property B: input ordering cannot change the baseline", () => {
  it("any permutation yields an identical result", () => {
    fc.assert(
      fc.property(daySeries(0, 20), (days) => {
        const events = eventsAt(days);
        const canonical = computeBaseline(events, NOW);

        return fc.assert(
          fc.property(fc.shuffledSubarray(events, { minLength: events.length }), (shuffled) => {
            const other = computeBaseline(shuffled, NOW);
            expect(other.status).toBe(canonical.status);
            expect(other.inputsHash).toBe(canonical.inputsHash);
            expect(other.gaps).toEqual(canonical.gaps);
            expect(other.medianGapDays).toBe(canonical.medianGapDays);
            expect(other.madDays).toBe(canonical.madDays);
          }),
          { numRuns: 5, seed: RUNS.seed },
        );
      }),
      { numRuns: 120, seed: RUNS.seed },
    );
  });
});

describe("Property C: same inputs_hash implies same statistics", () => {
  it("never produces matching hashes with differing statistics", () => {
    const seen = new Map<string, string>();
    fc.assert(
      fc.property(daySeries(0, 16), (days) => {
        const baseline = computeBaseline(eventsAt(days), NOW);
        const signature = JSON.stringify({
          status: baseline.status,
          gaps: baseline.gaps,
          median: baseline.medianGapDays,
          mad: baseline.madDays,
        });
        const previous = seen.get(baseline.inputsHash);
        if (previous !== undefined) expect(signature).toBe(previous);
        seen.set(baseline.inputsHash, signature);
      }),
      RUNS,
    );
  });
});

describe("Property D: IRREGULAR is never treated as ACTIVE", () => {
  it("an irregular baseline never carries a threshold", () => {
    fc.assert(
      fc.property(daySeries(0, 20), (days) => {
        const baseline = computeBaseline(eventsAt(days), NOW);
        if (baseline.status !== "ACTIVE") {
          // No rhythm means no threshold may be derived at all.
          expect(baseline.medianGapDays === null || baseline.dispersion === null ||
            baseline.dispersion > baselineConfig.maxDispersion).toBe(true);
        } else {
          expect(baseline.dispersion!).toBeLessThanOrEqual(baselineConfig.maxDispersion);
        }
      }),
      RUNS,
    );
  });
});

describe("Property E: a threshold is never below the absolute floor", () => {
  it("holds for every ACTIVE baseline", () => {
    fc.assert(
      fc.property(daySeries(0, 25), (days) => {
        const baseline = computeBaseline(eventsAt(days), NOW);
        if (baseline.status === "ACTIVE") {
          expect(
            computeCadenceThreshold(baseline.medianGapDays!, baseline.madDays!),
          ).toBeGreaterThanOrEqual(baselineConfig.absoluteFloorDays);
        }
      }),
      RUNS,
    );
  });

  it("holds for the threshold function over arbitrary statistics", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0.1, max: 200, noNaN: true }),
        fc.double({ min: 0, max: 200, noNaN: true }),
        (medianGap, mad) => {
          expect(computeCadenceThreshold(medianGap, mad)).toBeGreaterThanOrEqual(
            baselineConfig.absoluteFloorDays,
          );
        },
      ),
      RUNS,
    );
  });
});

describe("Property F: the threshold is monotonic in median and MAD", () => {
  it("never decreases when the median grows", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0.1, max: 100, noNaN: true }),
        fc.double({ min: 0, max: 50, noNaN: true }),
        fc.double({ min: 0, max: 50, noNaN: true }),
        (medianGap, mad, increase) => {
          expect(computeCadenceThreshold(medianGap + increase, mad)).toBeGreaterThanOrEqual(
            computeCadenceThreshold(medianGap, mad),
          );
        },
      ),
      RUNS,
    );
  });

  it("never decreases when the MAD grows", () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0.1, max: 100, noNaN: true }),
        fc.double({ min: 0, max: 50, noNaN: true }),
        fc.double({ min: 0, max: 50, noNaN: true }),
        (medianGap, mad, increase) => {
          expect(computeCadenceThreshold(medianGap, mad + increase)).toBeGreaterThanOrEqual(
            computeCadenceThreshold(medianGap, mad),
          );
        },
      ),
      RUNS,
    );
  });
});

describe("Property G: recency never demotes a historical baseline", () => {
  it("moving `now` forward cannot change a status while the window still holds", () => {
    fc.assert(
      fc.property(daySeries(0, 15), fc.integer({ min: 1, max: 60 }), (days, forward) => {
        const events = eventsAt(days);
        const before = computeBaseline(events, NOW);
        const after = computeBaseline(events, new Date(NOW.getTime() + forward * DAY));

        // Only compare when nothing aged out of the lookback window.
        if (after.observationCount === before.observationCount) {
          expect(after.status).toBe(before.status);
          expect(after.inputsHash).toBe(before.inputsHash);
        }
      }),
      RUNS,
    );
  });
});
