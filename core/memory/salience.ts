/**
 * Deterministic salience.
 *
 * Asking the model "how important was this?" returns a number that is unstable
 * across runs and impossible to tune. These are observable features with
 * documented weights, so a ranking can be explained and a weight change is a
 * reviewable diff (docs/02 §6).
 */
export type SalienceFeatures = {
  /** The episode involves an entity the user has a confirmed relationship with. */
  mentionsKnownRelationshipEntity: boolean;
  /** How many distinct named entities take part. */
  namedEntityCount: number;
  /** The person anchored it in time ("yesterday"), so it is an event, not a musing. */
  hasExplicitTemporal: boolean;
  /** Emotion words the PERSON used — never the model's read of their mood. */
  emotionWordCount: number;
  /** No existing episode says roughly the same thing. */
  isNovel: boolean;
};

export const SALIENCE_WEIGHTS = {
  base: 0.2,
  knownRelationship: 0.2,
  namedEntity: 0.1,
  namedEntityCap: 0.2,
  explicitTemporal: 0.15,
  emotionWord: 0.075,
  emotionWordCap: 0.15,
  novelty: 0.15,
} as const;

export function computeSalience(features: SalienceFeatures): number {
  let score = SALIENCE_WEIGHTS.base;

  if (features.mentionsKnownRelationshipEntity) score += SALIENCE_WEIGHTS.knownRelationship;

  score += Math.min(
    features.namedEntityCount * SALIENCE_WEIGHTS.namedEntity,
    SALIENCE_WEIGHTS.namedEntityCap,
  );

  if (features.hasExplicitTemporal) score += SALIENCE_WEIGHTS.explicitTemporal;

  score += Math.min(
    features.emotionWordCount * SALIENCE_WEIGHTS.emotionWord,
    SALIENCE_WEIGHTS.emotionWordCap,
  );

  if (features.isNovel) score += SALIENCE_WEIGHTS.novelty;

  return Math.min(1, Math.max(0, Number(score.toFixed(4))));
}
