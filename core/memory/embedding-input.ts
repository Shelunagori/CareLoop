/**
 * The canonical text an episode is embedded from.
 *
 * Documented and deterministic so the same episode always produces the same
 * embedding request — which is what makes recorded fixtures reproducible and
 * lets a retry be a no-op rather than a second, subtly different vector.
 *
 * Format: the summary, then participant names sorted alphabetically.
 * Nothing else — no ids, no timestamps, no salience — because those would
 * change the vector without changing the meaning.
 */
export function episodeEmbeddingInput(input: {
  summary: string;
  participantNames: readonly string[];
}): string {
  const participants = [...new Set(input.participantNames.map((n) => n.trim()).filter(Boolean))]
    .sort()
    .join(", ");
  return participants
    ? `${input.summary.trim()}\nPeople and pets involved: ${participants}`
    : input.summary.trim();
}
