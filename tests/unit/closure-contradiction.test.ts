import { describe, expect, it } from "vitest";
import {
  contradictsClosure,
  safeClosureContinuation,
} from "@/core/family/closure-contradiction";
import { renderClosureSentence } from "@/core/family/closure";

/**
 * THE VERIFIED REPLY AND THE MODEL'S AFTERTHOUGHT.
 *
 * Live acceptance: the closure surfaced correctly - "John replied that they
 * are planning to visit this weekend." - and the model's continuation
 * immediately added "You're welcome, I hope you hear from John soon."
 *
 * Both sentences were in one turn. The true one came from application code;
 * the false one was in the companion's own voice, and it told a man who had
 * just been told his son was visiting that his son had not been in touch.
 *
 * The prompt already forbade this. An instruction is a probability, and this
 * is not a thing to leave to probability.
 */
describe("detecting a still-waiting contradiction", () => {
  /** The exact production sentence, then the variants acceptance asked for. */
  const CONTRADICTIONS = [
    "You're welcome, I hope you hear from John soon.",
    "I'll let you know when he replies.",
    "I haven't heard from him yet.",
    "Hopefully John gets back to you soon.",
    "We're still waiting for John.",
    "I'm waiting to hear back from her.",
    "There's no reply yet, but I'll tell you as soon as there is.",
    "As soon as he responds I'll let you know.",
    "I'll pass it on when she gets back to you.",
    "No word from them yet.",
  ];

  for (const text of CONTRADICTIONS) {
    it(`rejects: "${text}"`, () => {
      expect(contradictsClosure(text).contradicts).toBe(true);
    });
  }

  it("catches a contradiction hiding after a correct sentence", () => {
    // What production actually produced: an acknowledgement the guard must
    // not be soothed by, and an afterthought that undoes it. Scanning the
    // whole blob at once would let the good half mask the bad.
    const both = "That's lovely news about the visit. I hope you hear from John soon.";
    expect(contradictsClosure(both).contradicts).toBe(true);
  });

  it("names the rule that matched, for a log line carrying no message text", () => {
    const verdict = contradictsClosure("I hope you hear from John soon.");
    expect(verdict.contradicts).toBe(true);
    if (verdict.contradicts) expect(verdict.rule).toBe("hope_to_hear");
  });

  it("is name-agnostic — the contradiction is in the verb, not the person", () => {
    for (const name of ["John", "Margaret", "him", "her", "them", "your son", "Priya"]) {
      expect(contradictsClosure(`I hope you hear from ${name} soon.`).contradicts, name).toBe(true);
    }
  });
});

describe("what it must NOT reject", () => {
  /**
   * The guard replaces the whole continuation, so a false positive silently
   * costs the person a real, warm answer. These are the sentences a good
   * closure turn produces.
   */
  const ALLOWED = [
    "You're welcome. I hope the visit goes well.",
    "That's lovely. It sounds like a good weekend ahead.",
    "You're very welcome.",
    "I'm glad that's settled.",
    "That's good news.",
    "How are you feeling about it?",
    "Would you like to tell me about the garden?",
    "It sounds like you're looking forward to seeing him.",
    "The weather has been lovely this week.",
    "I heard you the first time — no need to repeat it.",
  ];

  for (const text of ALLOWED) {
    it(`allows: "${text}"`, () => {
      expect(contradictsClosure(text).contradicts).toBe(false);
    });
  }

  it("does not join two clauses across a line break into a false match", () => {
    /**
     * Why the scan is per SENTENCE rather than over the whole blob. The
     * patterns use `[^.!?]` to stay inside one sentence, and that class
     * happily crosses a newline - so an unpunctuated line break could let
     * "hope" on one line and "hear" on the next combine into a contradiction
     * neither line contains.
     *
     * The cost of a false positive is a real, warm answer being thrown away
     * and replaced by a canned one, which the person would notice.
     */
    const twoLines = "That is not something I would do\nheard from your sister lately";
    // "not" on the first line and "heard" on the second are innocent apart.
    // Scanned as one blob they combine into the not_heard rule and a warm
    // answer is thrown away for a contradiction neither line contains.
    expect(contradictsClosure(twoLines).contradicts).toBe(false);
  });

  it("does not reject the deterministic closure sentence itself", () => {
    // If it did, the application would be suppressing its own verified fact.
    for (const intent of ["yes", "no", "unsure", "other"] as const) {
      const sentence = renderClosureSentence({
        opportunityId: "opp",
        familyRequestId: "req",
        responseId: "resp",
        entityName: "John",
        topic: "visit",
        responseIntent: intent,
        timeframe: "this weekend",
        createdAt: "2026-09-16T12:00:00.000Z",
      });
      expect(contradictsClosure(sentence).contradicts, sentence).toBe(false);
    }
  });

  it("does not reject its own fallback — that would loop", () => {
    for (const intent of ["yes", "no", "unsure", "other"] as const) {
      for (const topic of ["visit", "call"] as const) {
        const fallback = safeClosureContinuation({ topic, responseIntent: intent });
        expect(contradictsClosure(fallback).contradicts, fallback).toBe(false);
      }
    }
  });
});

describe("the safe continuation invents nothing", () => {
  it("wishes a visit well only when a visit was actually agreed to", () => {
    expect(safeClosureContinuation({ topic: "visit", responseIntent: "yes" })).toBe(
      "You're welcome. I hope the visit goes well.",
    );
    expect(safeClosureContinuation({ topic: "call", responseIntent: "yes" })).toBe(
      "You're welcome. I hope the call goes well.",
    );
  });

  it("says nothing about the future when nothing was agreed to", () => {
    for (const intent of ["no", "unsure", "other"] as const) {
      const text = safeClosureContinuation({ topic: "visit", responseIntent: intent });
      expect(text).toBe("You're welcome.");
      // No visit, no call, and no guess about how a 'no' feels.
      for (const invented of ["visit", "call", "sorry", "sad", "disappoint", "next time"]) {
        expect(text.toLowerCase(), invented).not.toContain(invented);
      }
    }
  });

  it("never names a person or a time", () => {
    // It is derived from topic and intent only, so it cannot restate a fact
    // the closure sentence already owns, or invent one it does not.
    for (const intent of ["yes", "no"] as const) {
      const text = safeClosureContinuation({ topic: "visit", responseIntent: intent });
      for (const leak of ["John", "weekend", "Tuesday", "soon"]) {
        expect(text, leak).not.toContain(leak);
      }
    }
  });
});
