import { z } from "zod";
import type { Baseline } from "@/core/baseline/compute";
import type { DetectorEventType, ReconnectExplanation } from "./types";
import type { ShareTopic } from "@/core/share/payload";

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
export type ClosedReconnectQuestion =
  | "ask_if_visiting"
  | "ask_if_calling"
  /**
   * M12e. The only question a wellbeing share ever asks, and it asks for
   * nothing about the person's health: whether the reader will check in.
   */
  | "ask_if_checking_in";

export const CLOSED_RECONNECT_QUESTIONS = [
  "ask_if_visiting",
  "ask_if_calling",
  "ask_if_checking_in",
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
      /**
       * WHEN THEY SAID IT — the source turn's `reported_at`, copied from the
       * explanation (M12e.1).
       *
       * The window is what they said about; this is when they said it, and
       * only the second one answers "is this still the moment to raise it".
       * Optional because rows written before M12e.1 do not carry it; the
       * presentation path falls back to the opportunity's own `created_at`,
       * which is the sweep that ingested the assertion and therefore the
       * closest honest substitute.
       */
      statedAt?: string;
    }
  /**
   * The person said they were unwell (M12e).
   *
   * ONE field, and it is a calendar date. Not a severity, not a symptom,
   * not a duration, not their sentence. What they said is established
   * deterministically from their own words by
   * `core/wellbeing/self-report.ts`; what LEAVES is the bare fact that they
   * said it, on a day. There is nowhere here to put a clinical claim, which
   * is a stronger guarantee than an instruction not to make one.
   */
  | { kind: "self_reported_wellbeing"; reportedOn: string };

export type ReconnectProposal = {
  entityId: string;
  entityName: string;
  /** Related entities from CONFIRMED structured memory only. Never guessed. */
  alsoMention?: string[];
  /**
   * Absent on a wellbeing proposal, which is not about an event between two
   * people. Optional rather than faked: writing `eventType: "call"` on a
   * message about somebody's health would be a lie stored in a column.
   */
  eventType?: DetectorEventType;
  /**
   * The outbound topic. Absent on every row written before M12e, where it is
   * derived from `eventType` — see `proposalTopic`.
   */
  topic?: ShareTopic;
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

/**
 * The outbound topic of a stored proposal, or null when it has neither.
 *
 * Total over old and new rows: before M12e a proposal carried only
 * `eventType`, and `visit`/`call` were both the event type AND the topic.
 */
export function proposalTopic(proposal: ReconnectProposal): ShareTopic | null {
  return proposal.topic ?? proposal.eventType ?? null;
}

export function buildProposal(input: {
  explanation: ReconnectExplanation;
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
          statedAt: explanation.reportedAt,
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
export const ReconnectProposalSchema = z
  .object({
    entityId: z.string().min(1),
    entityName: z.string().min(1),
    alsoMention: z.array(z.string().min(1)).optional(),
    eventType: z.enum(["visit", "call"]).optional(),
    topic: z.enum(["visit", "call", "wellbeing"]).optional(),
    observation: z.union([
      z.object({ kind: z.literal("no_mention_since"), days: z.number() }),
      z.object({
        kind: z.literal("user_stated_absence"),
        statedPhrase: z.string().min(1).optional(),
        window: z.object({ start: z.string(), end: z.string() }),
        statedAt: z.string().min(1).optional(),
      }),
      z.object({
        kind: z.literal("self_reported_wellbeing"),
        reportedOn: z.string().min(1),
      }),
    ]),
    pattern: z.object({ medianGapDays: z.number() }).optional(),
    question: z.enum(CLOSED_RECONNECT_QUESTIONS),
    timeframe: z.string().optional(),
  })
  /**
   * `eventType` became optional so a wellbeing proposal need not invent one.
   * That would have WEAKENED the check for every reconnect row, so the two
   * shapes are pinned instead: a wellbeing observation must carry the
   * wellbeing topic and no event type, and anything else must carry an event
   * type. A row that satisfies neither is rejected, exactly as a row with a
   * missing `eventType` was before.
   */
  .superRefine((proposal, ctx) => {
    const isWellbeing = proposal.observation.kind === "self_reported_wellbeing";
    if (isWellbeing) {
      if (proposal.eventType !== undefined) {
        ctx.addIssue({ code: "custom", message: "wellbeing proposal must not carry an eventType" });
      }
      if (proposal.topic !== "wellbeing") {
        ctx.addIssue({ code: "custom", message: "wellbeing proposal must carry topic 'wellbeing'" });
      }
      if (proposal.question !== "ask_if_checking_in") {
        ctx.addIssue({ code: "custom", message: "wellbeing proposal must ask_if_checking_in" });
      }
      return;
    }
    if (proposal.eventType === undefined) {
      ctx.addIssue({ code: "custom", message: "reconnect proposal requires an eventType" });
    }
    if (proposal.topic === "wellbeing") {
      ctx.addIssue({ code: "custom", message: "only a wellbeing observation may carry topic 'wellbeing'" });
    }
  });
