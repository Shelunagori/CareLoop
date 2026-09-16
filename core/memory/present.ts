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

export type FactCard = { key: string; value: string };

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

export function renderEntityCard(card: EntityCard): string {
  const lines = [`${card.name}`];
  lines.push(`- ${card.type}${card.subtype ? ` (${card.subtype})` : ""}`);
  if (card.relationToUser) {
    lines.push(`- their ${card.relationToUser.kind}${renderStatus(card.relationToUser.status)}`);
  }
  for (const related of card.relatedEntities) {
    lines.push(`- ${related.kind} of ${related.name}${renderStatus(related.status)}`);
  }
  if (card.aliases.length > 0) {
    lines.push(`- also called ${[...card.aliases].sort().join(", ")}`);
  }
  return lines.join("\n");
}

export function renderProfileCard(facts: readonly FactCard[]): string | null {
  if (facts.length === 0) return null;
  const lines = [...facts]
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((fact) => `- ${fact.key}: ${fact.value}`);
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
