import { describe, expect, it } from "vitest";
import {
  cadenceMayBePresented,
  currentSitting,
  type PresentationMessage,
} from "@/core/detection/presentation";
import { detectionConfig } from "@/core/detection/config";

/**
 * When a cadence-only offer is allowed to interrupt.
 *
 * DETECTION IS NOT PRESENTATION. Nothing here touches the detector; the
 * signal is found and materialized exactly as before. This decides only
 * whether now is the moment, and a "no" spends nothing.
 *
 * The transcripts below are the ones actually observed in the browser. They
 * are the specification.
 */
const C = detectionConfig;
const START = new Date("2026-09-21T10:00:00.000Z").getTime();
const MINUTE = 60_000;

/** A transcript, one message a minute unless a gap is given. */
function transcript(
  lines: ReadonlyArray<[role: string, content: string, gapMinutesBefore?: number]>,
): PresentationMessage[] {
  let at = START;
  return lines.map(([role, content, gap]) => {
    at += (gap ?? 1) * MINUTE;
    return { role, content, createdAt: new Date(at).toISOString() };
  });
}

const smalltalk = transcript([
  ["user", "hello"],
  ["assistant", "Hello. Good to hear from you."],
  ["user", "good and u"],
  ["assistant", "I'm glad you're doing well."],
  ["user", "how are you doing?"],
  ["assistant", "Getting on fine. What's your day looking like?"],
  ["user", "I am doing good what about you?"],
]);

const underway = transcript([
  ["user", "Morning. I finally got out into the garden yesterday afternoon."],
  ["assistant", "That sounds lovely. How was it out there?"],
  ["user", "Warm enough for a cup of tea on the bench, which was a treat."],
  ["assistant", "A good spot for one."],
  ["user", "The roses have come back much better than I expected this year."],
]);

describe("1. the observed transcript stays ordinary conversation", () => {
  it("does not present after 'hello' / 'good and u'", () => {
    const verdict = cadenceMayBePresented(smalltalk.slice(0, 3));
    expect(verdict.present).toBe(false);
  });

  it("does not present after the full four-turn greeting exchange either", () => {
    // Four turns clears a turn count of 3. Sixty-four characters does not
    // clear the substance bar, which is exactly why there are two.
    const verdict = cadenceMayBePresented(smalltalk);
    expect(verdict.present).toBe(false);
    if (verdict.present) return;
    expect(verdict.userTurns).toBe(4);
    expect(verdict.userCharacters).toBeLessThan(C.minUserCharactersBeforeCadenceOffer);
  });

  it("raising the turn count alone would NOT have fixed it", () => {
    // Recorded as a fact about the fix, not as a preference: the previous
    // rule was turns only, and this transcript passes any turn threshold a
    // greeting exchange can reach.
    const turnsOnly = { ...C, minUserCharactersBeforeCadenceOffer: 0 };
    expect(cadenceMayBePresented(smalltalk, turnsOnly).present).toBe(true);
  });
});

describe("2. a conversation genuinely underway does present", () => {
  it("passes both bars", () => {
    const verdict = cadenceMayBePresented(underway);
    expect(verdict.present).toBe(true);
    if (!verdict.present) return;
    expect(verdict.userTurns).toBeGreaterThanOrEqual(C.minUserTurnsBeforeCadenceOffer);
    expect(verdict.userCharacters).toBeGreaterThanOrEqual(C.minUserCharactersBeforeCadenceOffer);
  });

  it("but not while it is still only two turns in", () => {
    expect(cadenceMayBePresented(underway.slice(0, 3)).present).toBe(false);
  });
});

describe("3. a sitting, not a conversation row", () => {
  /**
   * The actual defect in the previous rule. CareLoop reopens the LATEST
   * conversation, so counting the row's lifetime meant the gate was
   * satisfied permanently after somebody's first visit — and the browser
   * report was somebody returning to a row they had used all day.
   */
  it("yesterday's turns do not count towards today's", () => {
    const yesterday = transcript([
      ["user", "I went to the market with Margaret and we were out for hours."],
      ["assistant", "That sounds like a good morning."],
      ["user", "It was. We had lunch afterwards at the little place by the church."],
    ]);
    const today: PresentationMessage[] = [
      ...yesterday,
      ...transcript([["user", "hello", 24 * 60]]),
    ];
    // The row has four user turns and plenty of characters.
    expect(currentSitting(today).userTurns).toBe(1);
    expect(cadenceMayBePresented(today).present).toBe(false);
  });

  it("a gap shorter than the threshold keeps one sitting", () => {
    const withPause: PresentationMessage[] = [
      ...underway.slice(0, 3),
      ...transcript([["user", "The roses have come back much better than I expected this year.", C.sittingGapMinutes - 5]]),
    ];
    expect(currentSitting(withPause).userTurns).toBe(3);
  });

  it("an unreadable timestamp ends the sitting — fail closed", () => {
    const broken: PresentationMessage[] = [
      { role: "user", content: "a long message ".repeat(20), createdAt: "not a date" },
      ...underway.slice(3),
    ];
    // Whatever is behind the unreadable row is not counted, so the gate can
    // only ever become MORE conservative, never less.
    expect(currentSitting(broken).userTurns).toBeLessThan(3);
  });
});

describe("4. only the person's own words count as substance", () => {
  it("a wall of assistant text does not open the gate", () => {
    const chatty = transcript([
      ["user", "hi"],
      ["assistant", "x".repeat(400)],
      ["user", "ok"],
      ["assistant", "y".repeat(400)],
      ["user", "mm"],
    ]);
    expect(cadenceMayBePresented(chatty).present).toBe(false);
  });

  it("whitespace is not substance", () => {
    const padded = transcript([
      ["user", "  hi   \n\n   "],
      ["assistant", "Hello."],
      ["user", "\t\tok\t"],
      ["assistant", "Mm."],
      ["user", " ".repeat(300)],
    ]);
    expect(currentSitting(padded).userCharacters).toBeLessThan(10);
  });
});

describe("5. the numbers are injectable and reviewable", () => {
  it("lives in detectionConfig beside the other pacing rules", () => {
    expect(C.minUserTurnsBeforeCadenceOffer).toBe(3);
    expect(C.minUserCharactersBeforeCadenceOffer).toBe(120);
    expect(C.sittingGapMinutes).toBe(30);
  });

  it("a different threshold is testable by passing one", () => {
    const lenient = { ...C, minUserTurnsBeforeCadenceOffer: 1, minUserCharactersBeforeCadenceOffer: 1 };
    expect(cadenceMayBePresented(smalltalk.slice(0, 1), lenient).present).toBe(true);
  });

  it("an empty transcript never presents", () => {
    expect(cadenceMayBePresented([]).present).toBe(false);
  });
});
