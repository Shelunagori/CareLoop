import { describe, expect, it } from "vitest";
import {
  DEFAULT_OPENING_QUESTION,
  composeOpening,
  greetingWord,
  timeOfDay,
} from "@/core/opening/greeting";

/**
 * The opening, at every hour, without touching the machine's clock.
 *
 * The hour is an ARGUMENT here and comes from the browser in the product
 * (`useLocalHour`), which is the same decision twice: the server's timezone
 * is not the person's, and a test that reads the real clock passes in the
 * afternoon and fails in the morning.
 */
describe("1. the buckets", () => {
  it.each([
    [5, "morning"], [8, "morning"], [11, "morning"],
    [12, "afternoon"], [15, "afternoon"], [16, "afternoon"],
    [17, "evening"], [20, "evening"], [23, "evening"],
    [0, "night"], [3, "night"], [4, "night"],
  ] as const)("%i is %s", (hour, expected) => {
    expect(timeOfDay(hour)).toBe(expected);
  });

  it("covers all 24 hours with no gap", () => {
    for (let hour = 0; hour < 24; hour += 1) {
      expect(["morning", "afternoon", "evening", "night"]).toContain(timeOfDay(hour));
    }
  });

  it("is total — a nonsense hour is not a crash", () => {
    expect(timeOfDay(Number.NaN)).toBe("night");
    expect(timeOfDay(99)).toBe("night");
    expect(timeOfDay(-1)).toBe("night");
  });

  it("says Hello rather than calling 3am a good one", () => {
    expect(greetingWord("night")).toBe("Hello");
    expect(greetingWord("morning")).toBe("Good morning");
    expect(greetingWord("afternoon")).toBe("Good afternoon");
    expect(greetingWord("evening")).toBe("Good evening");
  });
});

describe("2. composing the sentence", () => {
  it("greets by name and asks how they are, with nothing remembered", () => {
    expect(composeOpening({ hour: 9, displayName: "George" })).toBe(
      "Good morning, George. How are you doing?",
    );
  });

  it("carries the memory question when the server supplied one", () => {
    expect(
      composeOpening({
        hour: 19,
        displayName: "George",
        openingLine: "How did the visit with John go yesterday?",
      }),
    ).toBe("Good evening, George. How did the visit with John go yesterday?");
  });

  it("drops the name cleanly rather than leaving a comma", () => {
    expect(composeOpening({ hour: 14 })).toBe("Good afternoon. How are you doing?");
    expect(composeOpening({ hour: 14, displayName: "   " })).toBe(
      "Good afternoon. How are you doing?",
    );
    expect(composeOpening({ hour: 14, displayName: null })).not.toContain(",");
  });

  it("cannot manufacture a memory", () => {
    // The only inputs are an hour, a name and a sentence somebody else
    // already decided was safe. An empty one falls back to a question
    // about NOW — never to an invented event.
    for (const line of [null, undefined, "", "   "]) {
      expect(composeOpening({ hour: 8, displayName: "George", openingLine: line })).toBe(
        `Good morning, George. ${DEFAULT_OPENING_QUESTION}`,
      );
    }
  });

  it("is one sentence pair at every hour, for a named and an unnamed person", () => {
    for (let hour = 0; hour < 24; hour += 1) {
      for (const name of ["George", null]) {
        const text = composeOpening({ hour, displayName: name });
        expect(text).toMatch(/^(Good morning|Good afternoon|Good evening|Hello)/);
        expect(text.endsWith(DEFAULT_OPENING_QUESTION)).toBe(true);
        expect(text).not.toContain("  ");
        expect(text).not.toContain(", .");
      }
    }
  });
});
