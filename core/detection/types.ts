import { z } from "zod";
import type { Baseline } from "@/core/baseline/compute";

/**
 * Detection vocabulary (docs/03 section 10).
 *
 * A detector answers one question: given evidence the system already holds,
 * is there something OBSERVABLE worth raising? It never answers "is this
 * person lonely", "is this relationship in trouble", or anything else about an
 * internal state. The explanation objects below are the whole of what a
 * detector may say, and every field in them is either a stored value or an
 * arithmetic consequence of stored values.
 */
export const DETECTION_METHOD_VERSION = "detection.v1";

export type DetectorEventType = "visit" | "call";
export type SignalType = "cadence_gap" | "user_asserted_absence";

/** Baseline facts safe to attach to a signal: statistics and provenance. */
export type BaselineSummary = {
  status: Baseline["status"];
  medianGapDays: number | null;
  madDays: number | null;
  inputsHash: string;
};

export type CadenceExplanation = {
  detector: "cadence_gap";
  methodVersion: string;
  /**
   * The logical identity of this piece of evidence. NOT time-derived: the same
   * evidence re-examined tomorrow produces the same key, so a repeated sweep
   * is a no-op rather than a new claim about the world.
   */
  detectionKey: string;
  entityId: string;
  eventType: DetectorEventType;
  medianGapDays: number;
  madDays: number;
  thresholdDays: number;
  daysSinceLast: number;
  lastEventId: string;
  /** yyyy-mm-dd, UTC, matching the calendar-day semantics M3 established. */
  lastEventDate: string;
  contributingEventCount: number;
  baselineInputsHash: string;
  /** Which conversation the sweep ran from. Never part of the identity. */
  conversationId: string | null;
};

export type AbsenceExplanation = {
  detector: "user_asserted_absence";
  methodVersion: string;
  detectionKey: string;
  entityId: string;
  eventType: DetectorEventType;
  /** The stored absence interaction_event this signal rests on. */
  sourceEventId: string;
  absenceWindowStart: string;
  absenceWindowEnd: string;
  /**
   * The person's own phrase, recovered from the immutable observation, or null
   * when it cannot be recovered without guessing. Null is a legitimate answer:
   * the resolved window is always available, and inventing a quote to fill the
   * field would be worse than admitting there isn't one.
   */
  statedPhrase: string | null;
  reportedAt: string;
  certainty: number;
  /** Enrichment only. An absence assertion never requires a baseline. */
  baseline: BaselineSummary | null;
  conversationId: string | null;
};

export type SignalExplanation = CadenceExplanation | AbsenceExplanation;

/**
 * A detector's output before anything is persisted.
 *
 * `orderedAt` and `priority` exist only so that precedence between candidates
 * is a total order rather than a coin toss (see resolveDetections).
 */
export type SignalCandidate = {
  signalType: SignalType;
  entityId: string;
  eventType: DetectorEventType;
  detectionKey: string;
  explanation: SignalExplanation;
  priority: number;
  /** Epoch ms of the evidence this candidate rests on. */
  orderedAt: number;
};

/**
 * Read-side validation for a STORED explanation.
 *
 * Needed because a signal can be picked up by a later process than the one
 * that wrote it — that is the whole point of the recovery path. Resuming a
 * cycle means completing THAT signal's claim, so the explanation has to be
 * read back and trusted only after it parses. `as CadenceExplanation` on a
 * jsonb column would turn a shape change into an undefined-property bug inside
 * the code that decides what leaves the conversation.
 */
const BaselineSummarySchema = z.object({
  status: z.enum(["NO_BASELINE", "IRREGULAR", "ACTIVE"]),
  medianGapDays: z.number().nullable(),
  madDays: z.number().nullable(),
  inputsHash: z.string(),
});

export const CadenceExplanationSchema = z.object({
  detector: z.literal("cadence_gap"),
  methodVersion: z.string(),
  detectionKey: z.string().min(1),
  entityId: z.string().min(1),
  eventType: z.enum(["visit", "call"]),
  medianGapDays: z.number(),
  madDays: z.number(),
  thresholdDays: z.number(),
  daysSinceLast: z.number(),
  lastEventId: z.string(),
  lastEventDate: z.string(),
  contributingEventCount: z.number(),
  baselineInputsHash: z.string(),
  conversationId: z.string().nullable(),
});

export const AbsenceExplanationSchema = z.object({
  detector: z.literal("user_asserted_absence"),
  methodVersion: z.string(),
  detectionKey: z.string().min(1),
  entityId: z.string().min(1),
  eventType: z.enum(["visit", "call"]),
  sourceEventId: z.string().min(1),
  absenceWindowStart: z.string(),
  absenceWindowEnd: z.string(),
  statedPhrase: z.string().nullable(),
  reportedAt: z.string(),
  certainty: z.number(),
  baseline: BaselineSummarySchema.nullable(),
  conversationId: z.string().nullable(),
});

export const SignalExplanationSchema = z.discriminatedUnion("detector", [
  CadenceExplanationSchema,
  AbsenceExplanationSchema,
]);
