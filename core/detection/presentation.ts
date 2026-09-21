import { detectionConfig, type DetectionConfig } from "./config";
import { detectMentionedNames } from "@/core/memory/present";
import { normalizeName } from "@/core/memory/normalize";

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
): {
  userTurns: number;
  userCharacters: number;
  messagesInSitting: number;
  /** Epoch ms of the OLDEST message still inside the sitting, or null. */
  startedAtMs: number | null;
} {
  const gapMs = config.sittingGapMinutes * 60_000;
  let userTurns = 0;
  let userCharacters = 0;
  let messagesInSitting = 0;
  let newerAt: number | null = null;
  let startedAtMs: number | null = null;

  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]!;
    const at = Date.parse(message.createdAt);
    // Fail closed: a timestamp this code cannot read ends the sitting, so
    // an unreadable row can only ever make the gate MORE conservative.
    if (Number.isNaN(at)) break;
    if (newerAt !== null && newerAt - at > gapMs) break;
    newerAt = at;
    startedAtMs = at;
    messagesInSitting += 1;
    if (message.role !== "user") continue;
    userTurns += 1;
    // Whitespace-normalised, so a pasted newline is not substance.
    userCharacters += message.content.replace(/\s+/g, " ").trim().length;
  }

  return { userTurns, userCharacters, messagesInSitting, startedAtMs };
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

/* ------------------------------------------------------------------------ */
/* WHETHER THIS SPECIFIC OPPORTUNITY BELONGS IN THIS SPECIFIC TURN (M12e)    */
/* ------------------------------------------------------------------------ */

/**
 * DETECTED IS NOT PRESENT NOW — the second half of the rule.
 *
 * M12c built the first half and only the first half. `cadenceMayBePresented`
 * asks "is this conversation underway yet", which is a property of the
 * SITTING, and it was applied to cadence offers only. An explicit-absence
 * offer was exempted on the grounds that the person had opened the subject
 * themselves.
 *
 * That exemption was correct for the turn they open it on, and wrong for
 * every turn afterwards. The absence detector re-examines stored absence
 * events for `absenceLookbackDays` (14), the opportunity it drafts lives
 * `opportunityOfferabilityHours` (24), and neither number has anything to do
 * with whether the person is still talking about that person. So "I haven't
 * seen Don recently" on Monday could, and did, surface its card on Tuesday
 * against "It was good, what about you?" — a pleasantry with no connection
 * to Don at all.
 *
 * WHAT "STILL SUPPORTS IT" MEANS depends on WHOSE claim it is, and the two
 * answers are deliberately different.
 *
 * SOMETHING THE PERSON SAID — an explicit absence, a wellbeing self-report —
 * is supported by the turn they said it on, and by nothing else. It is
 * presentable while the SITTING that carries that statement is still
 * running, and it stops being presentable when newer evidence overtakes it.
 *
 * A NAME IS NOT A REVIVAL (M12e.1). The first version of this gate also
 * accepted "the person named the entity again", which is too weak and in one
 * case exactly backwards:
 *
 *     yesterday   "I haven't seen Don recently."
 *     today       "Don sent me a message this morning."
 *
 * The second turn contains "Don" and is evidence AGAINST raising the first.
 * A lexical match cannot tell those apart, and nothing in this module should
 * try to: the absence is presentable because of the turn that produced it,
 * full stop.
 *
 * A CADENCE GAP is the opposite case and keeps the name rule. Nobody said
 * anything; the claim is the application's own arithmetic, so it has no
 * source turn to be tied to. Its support is that the conversation is
 * genuinely underway (the M12c bars) — or that the person has just raised
 * that entity themselves, which is a real invitation to talk about them.
 *
 * Anything else withholds, and WITHHOLDING COSTS NOTHING. The caller keeps
 * the opportunity `drafted`: no `offered_at`, no cooldown, no decline, no
 * duplicate row.
 *
 * THE ONE BOUNDED EXCEPTION is not here. An opportunity already marked
 * `offered` whose block never reached the person is re-shown by
 * `needsRepresenting`, which is limited to the same sitting and to the case
 * where a later assistant message exists without the bytes in it. That is
 * crash recovery, it is seconds wide, and it shows the SAME stored bytes.
 *
 * NO MODEL, NO MOOD, NO TOPIC MODEL. The inputs are a name match, four
 * timestamps and two counts, all stored. "It was good, what about you?" is
 * not rejected for being a pleasantry — nothing here can tell — it is
 * rejected because the sitting that raised Don ended yesterday.
 */
export type PresentableOpportunity = {
  /**
   * The stored observation's kind. Two of the three are things the PERSON
   * said, and they are treated identically here: their support is the
   * sitting they said it in. The third is the application's own statistic,
   * whose only support is that a conversation is genuinely underway.
   */
  kind: "no_mention_since" | "user_stated_absence" | "self_reported_wellbeing";
  /** The stored display name this offer is about. */
  entityName: string;
  /** Other stored labels for the same entity. */
  aliases?: readonly string[];
  /**
   * When the application first had this to say — the opportunity's own
   * `created_at`.
   *
   * Deliberately not the absence WINDOW (which is when the person says they
   * did not see somebody, not when they said it) and not the source event's
   * `reported_at` (which the presentation layer does not hold). The
   * opportunity is created by the sweep on the turn the assertion is
   * ingested, so its creation time is the closest honest answer to "when did
   * this become something to say", and it is a column, not a derivation.
   */
  raisedAtIso: string;
  /** `offered_at`, when this card has already been shown at least once. */
  offeredAtIso: string | null;
  /**
   * Newer positive contact has overtaken this claim (M12e.1).
   *
   * Decided by `absenceIsSuperseded` over stored timestamps and supplied by
   * the caller, because this module does no I/O. Meaningful only for a
   * person-stated absence; `false` — the default — is what every other kind
   * passes.
   */
  supersededByLaterContact?: boolean;
};

export type PresentedReason =
  | "person_named_it"
  | "raised_in_this_sitting"
  | "conversation_underway";

export type WithheldReason =
  | "conversation_too_early_for_cadence"
  | "context_no_longer_supports_offer"
  | "already_presented_in_this_sitting"
  | "superseded_by_later_contact";

export type OpportunityPresentationVerdict =
  | { present: true; reason: PresentedReason; userTurns: number; userCharacters: number }
  | {
      present: false;
      reason: WithheldReason;
      userTurns: number;
      userCharacters: number;
      needTurns: number;
      needCharacters: number;
    };

/** The newest user message, or null when the window holds none. */
function latestUserMessage(messages: readonly PresentationMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]!;
    if (message.role === "user") return message.content;
  }
  return null;
}

/**
 * Did the person just name this entity?
 *
 * Reuses the retrieval layer's matcher rather than writing a second one, so
 * "named in this message" means the same thing on the presentation path as it
 * does when the model is told who was mentioned. Single-token names must match
 * a whole token, so "Don" is not found inside "Donna" or "done".
 */
export function personNamedEntity(input: {
  text: string;
  entityName: string;
  aliases?: readonly string[];
}): boolean {
  const names = [input.entityName, ...(input.aliases ?? [])]
    .map(normalizeName)
    .filter((name) => name.length > 0);
  if (names.length === 0) return false;
  return (
    detectMentionedNames({
      normalizedText: normalizeName(input.text),
      normalizedNames: names,
    }).length > 0
  );
}

export function mayPresentOpportunity(
  messages: readonly PresentationMessage[],
  opportunity: PresentableOpportunity,
  config: DetectionConfig = detectionConfig,
): OpportunityPresentationVerdict {
  const sitting = currentSitting(messages, config);
  const counts = {
    userTurns: sitting.userTurns,
    userCharacters: sitting.userCharacters,
    needTurns: config.minUserTurnsBeforeCadenceOffer,
    needCharacters: config.minUserCharactersBeforeCadenceOffer,
  };

  /**
   * SHOWN ONCE PER SITTING, AT MOST.
   *
   * Checked before anything else, including the name match: a person who
   * names Don again in the same sitting has already been shown Don's card
   * and does not need it repeated. This is the rule that closes the observed
   * "effectively the same unchanged card, again" — see `needsRepresenting`,
   * whose recovery window is now bounded by the same sitting.
   */
  const offeredAt = opportunity.offeredAtIso === null ? NaN : Date.parse(opportunity.offeredAtIso);
  if (
    !Number.isNaN(offeredAt) &&
    sitting.startedAtMs !== null &&
    offeredAt >= sitting.startedAtMs
  ) {
    return { present: false, reason: "already_presented_in_this_sitting", ...counts };
  }

  /**
   * THE PERSON'S OWN CLAIM: tied to the turn that produced it, and to
   * nothing else. No name match is consulted on this branch — see the
   * counterexample in the docblock above.
   */
  if (opportunity.kind !== "no_mention_since") {
    if (opportunity.supersededByLaterContact === true) {
      return { present: false, reason: "superseded_by_later_contact", ...counts };
    }
    const raisedAt = Date.parse(opportunity.raisedAtIso);
    // Fail closed on an unreadable timestamp: an offer this code cannot
    // place in time is an offer it cannot justify raising now.
    if (
      Number.isNaN(raisedAt) ||
      sitting.startedAtMs === null ||
      raisedAt < sitting.startedAtMs
    ) {
      return { present: false, reason: "context_no_longer_supports_offer", ...counts };
    }
    return { present: true, reason: "raised_in_this_sitting", ...counts };
  }

  /**
   * THE APPLICATION'S OWN ARITHMETIC: no source turn to be tied to, so the
   * person raising that entity IS the invitation, and otherwise the
   * conversation has to be underway.
   */
  const text = latestUserMessage(messages);
  if (
    text !== null &&
    personNamedEntity({
      text,
      entityName: opportunity.entityName,
      aliases: opportunity.aliases,
    })
  ) {
    return { present: true, reason: "person_named_it", ...counts };
  }

  const verdict = cadenceMayBePresented(messages, config);
  return verdict.present
    ? { present: true, reason: "conversation_underway", ...counts }
    : { present: false, reason: "conversation_too_early_for_cadence", ...counts };
}
