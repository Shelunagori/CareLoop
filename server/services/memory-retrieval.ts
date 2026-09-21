import { memoryConfig } from "@/server/config";
import type { EmbeddingProvider } from "@/server/adapters/openai/types";
import type { EntitiesRepo, EntityRecord } from "@/server/repositories/entities";
import type { EpisodesRepo } from "@/server/repositories/episodes";
import type { FactsRepo } from "@/server/repositories/facts";
import type { RelationshipsRepo } from "@/server/repositories/relationships";
import { normalizeName } from "@/core/memory/normalize";
import {
  detectMentionedNames,
  renderEntityCard,
  renderEpisodeCard,
  renderProfileCard,
  type EntityCard,
} from "@/core/memory/present";
import type { MemorySections } from "./context";

/**
 * Bounded memory retrieval for one turn (docs/01 §2.1 step 3).
 *
 * Structured questions ("who is John?") are answered by relational lookups.
 * The vector index answers exactly one question — open-ended episodic recall —
 * because that is the only one with no key to look up (D5/R2).
 *
 * Every source here has a hard cap, so context size is flat at month twelve.
 */
export type MemoryRetrievalDeps = {
  entities: EntitiesRepo;
  relationships: RelationshipsRepo;
  facts: FactsRepo;
  episodes: EpisodesRepo;
  embeddings: EmbeddingProvider;
};

export async function loadMemoryForTurn(
  deps: MemoryRetrievalDeps,
  input: { userId: string; text: string; now: Date },
): Promise<MemorySections> {
  const [entityRows, relationshipRows, userFacts] = await Promise.all([
    // Cards and the "they just mentioned" spotlight are both shown to the
    // person through the model, so a development-seeded row must not reach
    // either (M12e.3).
    deps.entities.listPresentableForUser(input.userId, 200),
    deps.relationships.listForUser(input.userId, 400),
    deps.facts.listForSubject(input.userId, null, memoryConfig.profileFactLimit),
  ]);

  const { selected, mentionedIds } = selectEntities(entityRows, input);
  const byId = new Map(entityRows.map((row) => [row.id, row]));

  const entityCards = selected.map((row) =>
    renderEntityCard(buildCard(row, relationshipRows, byId)),
  );

  const profileCard = renderProfileCard(
    // The evidence status travels with the fact (M12f): a candidate is
    // usable context and must not be asserted back as established.
    userFacts.map((fact) => ({ key: fact.key, value: fact.value, status: fact.status })),
  );

  const episodes = await retrieveEpisodes(deps, input);

  return {
    profileCard,
    entityCards,
    // The signal `selectEntities` has always computed and always discarded.
    // Only names that ALSO have a card above, so the model is never pointed
    // at somebody it has not been told about.
    mentionedNow: selected
      .filter((row) => mentionedIds.has(row.id))
      .map((row) => row.displayName),
    episodes,
    // M4/M5 seams — still deliberately unfilled.
    pendingClosure: null,
    // Both family markers are decided in the turn, not by memory retrieval.
    awaitingFamilyReply: null,
    draftedOpportunityMarker: null,
    // Set by the turn, from the person's own words — not by retrieval.
    selfReportedWellbeing: false,
  };
}

/**
 * Entities mentioned in this turn first, then recently active ones, capped.
 * Mention detection is a normalized token lookup — not a similarity search.
 */
function selectEntities(
  rows: readonly EntityRecord[],
  input: { text: string; now: Date },
): { selected: EntityRecord[]; mentionedIds: ReadonlySet<string> } {
  const normalizedText = normalizeName(input.text);
  const nameToId = new Map<string, string>();
  for (const row of rows) {
    nameToId.set(normalizeName(row.displayName), row.id);
    for (const alias of row.aliases) nameToId.set(normalizeName(alias), row.id);
  }

  const mentioned = new Set(
    detectMentionedNames({
      normalizedText,
      normalizedNames: [...nameToId.keys()],
    }).map((name) => nameToId.get(name)!),
  );

  const cutoff = new Date(
    input.now.getTime() - memoryConfig.recentEntityDays * 86_400_000,
  ).toISOString();

  const recent = rows
    .filter((row) => !mentioned.has(row.id) && row.lastMentionedAt && row.lastMentionedAt >= cutoff)
    .sort((a, b) => (b.lastMentionedAt ?? "").localeCompare(a.lastMentionedAt ?? ""));

  const selected = [...rows.filter((row) => mentioned.has(row.id)), ...recent].slice(
    0,
    memoryConfig.entityCardLimit,
  );
  return { selected, mentionedIds: mentioned };
}

function buildCard(
  row: EntityRecord,
  relationships: ReadonlyArray<{
    fromEntityId: string | null;
    toEntityId: string;
    kind: string;
    status: "candidate" | "confirmed";
  }>,
  byId: Map<string, EntityRecord>,
): EntityCard {
  const toUser = relationships.find(
    (rel) => rel.fromEntityId === null && rel.toEntityId === row.id,
  );

  const related = relationships
    .filter((rel) => rel.fromEntityId !== null && rel.toEntityId === row.id)
    .map((rel) => ({
      name: byId.get(rel.fromEntityId!)?.displayName ?? "someone",
      kind: rel.kind,
      status: rel.status,
    }));

  return {
    name: row.displayName,
    type: row.type,
    subtype: row.subtype,
    aliases: row.aliases,
    relationToUser: toUser ? { kind: toUser.kind, status: toUser.status } : null,
    relatedEntities: related,
  };
}

async function retrieveEpisodes(
  deps: MemoryRetrievalDeps,
  input: { userId: string; text: string },
): Promise<string[]> {
  const query = input.text.trim();
  if (!query) return [];

  let vector: number[] | undefined;
  try {
    [vector] = await deps.embeddings.embed([query]);
  } catch {
    // Recall is an enhancement, not the turn. A failed embedding must not cost
    // the person their reply.
    return [];
  }
  if (!vector) return [];

  const matches = await deps.episodes.matchByEmbedding(
    input.userId,
    vector,
    memoryConfig.episodeTopK,
  );

  return matches
    .filter((match) => match.similarity >= memoryConfig.episodeMinSimilarity)
    .map((match) =>
      renderEpisodeCard({
        summary: match.summary,
        occurredAt: new Date(match.occurredAt),
        precision: match.precision,
      }),
    );
}
