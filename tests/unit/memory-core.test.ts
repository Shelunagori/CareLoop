import { describe, expect, it } from "vitest";
import { normalizeFactKey, normalizeName } from "@/core/memory/normalize";
import {
  EVIDENCE_CONFIRM_THRESHOLD,
  EMPTY_EVIDENCE,
  evidenceCount,
  mergeEvidence,
  promoteStatus,
} from "@/core/memory/evidence";
import { resolveEntityMention, type KnownEntity } from "@/core/memory/resolve-entity";
import { computeSalience } from "@/core/memory/salience";
import { resolveTemporal } from "@/core/memory/temporal";
import { episodeEmbeddingInput } from "@/core/memory/embedding-input";
import { detectMentionedNames, renderEntityCard } from "@/core/memory/present";

const john: KnownEntity = {
  id: "e-john",
  displayName: "John",
  aliases: ["Johnny"],
  type: "person",
  subtype: null,
};
const simba: KnownEntity = {
  id: "e-simba",
  displayName: "Simba",
  aliases: [],
  type: "pet",
  subtype: "dog",
};
const johnB: KnownEntity = { ...john, id: "e-john-2", aliases: [] };

describe("normalization", () => {
  it("folds case, accents and punctuation", () => {
    // Apostrophes are removed rather than split, so "John's" and "Johns" match.
    expect(normalizeName("  John's  ")).toBe("johns");
    expect(normalizeName("José")).toBe("jose");
    expect(normalizeName("JOHN")).toBe(normalizeName("john"));
  });

  it("keeps fact keys dotted and safe", () => {
    expect(normalizeFactKey("Preferred Drink")).toBe("preferred_drink");
    expect(normalizeFactKey("user.preferred_drink")).toBe("user.preferred_drink");
  });
});

describe("entity resolution", () => {
  it("matches on normalized exact display name", () => {
    const result = resolveEntityMention({
      mention: "john",
      entities: [john, simba],
      relationships: [],
    });
    expect(result).toEqual({ outcome: "matched", entityId: "e-john", via: "exact" });
  });

  it("matches on an alias", () => {
    const result = resolveEntityMention({
      mention: "Johnny",
      entities: [john, simba],
      relationships: [],
    });
    expect(result).toEqual({ outcome: "matched", entityId: "e-john", via: "alias" });
  });

  it("matches a role phrase through the relationship graph", () => {
    const result = resolveEntityMention({
      mention: "my son",
      entities: [john, simba],
      relationships: [{ fromEntityId: null, toEntityId: "e-john", kind: "son" }],
    });
    expect(result).toEqual({ outcome: "matched", entityId: "e-john", via: "role" });
  });

  it("refuses to guess between two people with the same name", () => {
    const result = resolveEntityMention({
      mention: "John",
      entities: [john, johnB],
      relationships: [],
    });
    expect(result).toEqual({
      outcome: "ambiguous",
      via: "exact",
      mention: "John",
      candidateIds: ["e-john", "e-john-2"],
    });
  });

  it("refuses to guess between two sons", () => {
    const result = resolveEntityMention({
      mention: "my son",
      entities: [john, johnB],
      relationships: [
        { fromEntityId: null, toEntityId: "e-john", kind: "son" },
        { fromEntityId: null, toEntityId: "e-john-2", kind: "son" },
      ],
    });
    expect(result.outcome).toBe("ambiguous");
  });

  it("reports an unknown name as unmatched rather than inventing a match", () => {
    const result = resolveEntityMention({
      mention: "Margaret",
      entities: [john, simba],
      relationships: [],
    });
    expect(result).toEqual({ outcome: "unmatched", mention: "Margaret" });
  });
});

describe("candidate to confirmed promotion", () => {
  it("stays a candidate after one conversation's evidence", () => {
    const state = mergeEvidence(EMPTY_EVIDENCE, {
      observationIds: ["o1"],
      conversationIds: ["c1"],
      explicitlyConfirmed: false,
    });
    expect(evidenceCount(state)).toBe(1);
    expect(promoteStatus(state)).toBe("candidate");
  });

  it("confirms on a second DISTINCT conversation", () => {
    let state = mergeEvidence(EMPTY_EVIDENCE, {
      observationIds: ["o1"],
      conversationIds: ["c1"],
      explicitlyConfirmed: false,
    });
    state = mergeEvidence(state, {
      observationIds: ["o2"],
      conversationIds: ["c2"],
      explicitlyConfirmed: false,
    });
    expect(evidenceCount(state)).toBe(EVIDENCE_CONFIRM_THRESHOLD);
    expect(promoteStatus(state)).toBe("confirmed");
  });

  it("does NOT confirm on two mentions in the same conversation", () => {
    let state = mergeEvidence(EMPTY_EVIDENCE, {
      observationIds: ["o1"],
      conversationIds: ["c1"],
      explicitlyConfirmed: false,
    });
    state = mergeEvidence(state, {
      observationIds: ["o2"],
      conversationIds: ["c1"],
      explicitlyConfirmed: false,
    });
    expect(promoteStatus(state)).toBe("candidate");
  });

  it("is idempotent — replaying the same observation changes nothing", () => {
    const once = mergeEvidence(EMPTY_EVIDENCE, {
      observationIds: ["o1"],
      conversationIds: ["c1"],
      explicitlyConfirmed: false,
    });
    const twice = mergeEvidence(once, {
      observationIds: ["o1"],
      conversationIds: ["c1"],
      explicitlyConfirmed: false,
    });
    expect(twice).toEqual(once);
    expect(promoteStatus(twice)).toBe("candidate");
  });

  it("confirms immediately on direct confirmation", () => {
    const state = mergeEvidence(EMPTY_EVIDENCE, {
      observationIds: ["o1"],
      conversationIds: ["c1"],
      explicitlyConfirmed: true,
    });
    expect(promoteStatus(state)).toBe("confirmed");
  });
});

describe("temporal resolution", () => {
  const referenceAt = new Date("2026-09-16T10:00:00.000Z"); // a Wednesday

  it("resolves 'yesterday' against the message time", () => {
    const result = resolveTemporal({
      claim: { expression: "yesterday", absoluteDate: null },
      referenceAt,
    });
    expect(result.occurredAt.toISOString()).toBe("2026-09-15T00:00:00.000Z");
    expect(result.precision).toBe("day");
    expect(result.matched).toBe("yesterday");
  });

  it("resolves 'last Sunday' to the most recent past Sunday", () => {
    const result = resolveTemporal({
      claim: { expression: "last Sunday", absoluteDate: null },
      referenceAt,
    });
    expect(result.occurredAt.toISOString()).toBe("2026-09-13T00:00:00.000Z");
    expect(result.precision).toBe("day");
  });

  it("marks a vague phrase as week precision", () => {
    const result = resolveTemporal({
      claim: { expression: "last week", absoluteDate: null },
      referenceAt,
    });
    expect(result.precision).toBe("week");
  });

  it("falls back to the message time with unknown precision", () => {
    const result = resolveTemporal({
      claim: { expression: "at some point", absoluteDate: null },
      referenceAt,
    });
    expect(result.occurredAt).toEqual(referenceAt);
    expect(result.precision).toBe("unknown");
    expect(result.matched).toBeNull();
  });

  it("rejects a future date the model tried to hand us", () => {
    const result = resolveTemporal({
      claim: { expression: null, absoluteDate: "2030-01-01" },
      referenceAt,
    });
    expect(result.matched).toBeNull();
    expect(result.precision).toBe("unknown");
  });

  it("accepts a past calendar date the person actually stated", () => {
    const result = resolveTemporal({
      claim: { expression: null, absoluteDate: "2026-06-03" },
      referenceAt,
    });
    expect(result.occurredAt.toISOString()).toBe("2026-06-03T00:00:00.000Z");
    expect(result.matched).toBe("absolute_date");
  });
});

describe("salience", () => {
  const baseline = {
    mentionsKnownRelationshipEntity: false,
    namedEntityCount: 0,
    hasExplicitTemporal: false,
    emotionWordCount: 0,
    isNovel: false,
  };

  it("scores a bare musing low and a named, dated, felt event high", () => {
    const low = computeSalience(baseline);
    const high = computeSalience({
      mentionsKnownRelationshipEntity: true,
      namedEntityCount: 2,
      hasExplicitTemporal: true,
      emotionWordCount: 2,
      isNovel: true,
    });
    expect(low).toBeLessThan(high);
    expect(low).toBeGreaterThanOrEqual(0);
    expect(high).toBeLessThanOrEqual(1);
  });

  it("is monotonic in each feature and stays within 0..1", () => {
    expect(computeSalience({ ...baseline, hasExplicitTemporal: true })).toBeGreaterThan(
      computeSalience(baseline),
    );
    expect(computeSalience({ ...baseline, namedEntityCount: 50 })).toBeLessThanOrEqual(1);
  });

  it("is deterministic for identical features", () => {
    expect(computeSalience(baseline)).toBe(computeSalience(baseline));
  });
});

describe("presentation", () => {
  it("renders an entity card from curated data, not raw rows", () => {
    const card = renderEntityCard({
      name: "Simba",
      type: "pet",
      subtype: "dog",
      aliases: [],
      relationToUser: { kind: "family_pet", status: "candidate" },
      relatedEntities: [{ name: "John", kind: "pet", status: "confirmed" }],
    });
    expect(card).toContain("Simba");
    expect(card).toContain("pet (dog)");
    expect(card).toContain("pet of John");
    expect(card).toContain("not yet confirmed");
  });

  it("detects mentions by normalized token lookup", () => {
    expect(
      detectMentionedNames({
        normalizedText: "has john been round with simba lately",
        normalizedNames: ["john", "simba", "margaret"],
      }),
    ).toEqual(["john", "simba"]);
  });

  it("builds a stable embedding input regardless of participant order", () => {
    const a = episodeEmbeddingInput({ summary: "John visited", participantNames: ["John", "Simba"] });
    const b = episodeEmbeddingInput({ summary: "John visited", participantNames: ["Simba", "John"] });
    expect(a).toBe(b);
  });
});
