import { describe, expect, it } from "vitest";
import {
  EMBEDDING_STORAGE_DIMENSIONS,
  PROVIDER_EMBEDDING_DIMENSIONS,
  WrongEmbeddingDimensionError,
  hasStorageBgePadding,
  padToStorageDimensions,
} from "@/core/memory/embedding-dimensions";

/**
 * BGE-M3 RETURNS 1024 NUMBERS. THE COLUMN HOLDS 1536.
 *
 * `episodes.embedding` is `vector(1536)`, as is `match_episodes(p_query)`, and
 * changing either means a migration and an index rebuild. Appending 512 zeros
 * avoids both, and it is not a fudge: for any two vectors a and b, appending
 * the SAME zeros to each leaves the dot product untouched (the new terms are
 * all 0 x 0) and leaves both magnitudes untouched (sqrt of the same sum). So
 * cosine similarity is preserved exactly, not approximately.
 *
 * What the padding cannot survive is MIXING. A stored OpenAI vector and a
 * padded BGE vector are both 1536 numbers and the database will happily
 * compare them, returning a similarity that means nothing. Everything below
 * exists to make that impossible to do by accident.
 */
const cosine = (a: readonly number[], b: readonly number[]): number => {
  const dot = a.reduce((sum, value, i) => sum + value * b[i], 0);
  const norm = (v: readonly number[]) => Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return dot / (norm(a) * norm(b));
};

const vector = (seed: number): number[] =>
  Array.from({ length: PROVIDER_EMBEDDING_DIMENSIONS }, (_, i) => Math.sin(seed * (i + 1)));

describe("embedding dimensions", () => {
  it("a provider vector becomes exactly the stored width", () => {
    const padded = padToStorageDimensions(vector(1));
    expect(padded).toHaveLength(EMBEDDING_STORAGE_DIMENSIONS);
    expect(EMBEDDING_STORAGE_DIMENSIONS).toBe(1536);
    expect(PROVIDER_EMBEDDING_DIMENSIONS).toBe(1024);
  });

  it("exactly 512 zeros are appended, and the original values are untouched", () => {
    const original = vector(2);
    const padded = padToStorageDimensions(original);

    expect(padded.slice(0, PROVIDER_EMBEDDING_DIMENSIONS)).toEqual(original);
    const tail = padded.slice(PROVIDER_EMBEDDING_DIMENSIONS);
    expect(tail).toHaveLength(512);
    expect(tail.every((value) => value === 0)).toBe(true);
    // Not -0, which serializes as "0" but is a different number.
    expect(tail.every((value) => Object.is(value, 0))).toBe(true);
  });

  it("cosine similarity is preserved EXACTLY, not approximately", () => {
    const a = vector(3);
    const b = vector(4);

    const before = cosine(a, b);
    const after = cosine(padToStorageDimensions(a), padToStorageDimensions(b));

    // Same arithmetic, same order: the added terms contribute 0 to the dot
    // product and 0 to each magnitude, so this is bit-for-bit equality.
    expect(after).toBe(before);
    // And the test is not vacuously comparing two identical vectors.
    expect(before).toBeLessThan(0.999);
  });

  it("a wrong-width vector FAILS rather than being padded to fit", () => {
    // The dangerous case: an OpenAI 1536 vector arriving where a BGE 1024 one
    // is expected. Silently accepting it would store a mixed-model vector
    // that the database compares happily and meaninglessly.
    for (const width of [0, 1, 768, 1023, 1025, 1536]) {
      expect(() => padToStorageDimensions(new Array(width).fill(0.1)), `${width}`).toThrow(
        WrongEmbeddingDimensionError,
      );
    }
  });

  it("the failure says both widths, so a model swap is obvious from the log", () => {
    try {
      padToStorageDimensions(new Array(1536).fill(0.1));
      expect.unreachable("expected a dimension error");
    } catch (error) {
      expect((error as Error).message).toContain("1536");
      expect((error as Error).message).toContain("1024");
      expect((error as Error).name).toBe("WrongEmbeddingDimensionError");
    }
  });

  it("a vector carrying a non-finite value fails rather than poisoning the index", () => {
    // pgvector rejects NaN/Infinity, but it does so at INSERT time, deep in a
    // repository, with no idea which text produced it. Failing here names the
    // embedding.
    for (const bad of [NaN, Infinity, -Infinity]) {
      const broken = vector(5);
      broken[17] = bad;
      expect(() => padToStorageDimensions(broken), String(bad)).toThrow(
        WrongEmbeddingDimensionError,
      );
    }
  });

  it("padding is a pure function — the caller's array is not mutated", () => {
    const original = vector(6);
    const copy = [...original];
    padToStorageDimensions(original);
    expect(original).toEqual(copy);
  });

  it("a padded vector is recognisable, and a foreign one is not", () => {
    // How the backfill tells a current vector from a leftover, with no column
    // recording which model wrote it.
    expect(hasStorageBgePadding(padToStorageDimensions(vector(7)))).toBe(true);

    // An OpenAI-shaped vector: 1536 wide, all components meaningful.
    const legacy = Array.from({ length: EMBEDDING_STORAGE_DIMENSIONS }, (_, i) =>
      Math.cos(i + 1),
    );
    expect(hasStorageBgePadding(legacy)).toBe(false);

    // A single non-zero anywhere in the tail is enough to disqualify it.
    const tampered = padToStorageDimensions(vector(8));
    tampered[EMBEDDING_STORAGE_DIMENSIONS - 1] = 1e-9;
    expect(hasStorageBgePadding(tampered)).toBe(false);

    // Wrong width is not a current vector either.
    expect(hasStorageBgePadding(new Array(1024).fill(0))).toBe(false);
  });

  it("an all-zero vector is treated as current, and that is harmless", () => {
    // Worth naming rather than leaving as a surprise: a degenerate all-zero
    // vector passes the padding check. It cannot be an OpenAI embedding (they
    // are never all zero), and pgvector gives it no similarity to anything, so
    // the worst case is an episode that stays unrecallable until it is
    // re-ingested.
    expect(hasStorageBgePadding(new Array(EMBEDDING_STORAGE_DIMENSIONS).fill(0))).toBe(true);
  });
});
