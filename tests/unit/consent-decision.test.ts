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

/**
 * A "yes" with a qualifier attached is not a yes (P1).
 *
 * Found while building hands-free, and a release blocker because of it: a
 * transcript is punctuated by a speech-to-text model, not by the person, so
 * "yes but later" and "yes, but maybe later" are the same sentence arriving
 * with different commas. One of them used to approve an irreversible message
 * to a family member and the other did not.
 *
 * The rule the tests below pin is simple and worth stating plainly: an
 * affirmative opener grants nothing if the same sentence goes on to defer,
 * hedge or refuse. Consent is what the whole message says, not what its first
 * word says.
 */
describe("a qualified yes is not consent", () => {
  const QUALIFIED = [
    "yes but later",
    "yes, but later",
    "yes but maybe later",
    "yes, but maybe later",
    "yes maybe later",
    "yeah but later",
    "yes not now",
    "yes, not now",
    "yes but not yet",
    "yes, but not yet",
  ];

  it.each(QUALIFIED)("%j never approves", (reply) => {
    expect(readConsent(reply).decision, reply).not.toBe("approve");
  });

  it.each(QUALIFIED)("%j names the rule that disqualified it", (reply) => {
    // Never a silent unclear: the log has to say which qualifier was heard.
    expect(readConsent(reply).matchedRule, reply).not.toBeNull();
  });

  it("punctuation cannot change the decision", () => {
    // The property, stated directly: commas are the transcriber's, not the
    // person's, so a decision may not depend on one.
    const variants = (base: string) => [
      base,
      base.replace(" but ", ", but "),
      base.replace(" but ", " but, "),
      `${base}.`,
      `${base}!`,
      base.replace(/ /g, ", ").replace(/, $/, ""),
    ];
    for (const base of ["yes but later", "yes but maybe later", "yes but not yet"]) {
      const readings = variants(base).map((text) => readConsent(text).decision);
      expect(new Set(readings).size, `${base} -> ${readings.join("/")}`).toBe(1);
      expect(readings[0], base).not.toBe("approve");
    }
  });

  it("a clear yes is still a clear yes", () => {
    for (const reply of ["yes", "yes please", "yeah", "please send it", "send it"]) {
      expect(readConsent(reply).decision, reply).toBe("approve");
    }
    // And punctuation does not disturb those either.
    for (const reply of ["yes.", "yes!", "yes, please.", "send it."]) {
      expect(readConsent(reply).decision, reply).toBe("approve");
    }
  });

  it("a clear no is still a clear no", () => {
    for (const reply of ["no", "not now", "don't send it", "no thanks", "not yet"]) {
      expect(readConsent(reply).decision, reply).toBe("decline");
    }
    for (const reply of ["no.", "no!", "not now.", "don't send it."]) {
      expect(readConsent(reply).decision, reply).toBe("decline");
    }
  });

  it("a refusal that contains the words of an approval is still a refusal", () => {
    // The ordering this parser has always had: "don't send it" contains
    // "send it", and must never read as one.
    expect(readConsent("don't send it")).toMatchObject({ decision: "decline" });
    expect(readConsent("please don't send it")).toMatchObject({ decision: "decline" });
  });
});

/**
 * The property, over the whole vocabulary.
 *
 * Not "these four strings agree" but "punctuation is never load-bearing":
 * for every reply the parser has an opinion about, every punctuated variant
 * of it must produce the IDENTICAL reading — decision and rule. A transcript's
 * commas belong to the speech-to-text model, and nothing irreversible may turn
 * on them.
 */
describe("punctuation is never load-bearing", () => {
  const CORPUS = [
    // approvals
    "yes",
    "yes please",
    "yeah",
    "ok",
    "go ahead",
    "send it",
    "please send it",
    "that's fine",
    "sounds good",
    // declines
    "no",
    "no thanks",
    "not now",
    "not yet",
    "don't send it",
    "rather not",
    "never mind",
    // hesitation
    "maybe",
    "maybe later",
    "not sure",
    "i guess",
    "let me think",
    "up to you",
    // qualified affirmatives — the bug this file exists for
    "yes but later",
    "yes but maybe later",
    "yes but not yet",
    "yeah but not this week",
    "yes not now",
    "sure but maybe another time",
    // not an answer at all
    "the garden needs doing",
  ];

  /** Every way a transcriber might punctuate the same sentence. */
  const punctuated = (reply: string): string[] => {
    const words = reply.split(" ");
    const commaAfterEachWord = words.map((_, index) =>
      words.map((word, at) => (at === index && at < words.length - 1 ? `${word},` : word)).join(" "),
    );
    return [
      reply,
      `${reply}.`,
      `${reply}!`,
      `${reply}?`,
      `${reply}…`,
      `"${reply}"`,
      `${reply.charAt(0).toUpperCase()}${reply.slice(1)}.`,
      reply.split(" ").join(", "),
      ...commaAfterEachWord,
    ];
  };

  it.each(CORPUS)("every punctuation of %j reads the same", (reply) => {
    const baseline = readConsent(reply);
    for (const variant of punctuated(reply)) {
      expect(readConsent(variant), `${reply} -> ${variant}`).toEqual(baseline);
    }
  });

  it("and no punctuation of a qualified yes ever approves", () => {
    for (const reply of ["yes but later", "yes but maybe later", "yes but not yet", "yes not now"]) {
      for (const variant of punctuated(reply)) {
        expect(readConsent(variant).decision, variant).not.toBe("approve");
      }
    }
  });

  it("the comma was never the point — the qualifier is", () => {
    // Both halves of the original report, now identical, and neither one
    // approving. The bug was that the deferral vocabulary only counted at the
    // start of a message.
    expect(readConsent("yes but later").decision).toBe("unclear");
    expect(readConsent("yes, but maybe later").decision).toBe("unclear");
    expect(readConsent("yes but later").decision).toBe(
      readConsent("yes, but later").decision,
    );
  });
});
