import {
  computeCadenceThreshold,
  type Baseline,
  type BaselineInputEvent,
} from "@/core/baseline/compute";
import { baselineConfig, type BaselineConfig } from "@/core/baseline/config";
import { daysBetween, utcDayKey } from "@/core/baseline/day";
import { stableHash } from "@/core/baseline/hash";
import {
  DETECTION_METHOD_VERSION,
  type CadenceExplanation,
  type DetectorEventType,
  type SignalCandidate,
} from "./types";

/**
 * The cadence-gap detector (docs/03 section 10.1).
 *
 * It knows two things and nothing else: what the historical rhythm was, and
 * how long it has been. It does not know, and must never appear to know, why.
 *
 * Requires an ACTIVE baseline. NO_BASELINE means there is not enough evidence
 * to say what normal is; IRREGULAR means there IS evidence and it says this
 * relationship has no rhythm, so a gap signal would be noise. Neither may fire.
 */
export const CADENCE_PRIORITY = 1;

/**
 * The most recent event that would actually have contributed to the baseline.
 *
 * Deliberately the same predicate computeBaseline uses. Picking "the newest
 * row" instead would let an absence assertion, a low-certainty guess or a
 * vague "recently" reset the clock on a gap the statistics never saw.
 */
export function lastQualifyingEvent(
  events: readonly BaselineInputEvent[],
  now: Date,
  config: BaselineConfig = baselineConfig,
): BaselineInputEvent | null {
  let best: BaselineInputEvent | null = null;
  for (const event of events) {
    if (event.polarity !== "positive") continue;
    if (event.certainty < config.minCertainty) continue;
    if (event.occurredAtPrecision !== "exact" && event.occurredAtPrecision !== "day") continue;
    // A contact dated in the future is not evidence of anything yet, and
    // letting one through would produce a negative elapsed time.
    if (event.occurredAt.getTime() > now.getTime()) continue;
    if (best === null || event.occurredAt.getTime() > best.occurredAt.getTime()) best = event;
  }
  return best;
}

/**
 * Identity of a cadence claim: WHICH evidence produced it, never WHEN it was
 * noticed. Same baseline inputs and same last event -> same key -> a repeated
 * sweep recognises its own earlier conclusion instead of restating it.
 */
export function cadenceDetectionKey(input: {
  entityId: string;
  eventType: DetectorEventType;
  baselineInputsHash: string;
  lastEventId: string;
}): string {
  return stableHash([
    DETECTION_METHOD_VERSION,
    "cadence_gap",
    input.entityId,
    input.eventType,
    input.baselineInputsHash,
    input.lastEventId,
  ]);
}

export function detectCadenceGap(input: {
  entityId: string;
  eventType: DetectorEventType;
  baseline: Baseline;
  /** The qualifying series, in any order. */
  events: readonly BaselineInputEvent[];
  now: Date;
  conversationId: string | null;
  config?: BaselineConfig;
}): SignalCandidate | null {
  const config = input.config ?? baselineConfig;
  const { baseline } = input;

  if (baseline.status !== "ACTIVE") return null;
  // ACTIVE guarantees both by construction; the check keeps the arithmetic
  // total rather than relying on that guarantee holding forever.
  if (baseline.medianGapDays === null || baseline.madDays === null) return null;

  const last = lastQualifyingEvent(input.events, input.now, config);
  if (last === null) return null;

  const daysSinceLast = daysBetween(last.occurredAt, input.now);
  // Defensive: lastQualifyingEvent already excludes the future.
  if (daysSinceLast < 0) return null;

  const thresholdDays = computeCadenceThreshold(baseline.medianGapDays, baseline.madDays, config);

  // Strictly greater. At exactly the threshold the silence is still inside
  // tolerance, and the demo's two-day margin depends on this being `>`.
  if (!(daysSinceLast > thresholdDays)) return null;

  const detectionKey = cadenceDetectionKey({
    entityId: input.entityId,
    eventType: input.eventType,
    baselineInputsHash: baseline.inputsHash,
    lastEventId: last.id,
  });

  const explanation: CadenceExplanation = {
    detector: "cadence_gap",
    methodVersion: DETECTION_METHOD_VERSION,
    detectionKey,
    entityId: input.entityId,
    eventType: input.eventType,
    medianGapDays: baseline.medianGapDays,
    madDays: baseline.madDays,
    thresholdDays,
    daysSinceLast,
    lastEventId: last.id,
    lastEventDate: utcDayKey(last.occurredAt),
    contributingEventCount: baseline.observationCount,
    baselineInputsHash: baseline.inputsHash,
    conversationId: input.conversationId,
  };

  return {
    signalType: "cadence_gap",
    entityId: input.entityId,
    eventType: input.eventType,
    detectionKey,
    explanation,
    priority: CADENCE_PRIORITY,
    orderedAt: last.occurredAt.getTime(),
  };
}
