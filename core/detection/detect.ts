import type { SignalCandidate } from "./types";

/**
 * Precedence between detectors (docs/03 section 10.2).
 *
 * "If both fire for the same entity only this one survives." The losing
 * candidate is discarded HERE, before anything is persisted — it is not
 * written as a suppressed signal. Suppression answers "why didn't CareLoop say
 * anything?"; this answers "which of two descriptions of the same situation is
 * the one worth persisting", which is a different question with a different
 * audience. Writing a suppressed cadence row alongside every absence signal
 * would fill the audit log with noise about a decision that was never close.
 *
 * Grouping is by ENTITY, not by (entity, event type): "you haven't seen John"
 * and "no call from John in a while" are one social situation, and the whole
 * point of the rule is that the person is asked about John once.
 */
export const DISCARD_REASONS = {
  outrankedByAbsence: "outranked_by_user_asserted_absence",
  supersededByNewerEvidence: "superseded_by_newer_evidence",
} as const;

export type DiscardReason = (typeof DISCARD_REASONS)[keyof typeof DISCARD_REASONS];

export type DiscardedCandidate = {
  candidate: SignalCandidate;
  reason: DiscardReason;
  /** The candidate that won for this entity. */
  winnerDetectionKey: string;
};

export type ResolvedDetections = {
  selected: SignalCandidate[];
  discarded: DiscardedCandidate[];
};

/**
 * Total order, so the outcome never depends on input order:
 *   priority desc -> evidence recency desc -> detectionKey asc.
 * The last term is arbitrary but STABLE, which is the property that matters:
 * two runs over the same evidence must not disagree.
 */
function compare(a: SignalCandidate, b: SignalCandidate): number {
  if (a.priority !== b.priority) return b.priority - a.priority;
  if (a.orderedAt !== b.orderedAt) return b.orderedAt - a.orderedAt;
  return a.detectionKey < b.detectionKey ? -1 : a.detectionKey > b.detectionKey ? 1 : 0;
}

export function resolveDetections(
  candidates: readonly SignalCandidate[],
): ResolvedDetections {
  const byEntity = new Map<string, SignalCandidate[]>();
  for (const candidate of candidates) {
    const bucket = byEntity.get(candidate.entityId);
    if (bucket) bucket.push(candidate);
    else byEntity.set(candidate.entityId, [candidate]);
  }

  const selected: SignalCandidate[] = [];
  const discarded: DiscardedCandidate[] = [];

  for (const bucket of byEntity.values()) {
    const ordered = [...bucket].sort(compare);
    const winner = ordered[0];
    selected.push(winner);
    for (const loser of ordered.slice(1)) {
      discarded.push({
        candidate: loser,
        reason:
          loser.signalType === "cadence_gap" &&
          winner.signalType === "user_asserted_absence"
            ? DISCARD_REASONS.outrankedByAbsence
            : DISCARD_REASONS.supersededByNewerEvidence,
        winnerDetectionKey: winner.detectionKey,
      });
    }
  }

  // Stable output order, for tests and for a readable debug view.
  selected.sort(compare);
  return { selected, discarded };
}
