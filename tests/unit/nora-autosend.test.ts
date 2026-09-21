import { describe, expect, it } from "vitest";
import {
  autoSendDecision,
  AUTO_SEND_COUNTDOWN_SECONDS,
  MIN_AUTO_SEND_WORDS,
  type AutoSendRefusal,
} from "@/core/nora/autosend";

/**
 * WHETHER A TRANSCRIPT MAY SEND ITSELF (M12h).
 *
 * Until now every voice transcript landed in the composer and waited for
 * Send. That was the right default while the wake word was an experiment,
 * and it is the wrong default for the person this is built for: an
 * 88-year-old who has just spoken a sentence should not then have to find a
 * button.
 *
 * So the transcript may send itself — but only where nothing irreversible
 * is on the table, and only where the transcript is long enough to be worth
 * trusting. Three rules, one pure function, and the reasons are not
 * interchangeable:
 *
 *   AN OFFER ON THE TABLE means the next thing the person says might be
 *   consent to message their family. That has to stay a deliberate act.
 *   The server already refuses a yes for a card that was never shown
 *   (M12g); this is the other side of the same rule, and it is the side
 *   the person can see.
 *
 *   ONE OR TWO WORDS is where transcription is least reliable and where a
 *   mishearing is most consequential — "yes", "no", "John" — so the short
 *   ones wait in the composer where they can be read.
 *
 *   A PRESS IS ALREADY A DELIBERATE ACT. Somebody holding the microphone
 *   button has their hand on the interface and can press Send. Push-to-talk
 *   is the permanent fallback and the one interaction that must not move
 *   under a reviewer.
 *
 * Pure: no React, no timers, no engine. The countdown is the shell's job;
 * whether there is anything to count down to is this file's.
 */
describe("1. the three rules", () => {
  const LONG = "I think I will go into the garden this afternoon";

  it("sends a wake-word sentence when nothing is pending", () => {
    expect(autoSendDecision({ text: LONG, offerPending: false, wakeTurn: true })).toEqual({
      send: true,
    });
  });

  it("never sends while an offer is on the table", () => {
    expect(autoSendDecision({ text: LONG, offerPending: true, wakeTurn: true })).toEqual({
      send: false,
      reason: "offer_pending",
    });
  });

  it("never sends one or two words", () => {
    for (const text of ["yes", "no", "yes please", "send it", "John"]) {
      expect(autoSendDecision({ text, offerPending: false, wakeTurn: true })).toEqual({
        send: false,
        reason: "too_short",
      });
    }
  });

  it("sends at three words", () => {
    // The bound is stated as a test, not only as a constant: MIN_AUTO_SEND_WORDS
    // is a judgement about transcription quality, and moving it should have to
    // move a test that says what it costs.
    expect(MIN_AUTO_SEND_WORDS).toBe(3);
    expect(autoSendDecision({ text: "tell me about", offerPending: false, wakeTurn: true })).toEqual(
      { send: true },
    );
  });

  it("never sends a pressed recording", () => {
    expect(autoSendDecision({ text: LONG, offerPending: false, wakeTurn: false })).toEqual({
      send: false,
      reason: "not_a_wake_turn",
    });
  });

  it("has nothing to send when nothing was heard", () => {
    for (const text of ["", "   ", "\n"]) {
      expect(autoSendDecision({ text, offerPending: false, wakeTurn: true })).toEqual({
        send: false,
        reason: "empty",
      });
    }
  });
});

/** Narrows the union, so a test that expects a refusal cannot silently
 * be handed an approval and read `undefined` off it. */
function refusalFor(input: Parameters<typeof autoSendDecision>[0]): AutoSendRefusal {
  const decision = autoSendDecision(input);
  if (decision.send) throw new Error("expected a refusal, got send");
  return decision.reason;
}

describe("2. the order the reasons are given in", () => {
  /**
   * Not cosmetic. The reason is what the interface explains and what a log
   * line records, so two rules that both apply must resolve the same way
   * every time. Emptiness first (there is nothing to discuss), then the
   * offer (the safety rule outranks a quality one), then the press, then
   * length.
   */
  it("an empty transcript is empty before it is anything else", () => {
    expect(refusalFor({ text: "  ", offerPending: true, wakeTurn: false })).toBe("empty");
  });

  it("a pending offer outranks a short transcript", () => {
    expect(refusalFor({ text: "yes", offerPending: true, wakeTurn: true })).toBe("offer_pending");
  });

  it("a pending offer outranks a press", () => {
    expect(refusalFor({ text: "yes please", offerPending: true, wakeTurn: false })).toBe(
      "offer_pending",
    );
  });
});

describe("3. counting words the way speech arrives", () => {
  it("punctuation and spacing are not words", () => {
    // A transcriber punctuates; the person did not. "Yes, please." is two
    // words however it is spelled, and must not become three.
    expect(autoSendDecision({ text: "Yes,  please.", offerPending: false, wakeTurn: true })).toEqual(
      { send: false, reason: "too_short" },
    );
    expect(
      autoSendDecision({ text: " tell  me\nabout ", offerPending: false, wakeTurn: true }),
    ).toEqual({ send: true });
  });

  it("a hyphenated name is one word, and a contraction is one word", () => {
    expect(
      autoSendDecision({ text: "Jean-Luc isn't here", offerPending: false, wakeTurn: true }),
    ).toEqual({ send: true });
    expect(autoSendDecision({ text: "isn't Jean-Luc", offerPending: false, wakeTurn: true })).toEqual(
      { send: false, reason: "too_short" },
    );
  });
});

describe("4. the countdown is long enough to be an out", () => {
  it("is three seconds", () => {
    expect(AUTO_SEND_COUNTDOWN_SECONDS).toBe(3);
  });
});
