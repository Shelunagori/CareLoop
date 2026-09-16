import { normalizeName } from "./normalize";

/**
 * Deterministic entity resolution (docs/02 §5.1).
 *
 * Order: normalized exact → alias → relationship role → ambiguity.
 *
 * No embeddings. "Is this mention John?" has an exact answer that a string
 * comparison gets right and a cosine score only approximates — more slowly,
 * and unexplainably at exactly the moment you need to explain it. And nothing
 * here ever merges two existing entities: a wrong merge silently fuses two
 * people's histories and is far harder to undo than a question is to ask.
 */
export type EntityType = "person" | "pet" | "place" | "org";

export type KnownEntity = {
  id: string;
  displayName: string;
  aliases: readonly string[];
  type: EntityType;
  subtype: string | null;
};

export type KnownRelationship = {
  /** null means the edge starts at the user themself. */
  fromEntityId: string | null;
  toEntityId: string;
  kind: string;
};

export type Resolution =
  | { outcome: "matched"; entityId: string; via: "exact" | "alias" | "role" }
  | {
      outcome: "ambiguous";
      via: "exact" | "alias" | "role";
      mention: string;
      candidateIds: string[];
    }
  | { outcome: "unmatched"; mention: string };

/** Role phrases the person uses for a relationship edge, e.g. "my son". */
const ROLE_PATTERN = /^(?:my|our|the)\s+(.+)$/;

export function resolveEntityMention(input: {
  mention: string;
  /** Narrows candidates when the extractor is confident about the kind of thing. */
  type?: EntityType | null;
  entities: readonly KnownEntity[];
  relationships: readonly KnownRelationship[];
}): Resolution {
  const mention = input.mention.trim();
  const needle = normalizeName(mention);
  if (!needle) return { outcome: "unmatched", mention };

  const pool = input.type
    ? input.entities.filter((entity) => entity.type === input.type)
    : input.entities;
  // A typed miss should still see untyped candidates rather than duplicating
  // an entity whose type the extractor guessed differently.
  const candidates = pool.length > 0 ? pool : input.entities;

  // 1. Normalized exact display name.
  const exact = candidates.filter((entity) => normalizeName(entity.displayName) === needle);
  if (exact.length === 1) return { outcome: "matched", entityId: exact[0].id, via: "exact" };
  if (exact.length > 1) {
    return {
      outcome: "ambiguous",
      via: "exact",
      mention,
      candidateIds: exact.map((entity) => entity.id).sort(),
    };
  }

  // 2. Alias.
  const byAlias = candidates.filter((entity) =>
    entity.aliases.some((alias) => normalizeName(alias) === needle),
  );
  if (byAlias.length === 1) return { outcome: "matched", entityId: byAlias[0].id, via: "alias" };
  if (byAlias.length > 1) {
    return {
      outcome: "ambiguous",
      via: "alias",
      mention,
      candidateIds: byAlias.map((entity) => entity.id).sort(),
    };
  }

  // 3. Relationship role: "my son" resolves when exactly one son edge exists.
  const role = needle.match(ROLE_PATTERN)?.[1] ?? needle;
  const roleKey = normalizeName(role);
  const byRole = input.relationships.filter(
    (relationship) =>
      relationship.fromEntityId === null && normalizeName(relationship.kind) === roleKey,
  );
  const roleTargets = [...new Set(byRole.map((relationship) => relationship.toEntityId))];
  if (roleTargets.length === 1) {
    return { outcome: "matched", entityId: roleTargets[0], via: "role" };
  }
  if (roleTargets.length > 1) {
    // Two sons. Guessing here would attach a memory to the wrong child.
    return { outcome: "ambiguous", via: "role", mention, candidateIds: roleTargets.sort() };
  }

  return { outcome: "unmatched", mention };
}
