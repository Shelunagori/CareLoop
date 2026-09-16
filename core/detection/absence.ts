import type { Baseline } from "@/core/baseline/compute";
import { baselineConfig, type BaselineConfig } from "@/core/baseline/config";
import { stableHash } from "@/core/baseline/hash";
import {
  DETECTION_METHOD_VERSION,
  type AbsenceExplanation,
  type BaselineSummary,
  type DetectorEventType,
  type SignalCandidate,
} from "./types";

/**
 * The user-asserted-absence detector (docs/03 section 10.2, D6).
 *
 * "I haven't seen John this week" is not the absence of data — it is positive
 * evidence of non-occurrence over a window, stated by the only person who
 * actually knows. That is why this detector needs no baseline at all and why
 * it outranks the statistical one: our arithmetic is an inference about the
 * person's life, their sentence is a report of it.
 *
 * It reads the persisted absence event, never the episode text and never the
 * model's phrasing. Nothing here reconstructs what they felt.
 */
export const ABSENCE_PRIORITY = 2;

export type AbsenceEventInput = {
  id: string;
  entityId: string;
  eventType: DetectorEventType;
  polarity: "positive" | "absence";
  windowStart: Date | null;
  windowEnd: Date | null;
  reportedAt: Date;
  certainty: number;
  /**
   * The person's own words for the window, already recovered from the
   * observation by the service layer. The detector does no I/O, so it is given
   * the phrase rather than fetching it.
   */
  statedPhrase?: string | null;
};

export function absenceDetectionKey(sourceEventId: string): string {
  return stableHash([DETECTION_METHOD_VERSION, "user_asserted_absence", sourceEventId]);
}

/** Baseline enrichment carries statistics and provenance, never gate reasons. */
export function summarizeBaseline(baseline: Baseline | null): BaselineSummary | null {
  if (baseline === null) return null;
  return {
    status: baseline.status,
    medianGapDays: baseline.medianGapDays,
    madDays: baseline.madDays,
    inputsHash: baseline.inputsHash,
  };
}

export function detectAssertedAbsence(input: {
  event: AbsenceEventInput;
  /** Optional enrichment. Any status is fine, including none at all. */
  baseline: Baseline | null;
  now: Date;
  conversationId: string | null;
  config?: BaselineConfig;
}): SignalCandidate | null {
  const config = input.config ?? baselineConfig;
  const { event } = input;

  if (event.polarity !== "absence") return null;
  // The schema already refuses an absence row without both ends; a detector
  // that trusted that and was wrong would emit a window of "null to null".
  if (event.windowStart === null || event.windowEnd === null) return null;
  if (event.windowEnd.getTime() <= event.windowStart.getTime()) return null;
  // Same certainty floor the statistics use: "I think John might not have
  // been" is not a statement we act on.
  if (event.certainty < config.minCertainty) return null;
  // A report from the future is a clock or ingestion fault, not evidence.
  if (event.reportedAt.getTime() > input.now.getTime()) return null;

  const detectionKey = absenceDetectionKey(event.id);

  const explanation: AbsenceExplanation = {
    detector: "user_asserted_absence",
    methodVersion: DETECTION_METHOD_VERSION,
    detectionKey,
    entityId: event.entityId,
    eventType: event.eventType,
    sourceEventId: event.id,
    absenceWindowStart: event.windowStart.toISOString(),
    absenceWindowEnd: event.windowEnd.toISOString(),
    statedPhrase: event.statedPhrase ?? null,
    reportedAt: event.reportedAt.toISOString(),
    certainty: event.certainty,
    baseline: summarizeBaseline(input.baseline),
    conversationId: input.conversationId,
  };

  return {
    signalType: "user_asserted_absence",
    entityId: event.entityId,
    eventType: event.eventType,
    detectionKey,
    explanation,
    priority: ABSENCE_PRIORITY,
    orderedAt: event.reportedAt.getTime(),
  };
}
