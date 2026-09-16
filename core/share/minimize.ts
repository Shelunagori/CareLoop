import type { ReconnectProposal } from "@/core/detection/proposal";
import { findDeniedTerm } from "@/core/safety/deny-list";
import { shareConfig } from "./config";
import type { SharePayload } from "./payload";

/**
 * Minimization (docs/04 section 11.4).
 *
 * The one place a ReconnectProposal becomes something that may leave. It is a
 * projection, not a copy: the output is a fresh literal with six possible
 * fields, so the observation, the pattern, the entity id, the elapsed days and
 * the recipient's own name all stop here. There is no spread, no passthrough,
 * and no `...rest`, on purpose — a widened input type must not silently widen
 * what is shared.
 *
 * Note what this function is NOT given: a conversation, a message, an episode,
 * a signal explanation, or a baseline. It cannot leak them because it never
 * receives them.
 */

/**
 * Names are user-controlled text on the outbound path, so they are checked at
 * the boundary rather than trusted and caught later by the guard. Doing it
 * here is what lets the deterministic fallback be guard-safe BY CONSTRUCTION:
 * if a label could carry "lonely" into the template, the fallback would be the
 * one thing in the system with no fallback of its own.
 */
export function sanitizeLabel(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  const value = raw.replace(/\s+/g, " ").trim();
  if (value.length === 0) return null;
  if (value.length > shareConfig.maxLabelLength) return null;
  // Letters, marks, spaces, apostrophes, hyphens and dots. No digits, no
  // punctuation a sentence needs, no scheme separators.
  if (/[^\p{L}\p{M}\s'.-]/u.test(value)) return null;
  if (findDeniedTerm(value) !== null) return null;
  return value;
}

export function minimize(input: {
  proposal: ReconnectProposal;
  /** The only profile field the outbound path may see. */
  profile: { familyDisplayName: string | null };
}): SharePayload {
  const { proposal } = input;

  const from = sanitizeLabel(input.profile.familyDisplayName) ?? shareConfig.defaultFromDisplayName;

  const about = (proposal.alsoMention ?? [])
    .map(sanitizeLabel)
    .filter((name): name is string => name !== null)
    .slice(0, shareConfig.maxAlsoMention)[0];

  const timeframe = sanitizeLabel(proposal.timeframe) ?? undefined;

  const payload: SharePayload = {
    fromDisplayName: from,
    topic: proposal.eventType,
    question: proposal.question,
  };
  if (about !== undefined) payload.aboutEntityName = about;
  if (timeframe !== undefined) payload.timeframe = timeframe;

  // `freeNote` is never set here, and this function has no parameter that
  // could carry one. It exists for exactly one case — the user dictating a
  // message in their own words — which M4 has no authoring flow for. Deriving
  // it from a transcript summary would make the model the author of the one
  // field whose whole justification is that the user is (docs/04 s11.4).
  return payload;
}
