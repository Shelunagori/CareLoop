import type { EntityType } from "./resolve-entity";
import type { EvidenceStatus } from "./evidence";

/**
 * Deterministic presentation objects (docs/01 §2.1 step 3).
 *
 * The model receives curated memory, never raw database rows. Rendering here —
 * as pure functions over plain data — means what the companion is told is
 * reviewable in a test, and a schema change cannot silently reshape the prompt.
 */
export type EntityCard = {
  name: string;
  type: EntityType;
  subtype: string | null;
  aliases: readonly string[];
  /** How this entity relates to the user, e.g. "son", "family_pet". */
  relationToUser: { kind: string; status: EvidenceStatus } | null;
  /** Edges to other entities, e.g. Simba is John's pet. */
  relatedEntities: ReadonlyArray<{ name: string; kind: string; status: EvidenceStatus }>;
};

export type EpisodeCard = {
  summary: string;
  occurredAt: Date;
  precision: "exact" | "day" | "week" | "unknown";
};

export type FactCard = {
  key: string;
  value: string;
  /** M12f: rendered, so the prompt's "not yet confirmed" rule applies here too. */
  status: EvidenceStatus;
};

function renderStatus(status: EvidenceStatus): string {
  return status === "confirmed" ? "" : " (not yet confirmed)";
}

function formatDate(card: EpisodeCard): string {
  const iso = card.occurredAt.toISOString().slice(0, 10);
  switch (card.precision) {
    case "week":
      return `around ${iso}`;
    case "unknown":
      return "date unclear";
    default:
      return iso;
  }
}

/**
 * One entity, as the companion is allowed to know it.
 *
 * The first line is deliberate: `name to use` rather than a bare heading.
 * Live acceptance produced "Have you heard from Johnny?" about an entity
 * stored as John, and the card was part of why - it listed names without
 * saying which one was the person's and which were merely on record, so the
 * model read the list as a choice. A name is an identifier here, not a
 * stylistic option: the person's son is called what he is called, and a
 * companion that renames him is not remembering, it is guessing.
 *
 * Alternates are labelled as recorded, not offered. The prompt carries the
 * matching rule; between them there is no reading of this card in which
 * inventing a diminutive is permitted.
 */
export function renderEntityCard(card: EntityCard): string {
  const lines = [`${card.name}`];
  lines.push(`- name to use: ${card.name}`);
  lines.push(`- ${card.type}${card.subtype ? ` (${card.subtype})` : ""}`);
  // Relationships are rendered as DIRECTED records, never as possessives.
  //
  // Live acceptance produced "Simba, your dog" for an animal whose only `pet`
  // edge belongs to the user's son; the user's own edge is `family_pet`. The
  // data was right and the card was wrong - it said "their family_pet", and a
  // possessive of an animal is ownership however the label reads. Naming the
  // source of each edge, and quoting the label rather than glossing it, leaves
  // nothing for a model to collapse: `family_pet` is a relationship to the
  // household, `pet` is one person's, and the card no longer decides which.
  if (card.relationToUser) {
    lines.push(
      `- their recorded relationship to ${card.name}: ${card.relationToUser.kind}` +
        renderStatus(card.relationToUser.status),
    );
  }
  for (const related of card.relatedEntities) {
    lines.push(
      `- ${related.name}'s recorded relationship to ${card.name}: ${related.kind}` +
        renderStatus(related.status),
    );
  }
  if (card.aliases.length > 0) {
    // "on record" and not "also called": confirmed alternates that are in the
    // notes, not permission to pick one. How each was learned is not recorded,
    // so nothing downstream may claim the person uses it themselves.
    lines.push(`- other names on record: ${[...card.aliases].sort().join(", ")}`);
  }
  return lines.join("\n");
}

export function renderProfileCard(facts: readonly FactCard[]): string | null {
  if (facts.length === 0) return null;
  /**
   * A CANDIDATE SAYS SO (M12f).
   *
   * Entity cards have always marked an unconfirmed relationship "not yet
   * confirmed", and the conversation prompt has a rule about exactly that
   * phrase — never state it as fact, never build on it, ask if it
   * matters. Profile facts were rendered without the marker, so a
   * single-mention claim about the person reached the model looking
   * identical to one they had confirmed, and the rule had nothing to
   * attach to.
   *
   * One mention in one conversation is a candidate; a second distinct
   * conversation, or the person saying so outright, confirms it
   * (`core/memory/evidence.ts`). Nothing about that policy changes here —
   * this only makes the answer visible where it is used.
   */
  const lines = [...facts]
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((fact) =>
      `- ${fact.key}: ${fact.value}${renderStatus(fact.status)}`,
    );
  return ["What you know about them:", ...lines].join("\n");
}

export function renderEpisodeCard(card: EpisodeCard): string {
  return `- ${card.summary} (${formatDate(card)})`;
}

/**
 * Mentions are detected by normalized token match against known names and
 * aliases — a lookup, not a similarity search. Callers pass names already
 * normalized by `normalizeName`.
 */
export function detectMentionedNames(input: {
  normalizedText: string;
  normalizedNames: readonly string[];
}): string[] {
  const tokens = new Set(input.normalizedText.split(/\s+/).filter(Boolean));
  return input.normalizedNames.filter((name) => {
    const parts = name.split(" ").filter(Boolean);
    if (parts.length === 0) return false;
    if (parts.length === 1) return tokens.has(parts[0]);
    return input.normalizedText.includes(name);
  });
}
