import { detectionConfig, type DetectionConfig } from "./config";

/**
 * WHEN a cadence-only offer may be presented (M12c).
 *
 * DETECTION IS NOT PRESENTATION. The detector is right and stays untouched:
 * a cadence gap is materialized in the background as soon as the evidence
 * supports it. This decides only whether *now* is a moment to raise it, and
 * a "no" costs nothing — the opportunity stays `drafted`, no `offered_at` is
 * written, no cooldown starts, and the next qualifying turn shows it.
 *
 * WHY THE PREVIOUS RULE WAS NOT ENOUGH. M12b counted the person's turns for
 * the lifetime of the CONVERSATION ROW. A conversation row outlives a
 * conversation: CareLoop reopens the latest one, so somebody returning the
 * next morning is on turn 47 of a row whose first three turns happened
 * yesterday. The gate was satisfied permanently after the first sitting,
 * which is precisely when it was observed failing — "How are you doing?",
 * "I am doing good what about you?", and a family matter on screen.
 *
 * SO IT COUNTS THE SITTING, not the row. A sitting is the run of messages
 * with no gap longer than `sittingGapMinutes` between them. That is a
 * property of timestamps the turn already holds; it needs no new query, no
 * session concept, and no server memory.
 *
 * AND IT COUNTS SUBSTANCE, not only turns. Raising the turn threshold alone
 * would have been a number chosen to beat one transcript: "hello / good and
 * u / how are you doing? / I am doing good what about you?" is four turns
 * and sixty-four characters. Pleasantries are short AND few; a conversation
 * that is actually underway passes both bars quickly, and one that is still
 * clearing its throat passes neither.
 *
 * WHAT THIS IS NOT. It is not a judgement about meaning, mood or engagement,
 * and no model is consulted. Length and elapsed time are the only two things
 * measured, both are stored values, and both are in `detectionConfig` where
 * a non-engineer can read them.
 *
 * EXPLICIT ABSENCE NEVER REACHES HERE. "I haven't seen John this week" is the
 * person opening the subject, and the caller does not consult this function
 * for it — the same exemption `newAccountCadenceQuietDays` already makes.
 */

export type PresentationMessage = {
  role: string;
  content: string;
  /** ISO timestamp. An unparseable one is treated as a sitting boundary. */
  createdAt: string;
};

export type CadencePresentationVerdict =
  | { present: true; userTurns: number; userCharacters: number }
  | {
      present: false;
      reason: "conversation_too_early_for_cadence";
      userTurns: number;
      userCharacters: number;
      needTurns: number;
      needCharacters: number;
    };

/**
 * The person's turns and characters in the CURRENT sitting.
 *
 * Walks backwards from the newest message and stops at the first gap longer
 * than `sittingGapMinutes`. Exported because "which messages counted" is the
 * first question anyone asks about a suppressed offer.
 */
export function currentSitting(
  messages: readonly PresentationMessage[],
  config: DetectionConfig = detectionConfig,
): { userTurns: number; userCharacters: number; messagesInSitting: number } {
  const gapMs = config.sittingGapMinutes * 60_000;
  let userTurns = 0;
  let userCharacters = 0;
  let messagesInSitting = 0;
  let newerAt: number | null = null;

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]!;
    const at = Date.parse(message.createdAt);
    // Fail closed: a timestamp this code cannot read ends the sitting, so
    // an unreadable row can only ever make the gate MORE conservative.
    if (Number.isNaN(at)) break;
    if (newerAt !== null && newerAt - at > gapMs) break;
    newerAt = at;
    messagesInSitting += 1;
    if (message.role !== "user") continue;
    userTurns += 1;
    // Whitespace-normalised, so a pasted newline is not substance.
    userCharacters += message.content.replace(/\s+/g, " ").trim().length;
  }

  return { userTurns, userCharacters, messagesInSitting };
}

export function cadenceMayBePresented(
  messages: readonly PresentationMessage[],
  config: DetectionConfig = detectionConfig,
): CadencePresentationVerdict {
  const { userTurns, userCharacters } = currentSitting(messages, config);

  if (
    userTurns >= config.minUserTurnsBeforeCadenceOffer &&
    userCharacters >= config.minUserCharactersBeforeCadenceOffer
  ) {
    return { present: true, userTurns, userCharacters };
  }

  return {
    present: false,
    reason: "conversation_too_early_for_cadence",
    userTurns,
    userCharacters,
    needTurns: config.minUserTurnsBeforeCadenceOffer,
    needCharacters: config.minUserCharactersBeforeCadenceOffer,
  };
}
