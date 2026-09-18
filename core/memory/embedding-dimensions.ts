/**
 * Reconciling a 1024-number model with a 1536-number column.
 *
 * `episodes.embedding` is `extensions.vector(1536)` and `match_episodes` takes
 * `p_query extensions.vector(1536)`. Both were sized for OpenAI's
 * text-embedding-3-small. BGE-M3 returns 1024. Changing the column means a
 * migration, an HNSW rebuild and a re-embed of every row; appending 512 zeros
 * means none of that, and costs nothing mathematically:
 *
 *   cos(a, b) = (a . b) / (|a| |b|)
 *
 * Appending the same zeros to both vectors adds only `0 * 0` terms to the dot
 * product and only `0^2` terms under each square root. Numerator and both
 * denominators are unchanged, so the similarity is preserved EXACTLY - the
 * same floating-point value, not a close one.
 *
 * What the padding cannot survive is a MIXED index. A stored OpenAI vector and
 * a padded BGE vector are both 1536 wide, so the database will compare them
 * without complaint and return a number that means nothing: the two models put
 * their axes in different places. The width check below is what makes that
 * impossible to introduce silently - an OpenAI vector arriving here is 1536
 * wide and is rejected rather than passed through. Removing the OLD vectors is
 * a separate job, done by the re-embed backfill.
 */

/** What BGE-M3 returns. */
export const PROVIDER_EMBEDDING_DIMENSIONS = 1024;

/** What the column and the RPC have always held. */
export const EMBEDDING_STORAGE_DIMENSIONS = 1536;

/** How many zeros bridge the two. Named so the arithmetic is checkable. */
export const EMBEDDING_PAD_LENGTH =
  EMBEDDING_STORAGE_DIMENSIONS - PROVIDER_EMBEDDING_DIMENSIONS;

export class WrongEmbeddingDimensionError extends Error {
  readonly name = "WrongEmbeddingDimensionError";
  constructor(message: string) {
    super(message);
  }
}

/**
 * A provider vector, widened for storage and for querying.
 *
 * Both sides go through here - `EmbeddingProvider.embed` is the only source of
 * vectors, and it serves the ingestion write path and the retrieval query path
 * alike - so a query vector and a stored vector are padded identically by
 * construction rather than by two call sites agreeing to remember.
 */
export function padToStorageDimensions(vector: readonly number[]): number[] {
  if (vector.length !== PROVIDER_EMBEDDING_DIMENSIONS) {
    // Names both widths: a 1536 here is almost certainly a leftover OpenAI
    // vector, and a 768 is the wrong BGE variant. Either is a model swap, and
    // the log should say so without anyone having to guess.
    throw new WrongEmbeddingDimensionError(
      `Expected an embedding of ${PROVIDER_EMBEDDING_DIMENSIONS} dimensions, received ${vector.length}. ` +
        `Storage is ${EMBEDDING_STORAGE_DIMENSIONS}-wide and vectors from different models must never be mixed.`,
    );
  }

  for (let i = 0; i < vector.length; i += 1) {
    if (!Number.isFinite(vector[i])) {
      // pgvector rejects these too, but at INSERT time, from inside a
      // repository that has no idea which text produced them.
      throw new WrongEmbeddingDimensionError(
        `Embedding value at index ${i} is not finite. ` +
          `Expected ${PROVIDER_EMBEDDING_DIMENSIONS} finite numbers for a ${EMBEDDING_STORAGE_DIMENSIONS}-wide column.`,
      );
    }
  }

  // A fresh array: the caller's vector is theirs, and `new Array(n).fill(0)`
  // gives +0 rather than -0, which serializes as "0" but is a different value.
  return [...vector, ...new Array<number>(EMBEDDING_PAD_LENGTH).fill(0)];
}

/**
 * Does this stored vector come from the current model?
 *
 * There is no column recording which model produced a vector, and adding one
 * would be the migration this design exists to avoid. It does not need one:
 * a padded BGE vector ends in exactly 512 zeros by construction, and an
 * OpenAI text-embedding-3-small vector does not - its 1536 components are all
 * meaningful, and a run of 512 trailing zeros in one is not something that
 * happens by chance.
 *
 * So this is the discriminator the re-embed uses to find legacy vectors. It is
 * evidence rather than proof, which is why the backfill CLEARS what it
 * suspects rather than rewriting it in place: a cleared episode drops out of
 * `match_episodes` (which requires `embedding is not null`) and is re-embedded
 * from its own text, so a false positive costs one wasted embedding call and a
 * false negative is impossible in the direction that matters.
 */
export function hasStorageBgePadding(vector: readonly number[]): boolean {
  if (vector.length !== EMBEDDING_STORAGE_DIMENSIONS) return false;
  for (let i = PROVIDER_EMBEDDING_DIMENSIONS; i < EMBEDDING_STORAGE_DIMENSIONS; i += 1) {
    if (vector[i] !== 0) return false;
  }
  return true;
}
