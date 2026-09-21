/**
 * Whether a voice transcript may send itself (M12h).
 *
 * Every voice transcript used to land in the composer and wait for Send.
 * That was right while the wake word was an experiment and every path
 * through it was new. It is wrong as a permanent default for the person
 * this is built for: somebody who has just spoken a sentence out loud
 * should not then have to find a button.
 *
 * So a transcript may send itself, after a visible countdown the shell
 * runs, in the cases below and no others. Three refusals, and they are not
 * the same kind of refusal:
 *
 *   OFFER_PENDING is a safety rule. A card offering to message somebody's
 *   family is on screen, so the next thing the person says might be
 *   consent. Consent stays a deliberate act — the person's hand, on Send.
 *   The server side of this already exists: `answerableOffer` refuses a yes
 *   for a card that was never shown (M12g). This is the same rule seen from
 *   the interface, and having it in both places is the point, not
 *   duplication: one stops the message, the other stops the person being
 *   surprised by it.
 *
 *   TOO_SHORT is a quality rule. One or two words is where transcription is
 *   least reliable and where a mishearing costs most — "yes", "no", a name.
 *   Short transcripts wait in the composer, where they can be read.
 *
 *   NOT_A_WAKE_TURN is a scope rule. Somebody pressing the microphone
 *   button already has a hand on the interface. Push-to-talk is the
 *   permanent fallback and the interaction that must not move under a
 *   reviewer, so it keeps the behaviour it has had since M8.
 *
 * PURE. No React, no timers, no engine, no clock. The countdown belongs to
 * the shell; whether there is anything to count down to belongs here, where
 * it can be read in one screen and tested exhaustively.
 */

/**
 * The shortest transcript that may send itself, in words.
 *
 * A judgement about transcription quality rather than a law, and set
 * deliberately rather than derived: at one or two words the error modes are
 * both most likely and most consequential, and the cost of being wrong in
 * this direction is one button press.
 */
export const MIN_AUTO_SEND_WORDS = 3;

/**
 * How long the person has to stop it.
 *
 * Long enough to read a mis-heard sentence and reach Cancel; short enough
 * that it does not feel like the system is hesitating. Three seconds is a
 * product decision, and lives here so the interface and its tests cannot
 * disagree about it.
 */
export const AUTO_SEND_COUNTDOWN_SECONDS = 3;

export type AutoSendRefusal = "empty" | "offer_pending" | "not_a_wake_turn" | "too_short";

export type AutoSendDecision = { send: true } | { send: false; reason: AutoSendRefusal };

export type AutoSendInputs = {
  /** The transcript exactly as it came back from the transcriber. */
  text: string;
  /** A reconnect or wellbeing card is on screen, awaiting a yes or no. */
  offerPending: boolean;
  /** The recording in flight was started by a wake word, not by a press. */
  wakeTurn: boolean;
};

/**
 * Words, counted the way speech arrives.
 *
 * A transcriber punctuates; the person did not. "Yes, please." is two words
 * however it is spelled, so splitting on whitespace is the honest count —
 * and a hyphenated name or a contraction stays one word, because
 * "Jean-Luc" and "isn't" are one thing each to whoever said them.
 */
function wordCount(text: string): number {
  const trimmed = text.trim();
  return trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length;
}

/**
 * ORDER IS LOAD-BEARING, for the same reason it is in the consent parser.
 * The reason is what the interface explains and what a log line records, so
 * two rules that both apply must resolve the same way every time: nothing
 * heard, then the safety rule, then scope, then quality.
 */
export function autoSendDecision(input: AutoSendInputs): AutoSendDecision {
  if (wordCount(input.text) === 0) return { send: false, reason: "empty" };
  if (input.offerPending) return { send: false, reason: "offer_pending" };
  if (!input.wakeTurn) return { send: false, reason: "not_a_wake_turn" };
  if (wordCount(input.text) < MIN_AUTO_SEND_WORDS) return { send: false, reason: "too_short" };
  return { send: true };
}
