import { describe, expect, it } from "vitest";
import { readConsent } from "@/core/consent/decision";

/**
 * The consent parser.
 *
 * Consent is never inferred from sentiment, enthusiasm, topic or silence. The
 * parser recognises a small vocabulary of clear answers and calls everything
 * else unclear, because the cost of a false "unclear" is one more question and
 * the cost of a false "approve" is a message the person never agreed to.
 */
const APPROVE = [
  "yes",
  "Yes",
  "yes please",
  "Yes, please",
  "yeah",
  "yep",
  "ok",
  "okay",
  "sure",
  "sure, send it",
  "send it",
  "send it please",
  "please send that",
  "go ahead",
  "Go ahead, send it.",
  "that's fine",
  "thats fine",
  "that's lovely",
  "sounds good",
  "absolutely",
  "definitely, send it",
];

const DECLINE = [
  "no",
  "No.",
  "nope",
  "nah",
  "no thanks",
  "no thank you",
  "don't send it",
  "dont send it",
  "do not send that",
  "not now",
  "not today",
  "I'd rather not",
  "cancel that",
  "forget it",
  "leave it",
  "never mind",
  "don't bother",
];

const UNCLEAR = [
  "maybe",
  "Maybe.",
  "maybe later",
  "perhaps",
  "I guess",
  "i suppose so",
  "not sure",
  "I'm not sure",
  "later",
  "another time",
  "whatever you think",
  "you decide",
  "up to you",
  "I don't know",
  "dunno",
  "let me think",
  "",
  "   ",
];

describe("1. clear affirmatives approve", () => {
  for (const text of APPROVE) {
    it(`approves: ${JSON.stringify(text)}`, () => {
      expect(readConsent(text).decision).toBe("approve");
    });
  }
});

describe("2. clear negatives decline", () => {
  for (const text of DECLINE) {
    it(`declines: ${JSON.stringify(text)}`, () => {
      expect(readConsent(text).decision).toBe("decline");
    });
  }
});

describe("3. everything else is unclear", () => {
  for (const text of UNCLEAR) {
    it(`is unclear: ${JSON.stringify(text)}`, () => {
      expect(readConsent(text).decision).toBe("unclear");
    });
  }
});

describe("4. order is load-bearing", () => {
  it("a refusal containing 'send it' is a refusal, not a send", () => {
    // Checking agreement first would turn "don't send it" into a send. This is
    // the single worst bug this product can have.
    expect(readConsent("don't send it").decision).toBe("decline");
    expect(readConsent("please don't send that").decision).toBe("decline");
  });

  it("'not sure' is hesitation, not refusal", () => {
    expect(readConsent("not sure").decision).toBe("unclear");
    expect(readConsent("I'm not sure yet").decision).toBe("unclear");
  });

  it("'maybe later' is hesitation, not a 'later' decline", () => {
    expect(readConsent("maybe later").decision).toBe("unclear");
  });
});

describe("5. no accidental substring affirmative", () => {
  it("'not yes' does not approve", () => {
    expect(readConsent("not yes").decision).not.toBe("approve");
  });

  it("words merely containing an affirmative do not approve", () => {
    for (const text of [
      "the yesterday post arrived",
      "okra is in the garden",
      "I had a surefire feeling",
      "we resend the parcel tomorrow",
    ]) {
      expect(readConsent(text).decision, text).not.toBe("approve");
    }
  });

  it("an affirmative must open the sentence or be a real phrase", () => {
    // "I suppose yes" is hesitation first; it must not read as agreement.
    expect(readConsent("I suppose yes").decision).toBe("unclear");
  });
});

describe("6. changing the subject is not an answer at all", () => {
  it("returns unclear with no matched rule, so the caller keeps talking", () => {
    const reading = readConsent("The roses have come out beautifully this year.");
    expect(reading.decision).toBe("unclear");
    expect(reading.matchedRule).toBeNull();
  });

  it("hesitation DOES match a rule, so the caller asks once more", () => {
    const reading = readConsent("maybe");
    expect(reading.decision).toBe("unclear");
    expect(reading.matchedRule).not.toBeNull();
  });

  it("silence is never consent", () => {
    expect(readConsent("").decision).toBe("unclear");
    expect(readConsent("").matchedRule).toBeNull();
  });
});
