import { describe, expect, it } from "vitest";
import {
  decideOpening,
  renderOpening,
  OPENING_CONFIG,
  type OpeningCandidate,
  type OpeningInput,
} from "@/core/opening/opening";

/**
 * One bounded proactive opening.
 *
 * The product claim is "not purely reactive". The engineering claim is
 * narrower and is what these tests defend: it happens at most once, only
 * about something the person themselves reported, only when nothing of
 * theirs is outstanding, and never as a greeting with nothing behind it.
 */
const NOW = new Date("2026-09-21T09:00:00.000Z");
const DAY = 86_400_000;

const candidate = (overrides: Partial<OpeningCandidate> = {}): OpeningCandidate => ({
  entityId: "entity-1",
  entityName: "Margaret",
  eventType: "visit",
  occurredAt: new Date(NOW.getTime() - DAY),
  occurredAtPrecision: "day",
  certainty: 0.9,
  polarity: "positive",
  ...overrides,
});

const decide = (overrides: Partial<OpeningInput> = {}) =>
  decideOpening({
    candidates: [candidate()],
    now: NOW,
    messagesInSitting: 0,
    openConsentFlow: false,
    unresolvedDraft: false,
    alreadySurfaced: false,
    ...overrides,
  });

describe("1. it opens about something they told us", () => {
  it("picks yesterday's visit", () => {
    const decision = decide();
    expect(decision).toEqual({
      open: true,
      entityId: "entity-1",
      entityName: "Margaret",
      eventType: "visit",
      daysAgo: 1,
    });
  });

  it("asks, in a sentence built only from the decision", () => {
    const decision = decide();
    if (!decision.open) throw new Error("expected an opening");
    expect(renderOpening(decision)).toBe("How did the visit with Margaret go yesterday?");
  });

  it("knows a call from a visit", () => {
    const decision = decide({ candidates: [candidate({ eventType: "call" })] });
    if (!decision.open) throw new Error("expected an opening");
    expect(renderOpening(decision)).toBe("How was your call with Margaret yesterday?");
  });

  it("says when, from the number and not from a guess", () => {
    for (const [days, when] of [[1, "yesterday"], [2, "the day before yesterday"], [3, "3 days ago"]] as const) {
      const decision = decide({
        candidates: [candidate({ occurredAt: new Date(NOW.getTime() - days * DAY) })],
      });
      if (!decision.open) throw new Error("expected an opening");
      expect(renderOpening(decision)).toContain(when);
    }
  });

  it("asserts nothing about how it went, or about them", () => {
    const decision = decide();
    if (!decision.open) throw new Error("expected an opening");
    const line = renderOpening(decision);
    for (const leak of [/lovely/i, /lonely/i, /miss/i, /usually/i, /\d+ (times|weeks)/i, /worried/i]) {
      expect(line, String(leak)).not.toMatch(leak);
    }
  });
});

describe("2. the freshness window", () => {
  it("says nothing about today — 'how did it go' about this morning is presumptuous", () => {
    const decision = decide({ candidates: [candidate({ occurredAt: NOW })] });
    expect(decision).toEqual({ open: false, reason: "no_candidate" });
  });

  it("says nothing about last week", () => {
    const stale = candidate({ occurredAt: new Date(NOW.getTime() - 9 * DAY) });
    expect(decide({ candidates: [stale] })).toEqual({ open: false, reason: "no_candidate" });
  });

  it("the window is a reviewable pair of numbers", () => {
    expect(OPENING_CONFIG).toEqual({ minAgeDays: 1, maxAgeDays: 3 });
  });
});

describe("3. what may never power it", () => {
  const refused: ReadonlyArray<[Partial<OpeningCandidate>, string]> = [
    [{ polarity: "absence" }, "an absence assertion"],
    [{ polarity: "negative" }, "a negative event"],
    [{ certainty: 0.4 }, "a low-certainty guess"],
    [{ occurredAtPrecision: "week" }, "a vague date"],
    [{ occurredAtPrecision: "unknown" }, "no date at all"],
    [{ entityName: "   " }, "an unusable label"],
  ];
  it.each(refused)("refuses %s", (overrides) => {
    expect(decide({ candidates: [candidate(overrides)] })).toEqual({
      open: false,
      reason: "no_candidate",
    });
  });

  it("raising somebody's ABSENCE as a greeting is the thing this must never be", () => {
    // Called out separately because it is the one failure that would make
    // the product feel like surveillance rather than company.
    const absence = candidate({ polarity: "absence" });
    expect(decide({ candidates: [absence] }).open).toBe(false);
  });

  it("uses the baseline's own certainty floor, not one of its own", async () => {
    const { baselineConfig } = await import("@/core/baseline/config");
    const atFloor = candidate({ certainty: baselineConfig.minCertainty });
    const below = candidate({ certainty: baselineConfig.minCertainty - 0.01 });
    expect(decide({ candidates: [atFloor] }).open).toBe(true);
    expect(decide({ candidates: [below] }).open).toBe(false);
  });
});

describe("4. it never interrupts", () => {
  const blocked: ReadonlyArray<[Partial<OpeningInput>, string]> = [
    [{ messagesInSitting: 1 }, "conversation_already_underway"],
    [{ openConsentFlow: true }, "open_consent_flow"],
    [{ unresolvedDraft: true }, "unresolved_draft"],
    [{ alreadySurfaced: true }, "already_surfaced"],
  ];
  it.each(blocked)("stays quiet for %j", (overrides, reason) => {
    expect(decide(overrides)).toEqual({ open: false, reason });
  });

  it("at most one per session, whatever else is true", () => {
    expect(decide({ alreadySurfaced: true, candidates: [candidate(), candidate()] })).toEqual({
      open: false,
      reason: "already_surfaced",
    });
  });
});

describe("5. no genuinely useful context means a normal start", () => {
  it("an empty candidate list opens nothing", () => {
    expect(decide({ candidates: [] })).toEqual({ open: false, reason: "no_candidate" });
  });

  it("there is no path to a contentless greeting", () => {
    // `renderOpening` takes an open decision, and an open decision requires
    // an eligible event. "Good morning, how are you?" is unreachable, which
    // is stronger than a rule against writing it.
    const decision = decide({ candidates: [] });
    expect(decision.open).toBe(false);
    // And the TYPE refuses a closed decision, which is stronger than a rule
    // against writing a contentless greeting: there is nothing to render.
    if (decision.open) renderOpening(decision);
  });
});

describe("6. the choice is deterministic", () => {
  it("prefers the most recent, and breaks ties stably", () => {
    const older = candidate({ entityId: "b", entityName: "Alan", occurredAt: new Date(NOW.getTime() - 3 * DAY) });
    const newer = candidate({ entityId: "a", entityName: "Margaret", occurredAt: new Date(NOW.getTime() - DAY) });
    expect(decide({ candidates: [older, newer] })).toMatchObject({ entityName: "Margaret" });
    expect(decide({ candidates: [newer, older] })).toMatchObject({ entityName: "Margaret" });
  });

  it("two on the same day resolve the same way every run", () => {
    const a = candidate({ entityId: "aaa", entityName: "Alan" });
    const b = candidate({ entityId: "bbb", entityName: "Margaret" });
    expect(decide({ candidates: [a, b] })).toMatchObject({ entityId: "aaa" });
    expect(decide({ candidates: [b, a] })).toMatchObject({ entityId: "aaa" });
  });
});
