import type { ReconnectProposal } from "@/core/detection/proposal";
import { sanitizeLabel } from "@/core/share/minimize";

/**
 * Turning "I wasn't feeling good today" into something that may be offered
 * (M12e).
 *
 * Pure, and deliberately tiny. Everything the offer will eventually carry is
 * decided here, from two inputs: who the recipient is, and the calendar day
 * the person said it. Nothing else is available to this function, so nothing
 * else can end up in the message.
 */

/** yyyy-mm-dd, UTC — the same calendar-day convention M3 established. */
export function reportedOnUtc(now: Date): string {
  return now.toISOString().slice(0, 10);
}

/**
 * The proposal for a wellbeing share, or null when the recipient's stored
 * label is not something to put in front of a person.
 *
 * `alsoMention` and `pattern` are structurally absent: there is no rhythm to
 * a self-report and no third party to name in one.
 */
export function buildWellbeingProposal(input: {
  entityId: string;
  entityName: string;
  reportedOn: string;
}): ReconnectProposal | null {
  const entityName = sanitizeLabel(input.entityName);
  if (entityName === null) return null;

  return {
    entityId: input.entityId,
    entityName,
    topic: "wellbeing",
    observation: { kind: "self_reported_wellbeing", reportedOn: input.reportedOn },
    question: "ask_if_checking_in",
  };
}

/**
 * The sentence CareLoop shows ABOVE the draft, explaining why it is asking.
 *
 * The reconnect equivalent (`buildCadencePreamble`) exists because a cadence
 * offer is the application's own observation and arrives unexplained. This
 * one exists for the opposite reason: the person DID say it, and the
 * preamble's job is to make clear that CareLoop is repeating them rather
 * than having concluded something about them.
 */
export function buildWellbeingPreamble(): string {
  return "You mentioned you weren't feeling well.";
}
