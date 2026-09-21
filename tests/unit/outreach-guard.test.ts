import { describe, expect, it } from "vitest";
import {
  offersOutreach,
  stripUnpromptedOutreach,
  OUTREACH_FALLBACK,
} from "@/core/safety/outreach-guard";

/**
 * One authority for external actions.
 *
 * The prompt has forbidden this since v4 — "you never contact anyone on your
 * own initiative, and you never offer to" — and the model wrote
 * "Would you like to send a message to someone, by the way?" anyway, in the
 * middle of smalltalk, just before the application's own reconnect card.
 *
 * Third time in this codebase that an instruction has turned out to be a
 * probability. So it is a deterministic check with a deterministic remedy,
 * and the prompt is the second line.
 */
describe("1. the sentence actually observed", () => {
  it("is removed, and the rest of the turn survives", () => {
    const result = stripUnpromptedOutreach(
      "That's good to hear. Would you like to send a message to someone, by the way?",
    );
    expect(result.text).toBe("That's good to hear.");
    expect(result.removed).toEqual(["offer_to_them"]);
  });
});

describe("2. every shape of the same offer", () => {
  it.each([
    "Would you like me to send him a message?",
    "Do you want me to ring Margaret for you?",
    "Shall I let John know?",
    "Should I get in touch with her?",
    "I can send a message to your son if you like.",
    "I'd be happy to pass that on to him.",
    "Want me to ask John about the weekend?",
    "Let me know if you'd like me to reach out to anyone.",
    "Would you like to write to her?",
  ])("removes %j", (sentence) => {
    expect(offersOutreach(sentence)).toBe(true);
    const result = stripUnpromptedOutreach(`Lovely. ${sentence}`);
    expect(result.text).toBe("Lovely.");
    expect(result.removed.length).toBe(1);
  });
});

describe("3. what it must NOT touch", () => {
  /**
   * The person's own life is the whole subject of the conversation. A
   * question about what THEY did or might do is not CareLoop proposing an
   * action, and stripping those would make the companion incurious — which
   * is a worse product than an occasional flat sentence.
   */
  it.each([
    "Did you ring Margaret back in the end?",
    "Are you seeing John this weekend?",
    "Has he been in touch since?",
    "That sounds like a lovely morning.",
    "How did the call with your daughter go?",
    "Did you write to her about the garden?",
    "I have not heard back from him yet.",
    "You mentioned John was going to visit.",
    "I'm glad you're doing well — what have you been up to today?",
  ])("leaves %j alone", (sentence) => {
    expect(offersOutreach(sentence)).toBe(false);
    expect(stripUnpromptedOutreach(sentence)).toEqual({ text: sentence, removed: [] });
  });

  it("never rewrites a turn it did not need to touch", () => {
    const text = "That sounds lovely. How were the roses this year?";
    // Byte-identical, not merely equivalent: an untouched turn must not be
    // reflowed, re-spaced or trimmed on its way through a safety check.
    expect(stripUnpromptedOutreach(text).text).toBe(text);
  });
});

describe("4. the application's own offer block is not this function's business", () => {
  /**
   * `buildOfferBlock` ends "Would you like me to send it?" — which is an
   * outreach offer, and rightly so: the application decided it, the exact
   * draft is on screen above it, and consent attaches to those bytes. The
   * caller never routes it through here (the block is appended after
   * generation), and this test records why that ordering matters.
   */
  it("would have stripped the block, which is exactly why it never sees one", async () => {
    const { buildOfferBlock } = await import("@/core/share/offer");
    const block = buildOfferBlock({ entityName: "John", renderedText: "Are you visiting?" });
    expect(offersOutreach(block)).toBe(true);
  });
});

describe("5. a turn that was nothing but an offer", () => {
  it("falls back rather than producing an empty reply", () => {
    // An empty completion fails the turn, which would turn a tone problem
    // into a broken reply.
    const result = stripUnpromptedOutreach("Would you like me to send him a message?");
    expect(result.text).toBe(OUTREACH_FALLBACK);
    expect(result.text.length).toBeGreaterThan(0);
  });

  it("the fallback asserts nothing about anyone", () => {
    expect(OUTREACH_FALLBACK).not.toMatch(/\b(he|she|they|John|message|send|reply)\b/i);
  });
});

describe("6. the log records the rule, never the words", () => {
  it("returns rule names only", () => {
    const result = stripUnpromptedOutreach(
      "Nice. Shall I let John know? I can text Margaret too.",
    );
    expect(result.removed).toEqual(["shall_i", "i_can_act"]);
    for (const name of result.removed) {
      expect(name).not.toMatch(/John|Margaret/);
    }
  });
});
