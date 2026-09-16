import { describe, expect, it } from "vitest";
import { baselineConfig } from "@/core/baseline/config";
import { computeBaseline, computeCadenceThreshold, type BaselineInputEvent } from "@/core/baseline/compute";
import { daysBetween, utcDayKey } from "@/core/baseline/day";
import { median, medianAbsoluteDeviation } from "@/core/baseline/stats";

const NOW = new Date("2026-09-16T10:00:00.000Z");

/**
 * A qualifying positive event `daysAgo` before NOW.
 *
 * The id is derived from the offset, not a counter, so building the same
 * series twice yields the same evidence identity - which is what inputs_hash
 * is now over. Same-day events must pass distinct ids explicitly.
 */
function evt(daysAgo: number, over: Partial<BaselineInputEvent> = {}): BaselineInputEvent {
  return {
    id: `e-${daysAgo}`,
    occurredAt: new Date(NOW.getTime() - daysAgo * 86_400_000),
    occurredAtPrecision: "day",
    certainty: 0.9,
    polarity: "positive",
    ...over,
  };
}

/** Events on the given day-offsets counting back from NOW. */
function series(daysAgo: number[]): BaselineInputEvent[] {
  return daysAgo.map((d) => evt(d));
}

describe("median", () => {
  it("odd counts take the middle value", () => {
    expect(median([6, 7, 7])).toBe(7);
    expect(median([1, 100, 2])).toBe(2);
  });

  it("even counts average the two middle values", () => {
    expect(median([6, 7, 8, 9])).toBe(7.5);
    expect(median([1, 2])).toBe(1.5);
  });

  it("does not care about input order", () => {
    expect(median([9, 6, 8, 7])).toBe(median([6, 7, 8, 9]));
  });
});

describe("median absolute deviation", () => {
  it("matches the worked example", () => {
    // gaps [6,7,7,8] -> median 7 -> deviations [1,0,0,1] -> MAD 0.5
    expect(medianAbsoluteDeviation([6, 7, 7, 8])).toBe(0.5);
  });

  it("is NOT the mean absolute deviation", () => {
    // [2,7,7,8]: median 7, deviations [5,0,0,1].
    // MAD = median([5,0,0,1]) = 0.5. Mean would be 1.5.
    expect(medianAbsoluteDeviation([2, 7, 7, 8])).toBe(0.5);
    const mean = [5, 0, 0, 1].reduce((a, b) => a + b, 0) / 4;
    expect(medianAbsoluteDeviation([2, 7, 7, 8])).not.toBe(mean);
  });

  it("is zero for a perfectly regular series", () => {
    expect(medianAbsoluteDeviation([7, 7, 7, 7])).toBe(0);
  });
});

describe("NO_BASELINE — evidence gates", () => {
  it("0 events", () => {
    const baseline = computeBaseline([], NOW);
    expect(baseline.status).toBe("NO_BASELINE");
    expect(baseline.reasons.map((r) => r.code)).toContain("INSUFFICIENT_EVENTS");
    expect(baseline.medianGapDays).toBeNull();
  });

  it("1 event", () => {
    expect(computeBaseline(series([0]), NOW).status).toBe("NO_BASELINE");
  });

  it("3 events", () => {
    const baseline = computeBaseline(series([28, 21, 14]), NOW);
    expect(baseline.status).toBe("NO_BASELINE");
    expect(baseline.reasons.map((r) => r.code)).toContain("INSUFFICIENT_EVENTS");
  });

  it("4 events but span under 21 days", () => {
    const baseline = computeBaseline(series([9, 6, 3, 0]), NOW);
    expect(baseline.spanDays).toBe(9);
    expect(baseline.status).toBe("NO_BASELINE");
    expect(baseline.reasons.map((r) => r.code)).toContain("INSUFFICIENT_SPAN");
  });

  it("enough events and span but fewer than 3 distinct gaps", () => {
    // Four events on three distinct days -> only two gaps.
    const baseline = computeBaseline(
      [
        ...series([30, 15, 0]),
        evt(0, { id: "e-0-later", occurredAt: new Date(NOW.getTime() - 3_600_000) }),
      ],
      NOW,
    );
    expect(baseline.observationCount).toBe(4);
    expect(baseline.statisticalDayCount).toBe(3);
    expect(baseline.gaps).toHaveLength(2);
    expect(baseline.status).toBe("NO_BASELINE");
    expect(baseline.reasons.map((r) => r.code)).toContain("INSUFFICIENT_GAPS");
  });

  it("never publishes a partial cadence value alongside NO_BASELINE", () => {
    const baseline = computeBaseline(series([28, 21, 14]), NOW);
    expect(baseline.medianGapDays).toBeNull();
    expect(baseline.madDays).toBeNull();
    expect(baseline.dispersion).toBeNull();
  });
});

describe("input filtering", () => {
  it("excludes absence assertions from positive cadence", () => {
    const withAbsence = [
      ...series([28, 21, 14, 7]),
      evt(3, { polarity: "absence" }),
      evt(2, { polarity: "absence" }),
    ];
    const baseline = computeBaseline(withAbsence, NOW);
    const positiveOnly = computeBaseline(series([28, 21, 14, 7]), NOW);

    expect(baseline.observationCount).toBe(4);
    expect(baseline.gaps).toEqual(positiveOnly.gaps);
    expect(baseline.inputsHash).toBe(positiveOnly.inputsHash);
  });

  it("excludes events below the certainty gate", () => {
    const baseline = computeBaseline(
      [...series([28, 21, 14, 7]), evt(10, { certainty: baselineConfig.minCertainty - 0.01 })],
      NOW,
    );
    expect(baseline.observationCount).toBe(4);
  });

  it("excludes imprecise times from gap arithmetic", () => {
    const baseline = computeBaseline(
      [
        ...series([28, 21, 14, 7]),
        evt(10, { occurredAtPrecision: "week" }),
        evt(11, { occurredAtPrecision: "unknown" }),
      ],
      NOW,
    );
    expect(baseline.observationCount).toBe(4);
  });

  it("excludes events older than the lookback window", () => {
    const baseline = computeBaseline(
      [...series([28, 21, 14, 7]), evt(baselineConfig.lookbackDays + 1)],
      NOW,
    );
    expect(baseline.observationCount).toBe(4);
  });
});

describe("same-day collapse happens ONLY in the statistics", () => {
  it("counts a calendar day once no matter how many events land on it", () => {
    const morning = new Date("2026-09-09T09:00:00.000Z");
    const evening = new Date("2026-09-09T19:00:00.000Z");
    const events: BaselineInputEvent[] = [
      evt(21),
      evt(14),
      { ...evt(0), id: "e-morning", occurredAt: morning },
      { ...evt(0), id: "e-evening", occurredAt: evening },
      evt(0),
    ];

    const baseline = computeBaseline(events, NOW);

    // Both same-day events are still present as inputs...
    expect(baseline.observationCount).toBe(5);
    // ...but that Tuesday counts once for cadence.
    expect(baseline.statisticalDayCount).toBe(4);
    expect(utcDayKey(morning)).toBe(utcDayKey(evening));
  });
});

describe("ACTIVE — a steady rhythm", () => {
  it("computes the documented example series", () => {
    // day 0, 7, 14, 22, 28 -> gaps [7,7,8,6]
    const start = new Date("2026-08-19T10:00:00.000Z");
    const events = [0, 7, 14, 22, 28].map((offset) => ({
      ...evt(0),
      id: `e-series-${offset}`,
      occurredAt: new Date(start.getTime() + offset * 86_400_000),
    }));

    const baseline = computeBaseline(events, NOW);

    expect(baseline.gaps).toEqual([7, 7, 8, 6]);
    expect(baseline.spanDays).toBe(28);
    expect(baseline.medianGapDays).toBe(7);
    expect(baseline.madDays).toBe(0.5);
    expect(baseline.status).toBe("ACTIVE");
  });

  it("a perfectly weekly series has zero dispersion", () => {
    const baseline = computeBaseline(series([28, 21, 14, 7, 0]), NOW);
    expect(baseline.medianGapDays).toBe(7);
    expect(baseline.madDays).toBe(0);
    expect(baseline.dispersion).toBe(0);
    expect(baseline.status).toBe("ACTIVE");
    // Derived on demand, never stored (docs/03 section 10.1).
    expect(computeCadenceThreshold(baseline.medianGapDays!, baseline.madDays!)).toBe(11);
  });
});

describe("IRREGULAR — evidence without rhythm", () => {
  it("is returned when dispersion exceeds the limit", () => {
    // gaps [2,30,3,40] -> median 16.5, deviations [14.5,13.5,13.5,23.5],
    // MAD 14 -> dispersion 0.85 > 0.8
    const baseline = computeBaseline(series([75, 35, 32, 2, 0]), NOW);
    expect(baseline.gaps).toEqual([40, 3, 30, 2]);
    expect(baseline.status).toBe("IRREGULAR");
    expect(baseline.dispersion!).toBeGreaterThan(baselineConfig.maxDispersion);
  });

  it("publishes no threshold, because there is no rhythm to depart from", () => {
    const baseline = computeBaseline(series([75, 35, 32, 2, 0]), NOW);
    expect(baseline.status).toBe("IRREGULAR");
    // The statistics are still reported, for the debug view.
    expect(baseline.medianGapDays).not.toBeNull();
    expect(baseline.madDays).not.toBeNull();
  });
});

describe("cadence threshold", () => {
  it("pins the canonical example: median 7, MAD 1 -> 11", () => {
    // median + 2*MAD = 9 | median * 1.5 = 10.5 | median + 4 = 11 | floor 7
    expect(computeCadenceThreshold(7, 1)).toBe(11);
  });

  it("each of the four terms can be the binding maximum", () => {
    // MAD term binds: median 10, MAD 6 -> 22 vs 15 vs 14 vs 7
    expect(computeCadenceThreshold(10, 6)).toBe(22);
    // median * 1.5 binds: median 30, MAD 0 -> 30 vs 45 vs 34 vs 7
    expect(computeCadenceThreshold(30, 0)).toBe(45);
    // median + 4 binds: median 7, MAD 0 -> 7 vs 10.5 vs 11 vs 7
    expect(computeCadenceThreshold(7, 0)).toBe(11);
    // absolute floor binds: median 1, MAD 0 -> 1 vs 1.5 vs 5 vs 7
    expect(computeCadenceThreshold(1, 0)).toBe(7);
  });

  it("never drops below the absolute floor", () => {
    for (const m of [0.5, 1, 2, 3]) {
      expect(computeCadenceThreshold(m, 0)).toBeGreaterThanOrEqual(baselineConfig.absoluteFloorDays);
    }
  });
});

describe("recency does not invalidate a historical rhythm (R4)", () => {
  it("stays ACTIVE as `now` moves forward over a long silence", () => {
    const events = series([56, 49, 42, 35, 28]); // weekly, ending 28 days ago
    const atTheTime = computeBaseline(events, NOW);
    expect(atTheTime.status).toBe("ACTIVE");

    for (const extraDays of [7, 30, 60, 100]) {
      const later = new Date(NOW.getTime() + extraDays * 86_400_000);
      const baseline = computeBaseline(events, later);
      expect(baseline.status, `after ${extraDays} days of silence`).toBe("ACTIVE");
      expect(baseline.medianGapDays).toBe(atTheTime.medianGapDays);
      expect(baseline.inputsHash).toBe(atTheTime.inputsHash);
    }
  });

  it("only changes once events fall out of the lookback window", () => {
    const events = series([56, 49, 42, 35, 28]);
    // Far enough forward that the oldest events pass 180 days.
    const muchLater = new Date(NOW.getTime() + 160 * 86_400_000);
    const baseline = computeBaseline(events, muchLater);
    expect(baseline.observationCount).toBeLessThan(5);
  });

  it("never returns DORMANT or any status outside the frozen three", () => {
    for (const daysForward of [0, 30, 200]) {
      const baseline = computeBaseline(
        series([56, 49, 42, 35, 28]),
        new Date(NOW.getTime() + daysForward * 86_400_000),
      );
      expect(["NO_BASELINE", "IRREGULAR", "ACTIVE"]).toContain(baseline.status);
    }
  });
});

describe("determinism", () => {
  it("is independent of input ordering", () => {
    const events = series([28, 21, 14, 7, 0]);
    const shuffled = [events[3], events[0], events[4], events[2], events[1]];
    const a = computeBaseline(events, NOW);
    const b = computeBaseline(shuffled, NOW);

    expect(b.inputsHash).toBe(a.inputsHash);
    expect(b.gaps).toEqual(a.gaps);
    expect(b.status).toBe(a.status);
    expect(b.medianGapDays).toBe(a.medianGapDays);
  });

  it("gives the same inputs_hash for the same effective event set", () => {
    const base = series([28, 21, 14, 7]);
    // Adding rows that are filtered out cannot change the hash.
    const withNoise = [
      ...base,
      evt(10, { polarity: "absence" }),
      evt(11, { certainty: 0.1 }),
      evt(12, { occurredAtPrecision: "unknown" }),
    ];
    expect(computeBaseline(withNoise, NOW).inputsHash).toBe(computeBaseline(base, NOW).inputsHash);
  });

  it("changes the hash when a same-day event is ADDED, even though the statistics do not move", () => {
    const base = series([28, 21, 14, 7, 0]);
    const withExtraSameDay = [
      ...base,
      evt(7, { id: "e-7-second", occurredAt: new Date(NOW.getTime() - 7 * 86_400_000 + 3_600_000) }),
    ];

    const a = computeBaseline(base, NOW);
    const b = computeBaseline(withExtraSameDay, NOW);

    // The statistics are untouched: that day already counted once.
    expect(b.gaps).toEqual(a.gaps);
    expect(b.medianGapDays).toBe(a.medianGapDays);
    expect(b.madDays).toBe(a.madDays);
    expect(b.statisticalDayCount).toBe(a.statisticalDayCount);
    // But the evidence set moved, so the provenance must say so.
    expect(b.observationCount).toBe(a.observationCount + 1);
    expect(b.inputsHash).not.toBe(a.inputsHash);
  });

  it("changes the hash when the effective day set changes", () => {
    const a = computeBaseline(series([28, 21, 14, 7]), NOW);
    const b = computeBaseline(series([28, 21, 14, 6]), NOW);
    expect(b.inputsHash).not.toBe(a.inputsHash);
  });
});

describe("day arithmetic", () => {
  it("counts whole UTC days across a DST boundary", () => {
    // Europe/London springs forward on 2026-03-29.
    const before = new Date("2026-03-27T23:30:00.000Z");
    const after = new Date("2026-03-31T00:30:00.000Z");
    expect(daysBetween(before, after)).toBe(4);
  });
});
