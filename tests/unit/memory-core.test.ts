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
import {
  detectMentionedNames,
  renderEntityCard,
  type EntityCard,
} from "@/core/memory/present";
import { isSelfReference, normalizeSelfEndpoint } from "@/core/memory/self-reference";

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
    expect(card).toContain("John's recorded relationship to Simba: pet");
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


describe("self-reference guard", () => {
  it("recognises bare first-person pronouns, case and spacing insensitively", () => {
    for (const token of ["I", "i", "me", "Me", " myself ", "MYSELF"]) {
      expect(isSelfReference(token)).toBe(true);
    }
  });

  it("does NOT treat a possessive role phrase as the speaker", () => {
    // "my son" refers to John, not to the person writing. Folding it into the
    // user would attach the edge to the wrong end — worse than dropping it.
    for (const phrase of ["my son", "my daughter", "my friend", "my neighbour", "my dog"]) {
      expect(isSelfReference(phrase)).toBe(false);
    }
  });

  it("does not swallow real names that merely contain a pronoun", () => {
    for (const name of ["Mike", "Imogen", "Mel", "Ivy", "Mary"]) {
      expect(isSelfReference(name)).toBe(false);
    }
  });

  it("maps a self endpoint to null and leaves everything else alone", () => {
    expect(normalizeSelfEndpoint("me")).toBeNull();
    expect(normalizeSelfEndpoint(null)).toBeNull();
    expect(normalizeSelfEndpoint("John")).toBe("John");
    expect(normalizeSelfEndpoint("my son")).toBe("my son");
  });
});

describe("entity names are identifiers, not style", () => {
  /**
   * The regression this closes.
   *
   * Live acceptance produced "Have you heard from Johnny?" about a person
   * stored as John. Two things allowed it: the prompt said nothing about
   * names, and the card listed them without saying which one was the person's.
   * A name here is data - the product's whole claim is that it knows these
   * people - so a companion that renames someone is guessing out loud.
   *
   * These tests are about the CONTRACT handed to the model. The behavioural
   * assertion needs a real model and lives in tests/contract.
   */
  const card = (over: Partial<EntityCard> = {}): EntityCard => ({
    name: "John",
    type: "person",
    subtype: null,
    aliases: [],
    relationToUser: { kind: "son", status: "confirmed" },
    relatedEntities: [],
    ...over,
  });

  it("states the name to use, exactly as stored", () => {
    const rendered = renderEntityCard(card());
    expect(rendered).toContain("name to use: John");
    // The heading is the same string; nothing offers a second form.
    expect(rendered.split("\n")[0]).toBe("John");
  });

  it("an entity with no aliases offers the model no alternative at all", () => {
    const rendered = renderEntityCard(card({ aliases: [] }));
    expect(rendered).not.toContain("other names on record");
    for (const invented of ["Johnny", "Jon", "Jonathan", "Jonny"]) {
      expect(rendered, invented).not.toContain(invented);
    }
    // The only name anywhere in the card is the stored one.
    const names = rendered.match(/John\w*/g) ?? [];
    expect(new Set(names)).toEqual(new Set(["John"]));
  });

  it("recorded aliases are labelled as recorded, never as alternatives to pick", () => {
    const rendered = renderEntityCard(card({ aliases: ["Johnny"] }));
    expect(rendered).toContain("name to use: John");
    expect(rendered).toContain("other names on record: Johnny");
    // "also called" read as a menu. It is gone.
    expect(rendered).not.toContain("also called");
  });

  it("an alias never displaces the name to use on the card", () => {
    const rendered = renderEntityCard(card({ aliases: ["Johnny", "Jonno"] }));
    const lines = rendered.split("\n");
    // Canonical first, alternates last, each on its own labelled line.
    expect(lines[0]).toBe("John");
    expect(lines[1]).toBe("- name to use: John");
    expect(lines[lines.length - 1]).toBe("- other names on record: Johnny, Jonno");
  });

  it("holds for any name, including ones that invite shortening", () => {
    for (const [stored, tempting] of [
      ["Margaret", "Maggie"],
      ["Elizabeth", "Liz"],
      ["Simba", "Simmy"],
      ["Robert", "Bob"],
    ] as const) {
      const rendered = renderEntityCard(card({ name: stored }));
      expect(rendered, stored).toContain(`name to use: ${stored}`);
      expect(rendered, tempting).not.toContain(tempting);
    }
  });

  it("a pet's name is treated exactly like a person's", () => {
    const rendered = renderEntityCard(
      card({ name: "Simba", type: "pet", subtype: "dog", relationToUser: null }),
    );
    expect(rendered).toContain("name to use: Simba");
  });
});

/**
 * Relationships keep their direction (M8 regression 3).
 *
 * Live acceptance: "Do you remember Simba?" -> "Yes, I remember Simba, your
 * dog." The stored relationships said otherwise - the user's edge to Simba is
 * `family_pet`, and the only `pet` edge belongs to John. Nothing in the data
 * was wrong. The CARD was: it rendered the user's edge as "their family_pet",
 * a possessive, and a possessive of an animal is ownership in any reading.
 *
 * The fix is to stop glossing a stored label as a possessive at all. A label
 * is a record; turning `family_pet` into "your dog" is the presentation layer
 * making a claim the data does not contain.
 */
describe("relationships keep their direction", () => {
  const card = (input: {
    name: string;
    subtype?: string | null;
    toUser?: string | null;
    related?: Array<{ name: string; kind: string }>;
  }) =>
    renderEntityCard({
      name: input.name,
      type: "pet",
      subtype: input.subtype ?? "dog",
      aliases: [],
      relationToUser: input.toUser ? { kind: input.toUser, status: "confirmed" } : null,
      relatedEntities: (input.related ?? []).map((r) => ({ ...r, status: "confirmed" as const })),
    });

  it("A -> B family_pet does not read as A owning B", () => {
    // Neutral entities: nothing here is the demo fixture.
    const rendered = card({ name: "Pepper", toUser: "family_pet" });
    expect(rendered).not.toMatch(/their (family_)?pet\b/i);
    expect(rendered).not.toMatch(/their dog\b/i);
    // The label survives verbatim, attributed to them as a RELATIONSHIP.
    expect(rendered).toContain("family_pet");
    expect(rendered).toContain("their recorded relationship to Pepper: family_pet");
  });

  it("C -> B pet names C as the source of the relationship", () => {
    const rendered = card({ name: "Pepper", related: [{ name: "Rowan", kind: "pet" }] });
    expect(rendered).toContain("Rowan's recorded relationship to Pepper: pet");
  });

  it("both edges coexist without either absorbing the other", () => {
    const rendered = card({
      name: "Pepper",
      toUser: "family_pet",
      related: [{ name: "Rowan", kind: "pet" }],
    });
    expect(rendered).toContain("their recorded relationship to Pepper: family_pet");
    expect(rendered).toContain("Rowan's recorded relationship to Pepper: pet");
    expect(rendered).not.toMatch(/their (family_)?pet\b/i);
  });

  it("a relationship the user really does hold is still theirs", () => {
    // The rule is about possessives invented from a label, not about hiding
    // relationships: `son` is still rendered, and "your son" stays available.
    const rendered = renderEntityCard({
      name: "Rowan",
      type: "person",
      subtype: null,
      aliases: [],
      relationToUser: { kind: "son", status: "confirmed" },
      relatedEntities: [],
    });
    expect(rendered).toContain("their recorded relationship to Rowan: son");
  });

  it("an unconfirmed edge is still marked unconfirmed", () => {
    const rendered = renderEntityCard({
      name: "Pepper",
      type: "pet",
      subtype: "dog",
      aliases: [],
      relationToUser: { kind: "family_pet", status: "candidate" },
      relatedEntities: [{ name: "Rowan", kind: "pet", status: "candidate" }],
    });
    expect(rendered.match(/not yet confirmed/g) ?? []).toHaveLength(2);
  });
});
