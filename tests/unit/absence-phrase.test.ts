import { describe, expect, it } from "vitest";
import {
  MAX_STATED_PHRASE_LENGTH,
  recoverStatedAbsencePhrase,
} from "@/core/memory/absence-phrase";
import { EMPTY_EXTRACTION, type ExtractionV1, type InteractionClaim } from "@/core/memory/extraction-contract";
import { resolveAbsenceWindow } from "@/core/memory/temporal";

/**
 * Provenance for an absence window.
 *
 * The point of these tests is one word: "quoted". A field that claims to hold
 * the person's words must hold them or be absent. Everything here is about
 * recovering the real phrase when it is recoverable and refusing to invent one
 * when it is not.
 */
const REPORTED_AT = new Date("2026-09-16T12:00:00.000Z");

function claim(overrides: Partial<InteractionClaim> = {}): InteractionClaim {
  return {
    participantMention: "John",
    eventType: "visit",
    polarity: "absence",
    temporal: { expression: "last week", absoluteDate: null },
    certainty: 0.9,
    sourceSpan: "I haven't seen John last week",
    ...overrides,
  };
}

function payload(claims: InteractionClaim[]): ExtractionV1 {
  return { ...EMPTY_EXTRACTION, interactions: claims };
}

/** The window the deterministic resolver produces for a phrase. */
function windowFor(expression: string) {
  const window = resolveAbsenceWindow({
    claim: { expression, absoluteDate: null },
    referenceAt: REPORTED_AT,
  });
  if (!window) throw new Error(`no window for ${expression}`);
  return window;
}

describe("1. the real phrase is recovered when it is there", () => {
  it("returns the person's own words", () => {
    const window = windowFor("last week");
    expect(
      recoverStatedAbsencePhrase({
        extraction: payload([claim()]),
        eventType: "visit",
        windowStart: window.start,
        windowEnd: window.end,
        reportedAt: REPORTED_AT,
      }),
    ).toBe("last week");
  });

  it("works for a same-day phrase too", () => {
    const window = windowFor("this week");
    expect(
      recoverStatedAbsencePhrase({
        extraction: payload([claim({ temporal: { expression: "this week", absoluteDate: null } })]),
        eventType: "visit",
        windowStart: window.start,
        windowEnd: window.end,
        reportedAt: REPORTED_AT,
      }),
    ).toBe("this week");
  });

  it("picks the claim whose resolved window actually matches", () => {
    const window = windowFor("last week");
    const phrase = recoverStatedAbsencePhrase({
      extraction: payload([
        claim({ temporal: { expression: "this week", absoluteDate: null } }),
        claim(),
      ]),
      eventType: "visit",
      windowStart: window.start,
      windowEnd: window.end,
      reportedAt: REPORTED_AT,
    });
    expect(phrase).toBe("last week");
  });
});

describe("2. it refuses to invent one", () => {
  const window = windowFor("last week");
  const base = {
    eventType: "visit" as const,
    windowStart: window.start,
    windowEnd: window.end,
    reportedAt: REPORTED_AT,
  };

  it("returns null when the observation carries no interactions", () => {
    expect(recoverStatedAbsencePhrase({ ...base, extraction: EMPTY_EXTRACTION })).toBeNull();
  });

  it("returns null when no claim resolves to the stored window", () => {
    expect(
      recoverStatedAbsencePhrase({
        ...base,
        extraction: payload([claim({ temporal: { expression: "yesterday", absoluteDate: null } })]),
      }),
    ).toBeNull();
  });

  it("returns null when two claims disagree about the wording", () => {
    // Both resolve to the same window; there is no basis to pick one.
    expect(
      recoverStatedAbsencePhrase({
        ...base,
        extraction: payload([
          claim({ temporal: { expression: "last week", absoluteDate: null } }),
          claim({ temporal: { expression: "a week ago", absoluteDate: null } }),
        ]),
      }),
    ).toBeNull();
  });

  it("collapses two identical phrases rather than calling them ambiguous", () => {
    expect(
      recoverStatedAbsencePhrase({
        ...base,
        extraction: payload([claim(), claim({ participantMention: "Simba" })]),
      }),
    ).toBe("last week");
  });

  it("ignores positive claims and the other event type", () => {
    expect(
      recoverStatedAbsencePhrase({
        ...base,
        extraction: payload([claim({ polarity: "positive" })]),
      }),
    ).toBeNull();
    expect(
      recoverStatedAbsencePhrase({ ...base, extraction: payload([claim({ eventType: "call" })]) }),
    ).toBeNull();
  });

  it("refuses a phrase long enough to be a smuggled sentence", () => {
    const long = "x".repeat(MAX_STATED_PHRASE_LENGTH + 1);
    // It still has to resolve to the window, so pair it with a real phrase's
    // absolute date; an unmatched phrase would be rejected for the wrong reason.
    expect(
      recoverStatedAbsencePhrase({
        ...base,
        extraction: payload([claim({ temporal: { expression: long, absoluteDate: null } })]),
      }),
    ).toBeNull();
  });

  it("returns null for a null expression, even when the window matches", () => {
    const absolute = windowFor("last week");
    expect(
      recoverStatedAbsencePhrase({
        extraction: payload([claim({ temporal: { expression: null, absoluteDate: null } })]),
        eventType: "visit",
        windowStart: absolute.start,
        windowEnd: absolute.end,
        reportedAt: REPORTED_AT,
      }),
    ).toBeNull();
  });
});
