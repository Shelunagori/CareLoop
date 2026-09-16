import { ingestionConfig } from "@/server/config";
import type { Clock } from "@/server/adapters/clock";
import type { EmbeddingProvider, ExtractionProvider } from "@/server/adapters/openai/types";
import type { EntitiesRepo, EntityRecord } from "@/server/repositories/entities";
import type { EpisodesRepo } from "@/server/repositories/episodes";
import type { FactsRepo } from "@/server/repositories/facts";
import type { JobRecord, JobsRepo } from "@/server/repositories/jobs";
import type { MessagesRepo } from "@/server/repositories/messages";
import type { ObservationsRepo } from "@/server/repositories/observations";
import type { RelationshipsRepo } from "@/server/repositories/relationships";
import { extractionPromptV1 } from "@/server/prompts/extraction.v1";
import {
  EXTRACTION_CONTRACT_VERSION,
  EXTRACTION_V1_JSON_SCHEMA,
  ExtractionV1Schema,
  type ExtractionV1,
} from "@/core/memory/extraction-contract";
import { episodeEmbeddingInput } from "@/core/memory/embedding-input";
import {
  EMPTY_EVIDENCE,
  evidenceCount,
  mergeEvidence,
  promoteStatus,
  type EvidenceState,
} from "@/core/memory/evidence";
import { normalizeFactKey, normalizeName, normalizeSummary } from "@/core/memory/normalize";
import { resolveEntityMention, type KnownEntity, type KnownRelationship } from "@/core/memory/resolve-entity";
import { isSelfReference, normalizeSelfEndpoint } from "@/core/memory/self-reference";
import { computeSalience } from "@/core/memory/salience";
import { resolveTemporal } from "@/core/memory/temporal";

/**
 * Post-turn ingestion (docs/01 §2.1 steps 6–8).
 *
 * The boundary this file exists to hold: the model's output is recorded as an
 * observation whose raw payload is never rewritten, and ONLY deterministic
 * code turns observations into beliefs. Nothing here lets extraction write to
 * entities, relationships, facts or episodes directly.
 *
 * The observation row itself is not frozen — `processed_at` and `resolution`
 * are updated once the deterministic commit has run, recording what the system
 * decided. What is immutable is the provenance: what the model actually said.
 */

export class ExtractionSchemaError extends Error {
  constructor(readonly issues: unknown) {
    super("Extraction output failed schema validation");
    this.name = "ExtractionSchemaError";
  }
}

export type IngestionDeps = {
  observations: ObservationsRepo;
  entities: EntitiesRepo;
  relationships: RelationshipsRepo;
  facts: FactsRepo;
  episodes: EpisodesRepo;
  jobs: JobsRepo;
  messages: MessagesRepo;
  extraction: ExtractionProvider;
  embeddings: EmbeddingProvider;
  clock: Clock;
};

export type IngestOutcome =
  | "committed"
  | "already_processed"
  | "source_missing"
  | "nothing_to_commit";

type MentionResolution =
  | { kind: "entity"; entityId: string; via: string }
  | { kind: "ambiguous"; candidateIds: string[]; via: string }
  | { kind: "created"; entityId: string }
  | { kind: "skipped"; reason: string };

export type IngestResolution = {
  version: string;
  mentions: Record<string, MentionResolution>;
  createdEntityIds: string[];
  relationshipIds: string[];
  factIds: string[];
  episodeIds: string[];
  ambiguousMentions: string[];
  skipped: string[];
};

/** Role phrases are not names; creating an entity called "my son" is noise. */
const ROLE_ONLY = /^(my|our|the)\s+\w+/i;

const ENTITY_SCAN_LIMIT = 400;
const RELATIONSHIP_SCAN_LIMIT = 400;
const NOVELTY_WINDOW = 25;

/**
 * Claims and processes up to `limit` runnable jobs. This single path serves
 * both the turn that just happened and any work a previous runtime left
 * behind — one mechanism, not two.
 */
export async function runIngestionSweep(
  deps: IngestionDeps,
  options?: { limit?: number; leaseSeconds?: number },
): Promise<Array<{ jobId: string; outcome: IngestOutcome | "failed" }>> {
  const limit = options?.limit ?? ingestionConfig.drainLimit;
  const lease = options?.leaseSeconds ?? ingestionConfig.leaseSeconds;
  const claimed = await deps.jobs.claim(limit, lease);
  const results: Array<{ jobId: string; outcome: IngestOutcome | "failed" }> = [];

  for (const job of claimed) {
    const startedAt = Date.now();
    try {
      const outcome = await processIngestJob(deps, job);
      await deps.jobs.complete(job.id);
      results.push({ jobId: job.id, outcome });
      logJob(job, outcome, startedAt);
    } catch (error) {
      const message = error instanceof Error ? `${error.name}: ${error.message}` : "unknown error";
      // Attempts were already incremented by the claim, so a job that keeps
      // failing backs off and eventually stops being picked up.
      const backoff = ingestionConfig.retryBackoffSeconds * Math.min(job.attempts, 5);
      await deps.jobs.fail(job.id, message, backoff);
      results.push({ jobId: job.id, outcome: "failed" });
      logJob(job, "failed", startedAt, message);
    }
  }

  return results;
}

function logJob(job: JobRecord, outcome: string, startedAt: number, error?: string): void {
  console.log(
    JSON.stringify({
      event: "ingest.job",
      jobId: job.id,
      key: job.key,
      attempt: job.attempts,
      outcome,
      durationMs: Date.now() - startedAt,
      // Diagnostics only. Never the message, never the extraction payload.
      error,
    }),
  );
}

export async function processIngestJob(
  deps: IngestionDeps,
  job: JobRecord,
): Promise<IngestOutcome> {
  const payload = job.payload;
  const sourceMessage = await deps.messages.findById(payload.userMessageId);
  // A deleted message is not an error to retry forever.
  if (!sourceMessage) return "source_missing";

  // 1. Observation — reused if this message has already been extracted, which
  //    makes replay free as well as safe.
  let observation = await deps.observations.findByMessage(
    payload.userId,
    payload.userMessageId,
    EXTRACTION_CONTRACT_VERSION,
  );

  if (observation?.processedAt) return "already_processed";

  let extracted: ExtractionV1;

  if (observation) {
    const reparsed = ExtractionV1Schema.safeParse(observation.payload);
    if (!reparsed.success) throw new ExtractionSchemaError(reparsed.error.issues);
    extracted = reparsed.data;
  } else {
    const response = await deps.extraction.extract({
      promptRef: extractionPromptV1.ref,
      system: extractionPromptV1.system,
      user: sourceMessage.content,
      schemaName: extractionPromptV1.schemaName,
      jsonSchema: EXTRACTION_V1_JSON_SCHEMA,
    });

    const parsed = ExtractionV1Schema.safeParse(response.raw);
    if (!parsed.success) {
      // Nothing is written: a malformed response leaves the job retryable and
      // memory untouched rather than half-corrupted.
      throw new ExtractionSchemaError(parsed.error.issues);
    }
    extracted = parsed.data;

    observation = await deps.observations.insert({
      userId: payload.userId,
      sourceMessageId: payload.userMessageId,
      kind: EXTRACTION_CONTRACT_VERSION,
      payload: parsed.data,
      confidence: null,
      sourceSpan: null,
      model: response.model,
      promptId: extractionPromptV1.ref,
    });
  }

  const resolution = await commitMemory(deps, {
    userId: payload.userId,
    conversationId: payload.conversationId,
    messageId: payload.userMessageId,
    messageAt: new Date(sourceMessage.createdAt),
    observationId: observation.id,
    extracted,
  });

  await deps.observations.markProcessed(observation.id, resolution);
  return resolution.createdEntityIds.length +
    resolution.relationshipIds.length +
    resolution.factIds.length +
    resolution.episodeIds.length >
    0
    ? "committed"
    : "nothing_to_commit";
}

async function commitMemory(
  deps: IngestionDeps,
  ctx: {
    userId: string;
    conversationId: string;
    messageId: string;
    messageAt: Date;
    observationId: string;
    extracted: ExtractionV1;
  },
): Promise<IngestResolution> {
  const resolution: IngestResolution = {
    version: EXTRACTION_CONTRACT_VERSION,
    mentions: {},
    createdEntityIds: [],
    relationshipIds: [],
    factIds: [],
    episodeIds: [],
    ambiguousMentions: [],
    skipped: [],
  };

  const entityRows = await deps.entities.listForUser(ctx.userId, ENTITY_SCAN_LIMIT);
  const relationshipRows = await deps.relationships.listForUser(
    ctx.userId,
    RELATIONSHIP_SCAN_LIMIT,
  );

  const known: KnownEntity[] = entityRows.map((row) => ({
    id: row.id,
    displayName: row.displayName,
    aliases: row.aliases,
    type: row.type,
    subtype: row.subtype,
  }));
  const knownRelationships: KnownRelationship[] = relationshipRows.map((row) => ({
    fromEntityId: row.fromEntityId,
    toEntityId: row.toEntityId,
    kind: row.kind,
  }));

  const byMention = new Map<string, string>();
  /** Mentions we refused to resolve. Nothing downstream may guess for them. */
  const unresolvable = new Set<string>();
  const entityById = new Map<string, EntityRecord>(entityRows.map((row) => [row.id, row]));

  // --- entities -------------------------------------------------------------
  const claims = ctx.extracted.entities.filter(
    (claim) => claim.confidence >= ingestionConfig.minClaimConfidence,
  );

  for (const claim of claims) {
    // The person writing is not an entity (see core/memory/self-reference).
    if (isSelfReference(claim.canonicalName) || isSelfReference(claim.mention)) {
      resolution.mentions[claim.mention] = { kind: "skipped", reason: "self_reference" };
      resolution.skipped.push(claim.mention);
      unresolvable.add(claim.mention);
      unresolvable.add(claim.canonicalName);
      continue;
    }

    const resolved = resolveEntityMention({
      mention: claim.canonicalName,
      type: claim.type,
      entities: known,
      relationships: knownRelationships,
    });

    if (resolved.outcome === "matched") {
      byMention.set(claim.mention, resolved.entityId);
      byMention.set(claim.canonicalName, resolved.entityId);
      resolution.mentions[claim.mention] = {
        kind: "entity",
        entityId: resolved.entityId,
        via: resolved.via,
      };
      const row = entityById.get(resolved.entityId);
      if (row) {
        const alias = claim.canonicalName.trim();
        const existing = [row.displayName, ...row.aliases].map(normalizeName);
        if (alias && !existing.includes(normalizeName(alias))) {
          await deps.entities.addAlias(row.id, alias, row.aliases);
          row.aliases = [...row.aliases, alias];
        }
        await deps.entities.touchMention(row.id, ctx.messageAt.toISOString());
      }
      continue;
    }

    if (resolved.outcome === "ambiguous") {
      // Two plausible Johns. Guessing attaches a memory to the wrong person,
      // so nothing is committed for this mention and the ambiguity is recorded.
      resolution.mentions[claim.mention] = {
        kind: "ambiguous",
        candidateIds: resolved.candidateIds,
        via: resolved.via,
      };
      resolution.ambiguousMentions.push(claim.mention);
      unresolvable.add(claim.mention);
      unresolvable.add(claim.canonicalName);
      continue;
    }

    if (ROLE_ONLY.test(claim.canonicalName.trim())) {
      // "my son" with no name is a role, not a person we can file.
      resolution.mentions[claim.mention] = { kind: "skipped", reason: "role_without_name" };
      resolution.skipped.push(claim.mention);
      unresolvable.add(claim.mention);
      unresolvable.add(claim.canonicalName);
      continue;
    }

    const created = await deps.entities.create({
      userId: ctx.userId,
      type: claim.type,
      subtype: claim.subtype,
      displayName: claim.canonicalName.trim(),
    });
    byMention.set(claim.mention, created.id);
    byMention.set(claim.canonicalName, created.id);
    entityById.set(created.id, created);
    known.push({
      id: created.id,
      displayName: created.displayName,
      aliases: created.aliases,
      type: created.type,
      subtype: created.subtype,
    });
    resolution.mentions[claim.mention] = { kind: "created", entityId: created.id };
    resolution.createdEntityIds.push(created.id);
    await deps.entities.touchMention(created.id, ctx.messageAt.toISOString());
  }

  /**
   * Resolves a mention for downstream claims. Returns null for the user,
   * an id when unambiguous, and undefined when it must not be guessed.
   *
   * The ambiguity recorded during entity resolution is honoured here too. An
   * earlier version fell through to a name scan and picked the FIRST match,
   * which quietly reintroduced exactly the wrong-person merge that the
   * resolver had just refused to make.
   */
  const lookup = (mention: string | null): string | null | undefined => {
    if (mention === null) return null; // the user themself
    if (unresolvable.has(mention)) return undefined;

    const direct = byMention.get(mention);
    if (direct) return direct;

    const needle = normalizeName(mention);
    const matches = known.filter(
      (entity) =>
        normalizeName(entity.displayName) === needle ||
        entity.aliases.some((alias) => normalizeName(alias) === needle),
    );
    // Zero matches, or more than one: not something to guess at.
    return matches.length === 1 ? matches[0].id : undefined;
  };

  const incoming: EvidenceState = {
    observationIds: [ctx.observationId],
    conversationIds: [ctx.conversationId],
    explicitlyConfirmed: false,
  };

  // --- relationships --------------------------------------------------------
  for (const claim of ctx.extracted.relationships) {
    if (claim.confidence < ingestionConfig.minClaimConfidence) continue;

    // An edge pointing AT the person writing has nowhere to land:
    // to_entity_id is NOT NULL and the user has no entity row. Skip it rather
    // than inventing one.
    if (isSelfReference(claim.toMention)) {
      resolution.skipped.push(`relationship:${claim.kind}:self_target`);
      continue;
    }

    const from = lookup(normalizeSelfEndpoint(claim.fromMention));
    const to = lookup(claim.toMention);
    if (from === undefined || to === undefined || to === null) {
      resolution.skipped.push(`relationship:${claim.kind}:${claim.toMention}`);
      continue;
    }

    const kind = normalizeFactKey(claim.kind);
    const existing = await deps.relationships.find({
      userId: ctx.userId,
      fromEntityId: from,
      toEntityId: to,
      kind,
    });

    const merged = mergeEvidence(
      existing
        ? {
            observationIds: existing.sourceObservationIds,
            conversationIds: existing.sourceConversationIds,
            explicitlyConfirmed: existing.status === "confirmed",
          }
        : EMPTY_EVIDENCE,
      { ...incoming, explicitlyConfirmed: claim.explicitlyConfirmed },
    );
    const status = promoteStatus(merged);

    const row = existing
      ? await deps.relationships.updateEvidence({
          id: existing.id,
          status,
          evidenceCount: evidenceCount(merged),
          sourceObservationIds: [...merged.observationIds],
          sourceConversationIds: [...merged.conversationIds],
          confirmedAt: status === "confirmed" ? ctx.messageAt.toISOString() : null,
        })
      : await deps.relationships.create({
          userId: ctx.userId,
          fromEntityId: from,
          toEntityId: to,
          kind,
          labelRaw: claim.kind,
          confidence: claim.confidence,
          status,
          evidenceCount: evidenceCount(merged),
          sourceObservationIds: [...merged.observationIds],
          sourceConversationIds: [...merged.conversationIds],
        });
    resolution.relationshipIds.push(row.id);
  }

  // --- facts ----------------------------------------------------------------
  for (const claim of ctx.extracted.facts) {
    if (claim.confidence < ingestionConfig.minClaimConfidence) continue;
    const subject = lookup(normalizeSelfEndpoint(claim.subjectMention));
    if (subject === undefined) {
      resolution.skipped.push(`fact:${claim.key}`);
      continue;
    }
    const key = normalizeFactKey(claim.key);
    if (!key) continue;

    const existing = await deps.facts.find({
      userId: ctx.userId,
      subjectEntityId: subject,
      key,
    });
    const merged = mergeEvidence(
      existing
        ? {
            observationIds: existing.sourceObservationIds,
            conversationIds: existing.sourceConversationIds,
            explicitlyConfirmed: existing.status === "confirmed",
          }
        : EMPTY_EVIDENCE,
      { ...incoming, explicitlyConfirmed: claim.explicitlyConfirmed },
    );
    const status = promoteStatus(merged);

    const row = existing
      ? await deps.facts.updateEvidence({
          id: existing.id,
          value: claim.value,
          status,
          evidenceCount: evidenceCount(merged),
          sourceObservationIds: [...merged.observationIds],
          sourceConversationIds: [...merged.conversationIds],
        })
      : await deps.facts.create({
          userId: ctx.userId,
          subjectEntityId: subject,
          key,
          value: claim.value,
          confidence: claim.confidence,
          status,
          evidenceCount: evidenceCount(merged),
          sourceObservationIds: [...merged.observationIds],
          sourceConversationIds: [...merged.conversationIds],
        });
    resolution.factIds.push(row.id);
  }

  // --- episodes -------------------------------------------------------------
  const alreadyForMessage = await deps.episodes.listBySourceMessage(ctx.userId, ctx.messageId);
  const existingSummaries = new Set(alreadyForMessage.map((e) => normalizeSummary(e.summary)));
  const recent = await deps.episodes.listRecent(ctx.userId, NOVELTY_WINDOW);
  const recentSummaries = new Set(recent.map((e) => normalizeSummary(e.summary)));

  const episodeClaims = [...ctx.extracted.episodes]
    .filter((claim) => claim.confidence >= ingestionConfig.minClaimConfidence)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, ingestionConfig.maxEpisodesPerTurn)
    .filter((claim) => !existingSummaries.has(normalizeSummary(claim.summary)));

  if (episodeClaims.length > 0) {
    const prepared = episodeClaims.map((claim) => {
      const participantIds = claim.participantMentions
        .map((mention) => lookup(mention))
        .filter((id): id is string => typeof id === "string");
      const participantNames = participantIds
        .map((id) => entityById.get(id)?.displayName)
        .filter((name): name is string => Boolean(name));
      const time = resolveTemporal({ claim: claim.temporal, referenceAt: ctx.messageAt });
      const salience = computeSalience({
        mentionsKnownRelationshipEntity: participantIds.some((id) =>
          relationshipRows.some((r) => r.toEntityId === id || r.fromEntityId === id),
        ),
        namedEntityCount: participantIds.length,
        hasExplicitTemporal: time.matched !== null,
        emotionWordCount: claim.emotionWords.length,
        isNovel: !recentSummaries.has(normalizeSummary(claim.summary)),
      });
      return {
        claim,
        participantIds,
        embeddingInput: episodeEmbeddingInput({ summary: claim.summary, participantNames }),
        time,
        salience,
      };
    });

    // The embedding call happens BEFORE any episode row is written and outside
    // any transaction (docs §22). A failure here therefore leaves no partial
    // episode behind and the job simply retries.
    const vectors = await deps.embeddings.embed(prepared.map((p) => p.embeddingInput));

    for (const [index, item] of prepared.entries()) {
      const episode = await deps.episodes.create({
        userId: ctx.userId,
        summary: item.claim.summary,
        occurredAt: item.time.occurredAt.toISOString(),
        precision: item.time.precision,
        salience: item.salience,
        embedding: vectors[index] ?? null,
        sourceMessageIds: [ctx.messageId],
      });
      await deps.episodes.addMembers(episode.id, item.participantIds);
      resolution.episodeIds.push(episode.id);
    }
  }

  return resolution;
}
