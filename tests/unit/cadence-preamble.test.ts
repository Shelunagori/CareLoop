import { describe, expect, it } from "vitest";
import { buildCadencePreamble, cadencePhrase, buildOfferBlock } from "@/core/share/offer";
import type { ReconnectProposal } from "@/core/detection/proposal";

/**
 * WHY a reconnect offer appeared, said by the application.
 *
 * Live observation: after "hello" and "good and u", CareLoop surfaced "I can
 * send John this message...". The detector was right — six visits, median 7
 * days, MAD 0, threshold 11, last visit 13 days ago — but the person was told
 * none of it. Correct proactivity that arrives without its reason reads as
 * arbitrary, and an older-adult product cannot afford to feel arbitrary.
 *
 * So the reason is now stated, and it is stated by THIS function: every word
 * of it is a stored value or a total mapping over one. The model does not
 * write it, is not shown it, and cannot alter it. What the model may still do
 * is the ordinary turn around it.
 */

const cadence = (overrides: Partial<ReconnectProposal> = {}): ReconnectProposal => ({
  entityId: "entity-john",
  entityName: "John",
  eventType: "visit",
  observation: { kind: "no_mention_since", days: 13 },
  pattern: { medianGapDays: 7 },
  question: "ask_if_visiting",
  ...overrides,
});

describe("1. the cadence phrase is a total mapping, not a judgement", () => {
  // One table, readable by someone who is not an engineer — the same reason
  // detectionConfig's numbers live in one file.
  it.each([
    [0.5, "most days"],
    [1, "most days"],
    [1.9, "most days"],
    [2, "every few days"],
    [3.5, "every few days"],
    [4, "about once a week"],
    [7, "about once a week"],
    [10.5, "about once a week"],
    [11, "about every couple of weeks"],
    [18, "about every couple of weeks"],
    [19, "about once a month"],
    [30, "about once a month"],
    [45, "about once a month"],
    [46, "about every 2 months"],
    [60, "about every 2 months"],
    [90, "about every 3 months"],
  ])("median %j days reads as %j", (median, phrase) => {
    expect(cadencePhrase(median)).toBe(phrase);
  });

  it("never claims a single month in the plural branch", () => {
    // round(46/30) is 2, but the boundary must not be able to produce
    // "about every 1 months" for any input that reaches it.
    for (let m = 46; m < 400; m += 0.5) {
      expect(cadencePhrase(m)).not.toMatch(/every 1 months|every 0 months/);
    }
  });
});

describe("2. the sentence is built from the stored proposal and nothing else", () => {
  it("states the rhythm and the elapsed time, for a visit", () => {
    expect(buildCadencePreamble(cadence())).toBe(
      "You usually see John about once a week, and it's been 13 days.",
    );
  });

  it("uses the right verb for a call", () => {
    expect(
      buildCadencePreamble(
        cadence({
          entityName: "Margaret",
          eventType: "call",
          question: "ask_if_calling",
          pattern: { medianGapDays: 14 },
          observation: { kind: "no_mention_since", days: 21 },
        }),
      ),
    ).toBe("You usually hear from Margaret about every couple of weeks, and it's been 21 days.");
  });

  it("says day, not days, at one", () => {
    expect(
      buildCadencePreamble(cadence({ observation: { kind: "no_mention_since", days: 1 } })),
    ).toBe("You usually see John about once a week, and it's been 1 day.");
  });
});

describe("3. no pattern, no pattern claim", () => {
  /**
   * A cadence signal always carries an ACTIVE baseline today, so `pattern` is
   * always present. The fallback is for the row written by a deploy that did
   * not, and it drops the rhythm claim rather than inventing one — the same
   * rule buildProposal already applies when it omits `pattern` entirely.
   */
  it("falls back to elapsed time alone when there is no pattern", () => {
    const noPattern: ReconnectProposal = cadence();
    delete noPattern.pattern;
    expect(buildCadencePreamble(noPattern)).toBe(
      "It's been 13 days since you last saw John.",
    );
  });

  it("uses the same fallback rather than dividing by a nonsense median", () => {
    for (const median of [0, -7, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(buildCadencePreamble(cadence({ pattern: { medianGapDays: median } }))).toBe(
        "It's been 13 days since you last saw John.",
      );
    }
  });

  it("uses the call verb in the fallback too", () => {
    const noPattern: ReconnectProposal = cadence({ entityName: "Margaret", eventType: "call" });
    delete noPattern.pattern;
    expect(buildCadencePreamble(noPattern)).toBe(
      "It's been 13 days since you last heard from Margaret.",
    );
  });
});

describe("4. an explicit absence gets no preamble at all", () => {
  /**
   * The two triggers stay separate. When the person said it themselves —
   * "I haven't seen John this week" — the context is theirs, already in the
   * conversation, and restating it back at them would be the system
   * explaining the person to themselves.
   */
  it("returns null for user_stated_absence", () => {
    expect(
      buildCadencePreamble(
        cadence({
          observation: {
            kind: "user_stated_absence",
            statedPhrase: "I haven't seen John this week",
            window: { start: "2026-09-14", end: "2026-09-21" },
          },
        }),
      ),
    ).toBeNull();
  });

  it("returns null even when a pattern happens to be attached", () => {
    expect(
      buildCadencePreamble(
        cadence({
          pattern: { medianGapDays: 7 },
          observation: {
            kind: "user_stated_absence",
            window: { start: "2026-09-14", end: "2026-09-21" },
          },
        }),
      ),
    ).toBeNull();
  });
});

describe("5. the exact-text chain is untouched", () => {
  /**
   * The preamble is a sentence ABOUT the offer. It is never inside the block,
   * because the block's bytes are the ones consent attaches to and the ones
   * the browser strips to draw the card. A preamble that leaked into the
   * block would be invisible to the person and would change the string the
   * transcript is searched for.
   */
  it("the block is byte-identical to what it has always been", () => {
    const block = buildOfferBlock({ entityName: "John", renderedText: "Dad was wondering — visit?" });
    expect(block).toBe(
      "I can send John this message:\n\nDad was wondering — visit?\n\nWould you like me to send it?",
    );
  });

  it("no preamble text appears in the block", () => {
    const preamble = buildCadencePreamble(cadence());
    const block = buildOfferBlock({ entityName: "John", renderedText: "Dad was wondering — visit?" });
    expect(preamble).not.toBeNull();
    expect(block).not.toContain(preamble!);
    expect(block).not.toContain("usually");
  });

  it("the preamble never contains the draft, and never a number the proposal did not carry", () => {
    const preamble = buildCadencePreamble(cadence())!;
    expect(preamble).not.toContain("Dad was wondering");
    // 13 and nothing else: the threshold (11) and the MAD (0) are evidence
    // for the decision, not facts the person was promised.
    expect(preamble.match(/\d+/g)).toEqual(["13"]);
  });
});
