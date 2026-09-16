import { z } from "zod";
import type { Baseline } from "@/core/baseline/compute";
import type { DetectorEventType, SignalExplanation } from "./types";

/**
 * The ReconnectProposal (docs/03 section 10.4).
 *
 * Structured, observable facts only. This is the object the whole safety
 * argument rests on: the LLM never sees the conversation, it sees a minimized
 * projection of THIS, and every field here is a stored value or arithmetic
 * over stored values.
 *
 * Note what the type cannot express: mood, worry, health, risk, urgency, or
 * any claim about why a gap exists. There is nowhere to put them, which is a
 * stronger guarantee than an instruction not to.
 */
export type ClosedReconnectQuestion = "ask_if_visiting" | "ask_if_calling";

export const CLOSED_RECONNECT_QUESTIONS = [
  "ask_if_visiting",
  "ask_if_calling",
] as const satisfies readonly ClosedReconnectQuestion[];

export type ReconnectObservation =
  /** The statistics noticed a gap. `days` is elapsed time, not a judgement. */
  | { kind: "no_mention_since"; days: number }
  /**
   * The person said it themselves.
   *
   * Two fields, because they are two different kinds of claim and conflating
   * them was a bug. `window` is what the deterministic resolver worked out and
   * is always present; it is presented as dates because that is what it is.
   * `statedPhrase` is the person's actual wording, recovered from the
   * immutable observation, and is present ONLY when it really was recovered.
   *
   * The earlier field was called `quotedWindow` and held "2026-09-09 to
   * 2026-09-16" — a generated date range dressed up as a quotation. Nobody
   * said that. A field named for a quote must contain one or be absent.
   */
  | {
      kind: "user_stated_absence";
      statedPhrase?: string;
      window: { start: string; end: string };
    };

export type ReconnectProposal = {
  entityId: string;
  entityName: string;
  /** Related entities from CONFIRMED structured memory only. Never guessed. */
  alsoMention?: string[];
  eventType: DetectorEventType;
  observation: ReconnectObservation;
  /** Omitted entirely when there is no ACTIVE baseline: no pattern, no claim. */
  pattern?: { medianGapDays: number };
  question: ClosedReconnectQuestion;
  /** Reserved. M4 never populates it — see buildProposal. */
  timeframe?: string;
};

export function questionFor(eventType: DetectorEventType): ClosedReconnectQuestion {
  return eventType === "call" ? "ask_if_calling" : "ask_if_visiting";
}

export function buildProposal(input: {
  explanation: SignalExplanation;
  entityName: string;
  /** Display names of confirmed related entities, already bounded. */
  alsoMention: readonly string[];
  /** Attached for phrasing confidence only. */
  baseline: Baseline | null;
}): ReconnectProposal {
  const { explanation } = input;

  const observation: ReconnectObservation =
    explanation.detector === "cadence_gap"
      ? { kind: "no_mention_since", days: explanation.daysSinceLast }
      : {
          kind: "user_stated_absence",
          // Present only when the observation really yielded it.
          ...(explanation.statedPhrase !== null
            ? { statedPhrase: explanation.statedPhrase }
            : {}),
          window: {
            start: explanation.absenceWindowStart,
            end: explanation.absenceWindowEnd,
          },
        };

  // A pattern claim requires an ACTIVE baseline. With NO_BASELINE or
  // IRREGULAR the system knows no rhythm, so it asserts none — the confidence
  // of the language stays bound to the confidence of the evidence.
  const baseline = input.baseline;
  const pattern =
    baseline !== null && baseline.status === "ACTIVE" && baseline.medianGapDays !== null
      ? { medianGapDays: baseline.medianGapDays }
      : undefined;

  const proposal: ReconnectProposal = {
    entityId: explanation.entityId,
    entityName: input.entityName,
    eventType: explanation.eventType,
    observation,
    question: questionFor(explanation.eventType),
  };

  if (input.alsoMention.length > 0) proposal.alsoMention = [...input.alsoMention];
  if (pattern) proposal.pattern = pattern;

  // `timeframe` is deliberately absent in M4. It is a SUGGESTION ("this
  // weekend") for which the system holds no evidence, and inventing one here
  // would put an unevidenced claim into the one object that is allowed to
  // leave. The field stays in the type for M5/M6 to populate from something
  // real — the user's own words.
  return proposal;
}

/**
 * Read-side validation for a stored proposal.
 *
 * The row was written by this system, so this is not distrust of the model —
 * it is distrust of TIME. A proposal persisted by an older deploy is parsed by
 * a newer one, and `as ReconnectProposal` on a jsonb column would turn a shape
 * change into an undefined-property bug several layers downstream, in the code
 * that decides what leaves the conversation.
 */
export const ReconnectProposalSchema = z.object({
  entityId: z.string().min(1),
  entityName: z.string().min(1),
  alsoMention: z.array(z.string().min(1)).optional(),
  eventType: z.enum(["visit", "call"]),
  observation: z.union([
    z.object({ kind: z.literal("no_mention_since"), days: z.number() }),
    z.object({
      kind: z.literal("user_stated_absence"),
      statedPhrase: z.string().min(1).optional(),
      window: z.object({ start: z.string(), end: z.string() }),
    }),
  ]),
  pattern: z.object({ medianGapDays: z.number() }).optional(),
  question: z.enum(CLOSED_RECONNECT_QUESTIONS),
  timeframe: z.string().optional(),
});
