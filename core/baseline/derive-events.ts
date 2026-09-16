import type { InteractionClaim } from "@/core/memory/extraction-contract";
import { resolveAbsenceWindow, resolveTemporal, type TimePrecision } from "@/core/memory/temporal";
import { baselineConfig } from "./config";
import { stableHash } from "./hash";

/**
 * Deterministic derivation of interaction events from validated extraction
 * claims (docs/02 section 7).
 *
 * The model reported that contact of some kind was described. THIS decides
 * whether a row exists, when it happened, and how it is identified. No network,
 * no database, no clock of its own - the reference time is always the moment
 * the person actually said it.
 */
export type DerivedEventType = "visit" | "call";
export type DerivedPolarity = "positive" | "absence";

export type DerivedEvent = {
  entityId: string;
  eventType: DerivedEventType;
  polarity: DerivedPolarity;
  /** When it HAPPENED. */
  occurredAt: Date;
  occurredAtPrecision: TimePrecision;
  /** When the person SAID it. */
  reportedAt: Date;
  certainty: number;
  windowStart: Date | null;
  windowEnd: Date | null;
  sourceObservationId: string;
  /** Identifies the SOURCE EVIDENCE, not a statistical day bucket. */
  ingestFingerprint: string;
};

export type SkippedClaim = {
  participantMention: string;
  reason:
    | "unresolved_participant"
    | "below_certainty"
    | "absence_window_underivable";
};

export type DerivationResult = {
  events: DerivedEvent[];
  skipped: SkippedClaim[];
};

export function deriveInteractionEvents(input: {
  claims: readonly InteractionClaim[];
  /** Mentions already resolved by the deterministic entity resolver. */
  entityIdByMention: ReadonlyMap<string, string>;
  sourceObservationId: string;
  /** The moment the message was sent - the anchor for every relative phrase. */
  reportedAt: Date;
  config?: { minCertainty: number };
}): DerivationResult {
  const minCertainty = input.config?.minCertainty ?? baselineConfig.minCertainty;
  const events: DerivedEvent[] = [];
  const skipped: SkippedClaim[] = [];

  for (const [claimIndex, claim] of input.claims.entries()) {
    const entityId = input.entityIdByMention.get(claim.participantMention);
    if (!entityId) {
      // An ambiguous or unknown participant must not become countable
      // evidence attached to a guess.
      skipped.push({
        participantMention: claim.participantMention,
        reason: "unresolved_participant",
      });
      continue;
    }

    // A low-certainty claim stays in the observation payload - it is still
    // what the model said - but it never silently becomes baseline evidence.
    if (claim.certainty < minCertainty) {
      skipped.push({
        participantMention: claim.participantMention,
        reason: "below_certainty",
      });
      continue;
    }

    const resolved = resolveTemporal({
      claim: claim.temporal,
      referenceAt: input.reportedAt,
    });

    let windowStart: Date | null = null;
    let windowEnd: Date | null = null;

    if (claim.polarity === "absence") {
      const window = resolveAbsenceWindow({
        claim: claim.temporal,
        referenceAt: input.reportedAt,
      });
      if (!window) {
        skipped.push({
          participantMention: claim.participantMention,
          reason: "absence_window_underivable",
        });
        continue;
      }
      windowStart = window.start;
      windowEnd = window.end;
    }

    events.push({
      entityId,
      eventType: claim.eventType,
      polarity: claim.polarity,
      occurredAt: resolved.occurredAt,
      occurredAtPrecision: resolved.precision,
      reportedAt: input.reportedAt,
      certainty: claim.certainty,
      windowStart,
      windowEnd,
      sourceObservationId: input.sourceObservationId,
      ingestFingerprint: eventFingerprint({
        sourceObservationId: input.sourceObservationId,
        claimIndex,
        sourceSpan: claim.sourceSpan,
        entityId,
        eventType: claim.eventType,
        polarity: claim.polarity,
        windowStart,
        windowEnd,
        occurredAt: resolved.occurredAt,
      }),
    });
  }

  return { events, skipped };
}

/**
 * Ingestion idempotency, NOT statistical normalization (R6).
 *
 * The fingerprint identifies the piece of evidence that produced the row: the
 * observation it came from, plus the resolved event it describes. Replaying
 * the same observation therefore produces the same fingerprint and the unique
 * index refuses the duplicate.
 *
 * It deliberately does NOT bucket by calendar day. "John called this morning"
 * and "John called again this evening" are two genuine interactions and must
 * both be stored; collapsing them here would make cadence a measure of how
 * chatty someone is. That collapse belongs inside computeBaseline and nowhere
 * else.
 *
 * `claimIndex` is what makes that possible. Both of those sentences resolve to
 * the same calendar day, so every other component of the fingerprint is
 * identical and the unique index would swallow the second. The claim's
 * position within the observation payload distinguishes them - and because the
 * payload is written once and never rewritten, that position is stable across
 * replays, so idempotency survives. `sourceSpan` is included alongside it so
 * the fingerprint is traceable to real evidence rather than to a bare counter.
 */
export function eventFingerprint(input: {
  sourceObservationId: string;
  claimIndex: number;
  sourceSpan: string;
  entityId: string;
  eventType: string;
  polarity: string;
  occurredAt: Date;
  windowStart: Date | null;
  windowEnd: Date | null;
}): string {
  return stableHash([
    "interaction.v1",
    input.sourceObservationId,
    input.claimIndex,
    input.sourceSpan,
    input.entityId,
    input.eventType,
    input.polarity,
    input.occurredAt.toISOString(),
    input.windowStart ? input.windowStart.toISOString() : null,
    input.windowEnd ? input.windowEnd.toISOString() : null,
  ]);
}
