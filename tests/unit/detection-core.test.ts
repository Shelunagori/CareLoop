import { describe, expect, it } from "vitest";
import { computeBaseline, computeCadenceThreshold, type BaselineInputEvent } from "@/core/baseline/compute";
import { DAY_MS } from "@/core/baseline/day";
import { detectCadenceGap, lastQualifyingEvent } from "@/core/detection/cadence";
import { detectAssertedAbsence } from "@/core/detection/absence";
import { DISCARD_REASONS, resolveDetections } from "@/core/detection/detect";
import { buildProposal } from "@/core/detection/proposal";
import type { CadenceExplanation, AbsenceExplanation } from "@/core/detection/types";

const NOW = new Date("2026-09-16T12:00:00.000Z");
const ENTITY = "entity-john";

/**
 * Gaps [5, 7, 7, 9] -> median 7, MAD 1, and therefore the canonical
 * threshold of 11 (max of 7+2*1, 7*1.5, 7+4, 7). `lastDaysAgo` moves the
 * whole series so elapsed time is the only thing under test.
 */
function series(lastDaysAgo: number): BaselineInputEvent[] {
  const offsets = [lastDaysAgo + 28, lastDaysAgo + 23, lastDaysAgo + 16, lastDaysAgo + 9, lastDaysAgo];
  return offsets.map((daysAgo) => ({
    id: `ev-${daysAgo}`,
    occurredAt: new Date(NOW.getTime() - daysAgo * DAY_MS),
    occurredAtPrecision: "day" as const,
    certainty: 0.9,
    polarity: "positive" as const,
  }));
}

function cadenceFor(lastDaysAgo: number, conversationId: string | null = "conv-1") {
  const events = series(lastDaysAgo);
  const baseline = computeBaseline(events, NOW);
  return {
    baseline,
    candidate: detectCadenceGap({
      entityId: ENTITY,
      eventType: "visit",
      baseline,
      events,
      now: NOW,
      conversationId,
    }),
  };
}

function absenceEvent(overrides: Partial<Parameters<typeof detectAssertedAbsence>[0]["event"]> = {}) {
  return {
    id: "abs-1",
    entityId: ENTITY,
    eventType: "visit" as const,
    polarity: "absence" as const,
    windowStart: new Date(NOW.getTime() - 7 * DAY_MS),
    windowEnd: NOW,
    reportedAt: NOW,
    certainty: 0.9,
    statedPhrase: null,
    ...overrides,
  };
}

describe("1. the canonical cadence arithmetic", () => {
  it("produces median 7, MAD 1, threshold 11", () => {
    const { baseline } = cadenceFor(13);
    expect(baseline.status).toBe("ACTIVE");
    expect(baseline.medianGapDays).toBe(7);
    expect(baseline.madDays).toBe(1);
    expect(computeCadenceThreshold(7, 1)).toBe(11);
  });

  it("11 days does not fire — the threshold is a strict boundary", () => {
    expect(cadenceFor(11).candidate).toBeNull();
  });

  it("12 days fires", () => {
    const { candidate } = cadenceFor(12);
    expect(candidate).not.toBeNull();
    const explanation = candidate!.explanation as CadenceExplanation;
    expect(explanation.daysSinceLast).toBe(12);
    expect(explanation.thresholdDays).toBe(11);
  });

  it("13 days fires, and the explanation is structured evidence only", () => {
    const { candidate } = cadenceFor(13);
    const explanation = candidate!.explanation as CadenceExplanation;
    expect(explanation).toMatchObject({
      detector: "cadence_gap",
      methodVersion: "detection.v1",
      eventType: "visit",
      medianGapDays: 7,
      madDays: 1,
      thresholdDays: 11,
      daysSinceLast: 13,
      contributingEventCount: 5,
      conversationId: "conv-1",
    });
    expect(explanation.lastEventDate).toBe("2026-09-03");
    expect(explanation.baselineInputsHash).toHaveLength(32);
    // No prose, no affect, no interpretation anywhere in the payload.
    const serialized = JSON.stringify(explanation).toLowerCase();
    for (const word of ["lonely", "isolated", "sad", "worried", "decline", "risk", "concern"]) {
      expect(serialized).not.toContain(word);
    }
  });
});

describe("1b. the live acceptance series (dev preset `cadence-gap`)", () => {
  /**
   * The exact offsets POST /api/dev/seed-events writes for the `cadence-gap`
   * preset. Pinned here because the demo margin is deliberately two days: a
   * threshold regression has to break this loudly rather than quietly widen
   * the tolerance (R5).
   */
  const PRESET_OFFSETS = [48, 41, 34, 27, 20, 13];

  function presetSeries(): BaselineInputEvent[] {
    return PRESET_OFFSETS.map((daysAgo) => ({
      id: `seed-${daysAgo}`,
      occurredAt: new Date(NOW.getTime() - daysAgo * DAY_MS),
      occurredAtPrecision: "day" as const,
      certainty: 0.9,
      polarity: "positive" as const,
    }));
  }

  it("is ACTIVE with median 7, MAD 0 and a threshold of 11", () => {
    const baseline = computeBaseline(presetSeries(), NOW);
    expect(baseline.status).toBe("ACTIVE");
    expect(baseline.gaps).toEqual([7, 7, 7, 7, 7]);
    expect(baseline.medianGapDays).toBe(7);
    expect(baseline.madDays).toBe(0);
    expect(computeCadenceThreshold(7, 0)).toBe(11);
  });

  it("fires at 13 days, with the last event on 2026-09-03", () => {
    const events = presetSeries();
    const baseline = computeBaseline(events, NOW);
    const candidate = detectCadenceGap({
      entityId: ENTITY, eventType: "visit", baseline, events, now: NOW, conversationId: null,
    });
    expect(candidate).not.toBeNull();
    expect(candidate!.explanation as CadenceExplanation).toMatchObject({
      medianGapDays: 7,
      madDays: 0,
      thresholdDays: 11,
      daysSinceLast: 13,
      lastEventDate: "2026-09-03",
      contributingEventCount: 6,
    });
  });

  it("the margin is two days: 11 would not fire, 12 would", () => {
    const shifted = (extraDays: number) =>
      PRESET_OFFSETS.map((daysAgo) => ({
        id: `seed-${daysAgo}`,
        occurredAt: new Date(NOW.getTime() - (daysAgo - extraDays) * DAY_MS),
        occurredAtPrecision: "day" as const,
        certainty: 0.9,
        polarity: "positive" as const,
      }));
    for (const [extraDays, fires] of [[2, false], [1, true], [0, true]] as const) {
      const events = shifted(extraDays);
      const baseline = computeBaseline(events, NOW);
      const candidate = detectCadenceGap({
        entityId: ENTITY, eventType: "visit", baseline, events, now: NOW, conversationId: null,
      });
      expect(candidate !== null, `daysSinceLast ${13 - extraDays}`).toBe(fires);
    }
  });
});

describe("2. the cadence detector refuses to run without a rhythm", () => {
  it("NO_BASELINE produces no signal", () => {
    const events = series(30).slice(0, 2);
    const baseline = computeBaseline(events, NOW);
    expect(baseline.status).toBe("NO_BASELINE");
    expect(
      detectCadenceGap({ entityId: ENTITY, eventType: "visit", baseline, events, now: NOW, conversationId: null }),
    ).toBeNull();
  });

  it("IRREGULAR produces no signal even with a long gap", () => {
    // gaps [45, 40, 2, 1] -> median 21, MAD 21.5, dispersion 1.02 > 0.8.
    const offsets = [128, 83, 43, 41, 40];
    const events = offsets.map((daysAgo) => ({
      id: `ev-${daysAgo}`,
      occurredAt: new Date(NOW.getTime() - daysAgo * DAY_MS),
      occurredAtPrecision: "day" as const,
      certainty: 0.9,
      polarity: "positive" as const,
    }));
    const baseline = computeBaseline(events, NOW);
    expect(baseline.status).toBe("IRREGULAR");
    expect(
      detectCadenceGap({ entityId: ENTITY, eventType: "visit", baseline, events, now: NOW, conversationId: null }),
    ).toBeNull();
  });
});

describe("3. the cadence detector ignores evidence the statistics ignored", () => {
  it("an absence assertion does not reset the clock", () => {
    const events = series(13);
    const baseline = computeBaseline(events, NOW);
    const withAbsence = [
      ...events,
      {
        id: "abs-row",
        occurredAt: new Date(NOW.getTime() - 1 * DAY_MS),
        occurredAtPrecision: "day" as const,
        certainty: 0.95,
        polarity: "absence" as const,
      },
    ];
    const candidate = detectCadenceGap({
      entityId: ENTITY, eventType: "visit", baseline, events: withAbsence, now: NOW, conversationId: null,
    });
    expect((candidate!.explanation as CadenceExplanation).daysSinceLast).toBe(13);
  });

  it("a low-certainty or imprecise event does not reset the clock", () => {
    const events = series(13);
    const baseline = computeBaseline(events, NOW);
    const noisy = [
      ...events,
      { id: "maybe", occurredAt: new Date(NOW.getTime() - DAY_MS), occurredAtPrecision: "day" as const, certainty: 0.3, polarity: "positive" as const },
      { id: "vague", occurredAt: new Date(NOW.getTime() - DAY_MS), occurredAtPrecision: "unknown" as const, certainty: 0.99, polarity: "positive" as const },
    ];
    const candidate = detectCadenceGap({
      entityId: ENTITY, eventType: "visit", baseline, events: noisy, now: NOW, conversationId: null,
    });
    expect((candidate!.explanation as CadenceExplanation).daysSinceLast).toBe(13);
  });

  it("a future-dated event produces no nonsense signal", () => {
    const events = series(13);
    const baseline = computeBaseline(events, NOW);
    const future = [
      ...events,
      { id: "tomorrow", occurredAt: new Date(NOW.getTime() + 5 * DAY_MS), occurredAtPrecision: "day" as const, certainty: 0.9, polarity: "positive" as const },
    ];
    expect(lastQualifyingEvent(future, NOW)!.id).not.toBe("tomorrow");
    const candidate = detectCadenceGap({
      entityId: ENTITY, eventType: "visit", baseline, events: future, now: NOW, conversationId: null,
    });
    expect((candidate!.explanation as CadenceExplanation).daysSinceLast).toBe(13);
  });

  it("no qualifying event at all produces no signal", () => {
    const baseline = computeBaseline(series(13), NOW);
    expect(
      detectCadenceGap({ entityId: ENTITY, eventType: "visit", baseline, events: [], now: NOW, conversationId: null }),
    ).toBeNull();
  });
});

describe("4. cadence identity is evidence, never a timestamp", () => {
  it("the same evidence examined twice yields the same key", () => {
    expect(cadenceFor(13).candidate!.detectionKey).toBe(cadenceFor(13).candidate!.detectionKey);
  });

  it("a different conversation does not change the key", () => {
    expect(cadenceFor(13, "conv-a").candidate!.detectionKey).toBe(
      cadenceFor(13, "conv-b").candidate!.detectionKey,
    );
  });

  it("more elapsed time alone does not change the key", () => {
    const events = series(13);
    const baseline = computeBaseline(events, NOW);
    const later = new Date(NOW.getTime() + 3 * DAY_MS);
    const a = detectCadenceGap({ entityId: ENTITY, eventType: "visit", baseline, events, now: NOW, conversationId: null });
    const b = detectCadenceGap({ entityId: ENTITY, eventType: "visit", baseline, events, now: later, conversationId: null });
    expect(b!.detectionKey).toBe(a!.detectionKey);
    expect((b!.explanation as CadenceExplanation).daysSinceLast).toBe(16);
  });

  it("new evidence DOES change the key", () => {
    expect(cadenceFor(13).candidate!.detectionKey).not.toBe(cadenceFor(14).candidate!.detectionKey);
  });
});

describe("5. the absence detector works with any baseline, or none", () => {
  it("fires with NO_BASELINE and makes no pattern claim", () => {
    const candidate = detectAssertedAbsence({
      event: absenceEvent(), baseline: null, now: NOW, conversationId: "conv-1",
    });
    expect(candidate).not.toBeNull();
    const explanation = candidate!.explanation as AbsenceExplanation;
    expect(explanation.detector).toBe("user_asserted_absence");
    expect(explanation.sourceEventId).toBe("abs-1");
    expect(explanation.baseline).toBeNull();

    const proposal = buildProposal({
      explanation, entityName: "John", alsoMention: [], baseline: null,
    });
    expect(proposal.pattern).toBeUndefined();
    // The resolved window, named as what it is. No `quotedWindow`, because
    // nobody said "2026-09-09 to 2026-09-16".
    expect(proposal.observation).toEqual({
      kind: "user_stated_absence",
      window: {
        start: new Date(NOW.getTime() - 7 * DAY_MS).toISOString(),
        end: NOW.toISOString(),
      },
    });
    expect(proposal.observation).not.toHaveProperty("statedPhrase");
    expect(JSON.stringify(proposal)).not.toContain("quotedWindow");
  });

  it("fires with an ACTIVE baseline and attaches it for phrasing", () => {
    const baseline = computeBaseline(series(13), NOW);
    const candidate = detectAssertedAbsence({
      event: absenceEvent(), baseline, now: NOW, conversationId: null,
    });
    const explanation = candidate!.explanation as AbsenceExplanation;
    expect(explanation.baseline).toEqual({
      status: "ACTIVE", medianGapDays: 7, madDays: 1, inputsHash: baseline.inputsHash,
    });
    const proposal = buildProposal({ explanation, entityName: "John", alsoMention: [], baseline });
    expect(proposal.pattern).toEqual({ medianGapDays: 7 });
  });

  it("refuses a positive event, a missing window, or a low certainty", () => {
    const base = { baseline: null, now: NOW, conversationId: null };
    expect(detectAssertedAbsence({ ...base, event: absenceEvent({ polarity: "positive" }) })).toBeNull();
    expect(detectAssertedAbsence({ ...base, event: absenceEvent({ windowEnd: null }) })).toBeNull();
    expect(detectAssertedAbsence({ ...base, event: absenceEvent({ certainty: 0.4 }) })).toBeNull();
    expect(
      detectAssertedAbsence({
        ...base,
        event: absenceEvent({ windowStart: NOW, windowEnd: new Date(NOW.getTime() - DAY_MS) }),
      }),
    ).toBeNull();
  });

  it("refuses a report from the future", () => {
    expect(
      detectAssertedAbsence({
        event: absenceEvent({ reportedAt: new Date(NOW.getTime() + DAY_MS) }),
        baseline: null, now: NOW, conversationId: null,
      }),
    ).toBeNull();
  });

  it("identity is the source event, so the same row never re-fires", () => {
    const a = detectAssertedAbsence({ event: absenceEvent(), baseline: null, now: NOW, conversationId: null });
    const b = detectAssertedAbsence({
      event: absenceEvent(), baseline: computeBaseline(series(13), NOW),
      now: new Date(NOW.getTime() + 2 * DAY_MS), conversationId: "other",
    });
    expect(b!.detectionKey).toBe(a!.detectionKey);
  });
});

describe("6. precedence: the person's own words outrank our statistics", () => {
  const cadence = cadenceFor(13).candidate!;
  const absence = detectAssertedAbsence({
    event: absenceEvent(), baseline: null, now: NOW, conversationId: null,
  })!;

  it("absence wins, and the cadence candidate is discarded before persistence", () => {
    for (const input of [[cadence, absence], [absence, cadence]]) {
      const resolved = resolveDetections(input);
      expect(resolved.selected).toHaveLength(1);
      expect(resolved.selected[0].signalType).toBe("user_asserted_absence");
      expect(resolved.discarded).toHaveLength(1);
      expect(resolved.discarded[0].reason).toBe(DISCARD_REASONS.outrankedByAbsence);
      expect(resolved.discarded[0].winnerDetectionKey).toBe(absence.detectionKey);
    }
  });

  it("two entities each keep their own signal", () => {
    const other = { ...cadence, entityId: "entity-mary", detectionKey: "key-mary" };
    const resolved = resolveDetections([cadence, other]);
    expect(resolved.selected).toHaveLength(2);
    expect(resolved.discarded).toHaveLength(0);
  });

  it("two absences for one entity keep the newest, deterministically", () => {
    const older = detectAssertedAbsence({
      event: absenceEvent({ id: "abs-old", reportedAt: new Date(NOW.getTime() - 3 * DAY_MS) }),
      baseline: null, now: NOW, conversationId: null,
    })!;
    const resolved = resolveDetections([older, absence]);
    expect(resolved.selected[0].detectionKey).toBe(absence.detectionKey);
    expect(resolved.discarded[0].reason).toBe(DISCARD_REASONS.supersededByNewerEvidence);
  });
});
