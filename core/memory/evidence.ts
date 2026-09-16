/**
 * The candidate → confirmed policy for structured memory (docs/02 §5).
 *
 * The extraction model can never set `confirmed`. It reports claims; this pure
 * function decides what the system believes. One passing mention stays a
 * candidate — usable as context, never asserted back to the person as fact.
 * That is what stops a single misheard sentence becoming a permanent belief.
 */
export type EvidenceStatus = "candidate" | "confirmed";

export type EvidenceState = {
  /** Provenance: which observations produced this belief. */
  observationIds: readonly string[];
  /** Which conversations they came from — distinct conversations is the bar. */
  conversationIds: readonly string[];
  /** The person said so directly ("yes, John's my son"). */
  explicitlyConfirmed: boolean;
};

/** Distinct conversations required, absent an explicit confirmation. */
export const EVIDENCE_CONFIRM_THRESHOLD = 2;

export const EMPTY_EVIDENCE: EvidenceState = {
  observationIds: [],
  conversationIds: [],
  explicitlyConfirmed: false,
};

function union(a: readonly string[], b: readonly string[]): string[] {
  return [...new Set([...a, ...b])].sort();
}

/**
 * Set union, which is what makes evidence replay-safe: re-processing the same
 * observation contributes nothing new, so a retried job cannot inflate a
 * belief into confirmation.
 */
export function mergeEvidence(
  existing: EvidenceState,
  incoming: EvidenceState,
): EvidenceState {
  return {
    observationIds: union(existing.observationIds, incoming.observationIds),
    conversationIds: union(existing.conversationIds, incoming.conversationIds),
    explicitlyConfirmed: existing.explicitlyConfirmed || incoming.explicitlyConfirmed,
  };
}

/** Evidence is counted in distinct conversations, not in mentions. */
export function evidenceCount(state: EvidenceState): number {
  return state.conversationIds.length;
}

export function promoteStatus(state: EvidenceState): EvidenceStatus {
  if (state.explicitlyConfirmed) return "confirmed";
  return evidenceCount(state) >= EVIDENCE_CONFIRM_THRESHOLD ? "confirmed" : "candidate";
}
