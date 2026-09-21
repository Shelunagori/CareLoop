import type { EmbeddingProvider, ExtractionProvider } from "@/server/adapters/openai/types";
import type { EntitiesRepo, EntityRecord } from "@/server/repositories/entities";
import type { EpisodeRecord, EpisodesRepo } from "@/server/repositories/episodes";
import type { FactRecord, FactsRepo } from "@/server/repositories/facts";
import type { IngestJobPayload, JobRecord, JobsRepo } from "@/server/repositories/jobs";
import type { MessagesRepo, StoredMessage } from "@/server/repositories/messages";
import type { ObservationRecord, ObservationsRepo } from "@/server/repositories/observations";
import type { RelationshipRecord, RelationshipsRepo } from "@/server/repositories/relationships";
import type {
  InteractionEventInput,
  InteractionEventsRepo,
} from "@/server/repositories/interaction-events";
import type { BaselinesRepo } from "@/server/repositories/baselines";
import type { BaselineDerivation } from "@/core/baseline/compute";
import type { ExtractionV1 } from "@/core/memory/extraction-contract";
import { fixedClock } from "@/server/adapters/clock";
import type { IngestionDeps } from "@/server/services/ingestion";

/**
 * In-memory stand-ins for the M2 repositories. They keep the same contracts as
 * the Postgres versions, including the idempotency rules the real schema
 * enforces (unique job key, composite episode-membership PK), so ingestion can
 * be exercised — and replayed — with no database and no network.
 */
export type MemoryStore = {
  /** The real repo persists `resolution`; the fake must too, or tests
   *  cannot assert what the deterministic layer decided. */
  observations: Array<ObservationRecord & { resolution?: unknown }>;
  entities: EntityRecord[];
  relationships: RelationshipRecord[];
  facts: FactRecord[];
  episodes: Array<EpisodeRecord & { sourceMessageIds: string[]; embedding: number[] | null }>;
  episodeMembers: Array<{ episodeId: string; entityId: string }>;
  jobs: Array<{ id: string; key: string; payload: IngestJobPayload; attempts: number; completedAt: string | null; lastError: string | null }>;
  messages: StoredMessage[];
  /** M3: the event spine. Fingerprint uniqueness mirrors the real index. */
  interactionEvents: InteractionEventInput[];
  /** M3: one baseline per "<entityId>:<eventType>", like the unique index. */
  baselines: Map<
    string,
    BaselineDerivation & { entityId: string; eventType: string; computedAt: string }
  >;
  calls: string[];
};

export function createStore(messages: StoredMessage[] = []): MemoryStore {
  return {
    observations: [],
    entities: [],
    relationships: [],
    facts: [],
    episodes: [],
    episodeMembers: [],
    jobs: [],
    messages: [...messages],
    interactionEvents: [],
    baselines: new Map(),
    calls: [],
  };
}

let counter = 0;
const id = (prefix: string) => `${prefix}-${++counter}`;
export function resetIds() {
  counter = 0;
}

export function fakeExtraction(
  result: ExtractionV1 | (() => ExtractionV1),
  options: { store: MemoryStore; failWith?: Error; rawOverride?: unknown },
): ExtractionProvider & { calls: number } {
  const provider = {
    calls: 0,
    async extract() {
      provider.calls += 1;
      options.store.calls.push("extraction.extract");
      if (options.failWith) throw options.failWith;
      if (options.rawOverride !== undefined) {
        return { raw: options.rawOverride, model: "fake-extraction-model" };
      }
      return {
        raw: typeof result === "function" ? result() : result,
        model: "fake-extraction-model",
      };
    },
  };
  return provider;
}

export function fakeEmbeddings(options: {
  store: MemoryStore;
  failWith?: Error;
  dimension?: number;
}): EmbeddingProvider & { calls: number } {
  const provider = {
    calls: 0,
    async embed(texts: readonly string[]) {
      provider.calls += 1;
      options.store.calls.push(`embeddings.embed:${texts.length}`);
      if (options.failWith) throw options.failWith;
      // Deterministic pseudo-vector: same input text always yields the same
      // vector, which is what makes replay assertions meaningful.
      return texts.map((text) => {
        const seed = [...text].reduce((acc, ch) => (acc * 31 + ch.charCodeAt(0)) % 9973, 7);
        return Array.from({ length: options.dimension ?? 8 }, (_, i) =>
          Number((((seed + i * 17) % 100) / 100).toFixed(4)),
        );
      });
    },
  };
  return provider;
}

export function fakeMemoryRepos(store: MemoryStore) {
  const observations: ObservationsRepo = {
    async findById(_userId, id) {
      return store.observations.find((o) => o.id === id) ?? null;
    },
    async findByMessage(userId, sourceMessageId, kind) {
      return (
        store.observations.find(
          (o) => o.sourceMessageId === sourceMessageId && o.kind === kind,
        ) ?? null
      );
    },
    async insert(input) {
      store.calls.push("observations.insert");
      const record: ObservationRecord = {
        id: id("obs"),
        sourceMessageId: input.sourceMessageId,
        kind: input.kind,
        payload: input.payload,
        confidence: input.confidence,
        processedAt: null,
      };
      store.observations.push(record);
      return record;
    },
    async markProcessed(observationId, resolution) {
      store.calls.push("observations.markProcessed");
      const row = store.observations.find((o) => o.id === observationId);
      if (row) {
        row.processedAt = new Date().toISOString();
        row.resolution = resolution;
      }
    },
  };

  const entities: EntitiesRepo = {
    async listForUser() {
      return [...store.entities];
    },
    async listRecentlyMentioned(_userId, sinceIso, limit) {
      return store.entities
        .filter((e) => e.lastMentionedAt && e.lastMentionedAt >= sinceIso)
        .slice(0, limit);
    },
    async create(input) {
      store.calls.push(`entities.create:${input.displayName}`);
      const record: EntityRecord = {
        id: id("ent"),
        type: input.type,
        subtype: input.subtype,
        displayName: input.displayName,
        aliases: [],
        status: "active",
        lastMentionedAt: null,
      };
      store.entities.push(record);
      return record;
    },
    async addAlias(entityId, alias) {
      const row = store.entities.find((e) => e.id === entityId);
      if (row && !row.aliases.includes(alias)) row.aliases.push(alias);
    },
    async touchMention(entityId, at) {
      const row = store.entities.find((e) => e.id === entityId);
      if (row) row.lastMentionedAt = at;
    },
    async flagNeedsConfirmation(entityId) {
      const row = store.entities.find((e) => e.id === entityId);
      if (row) row.status = "needs_confirmation";
    },
  };

  const relationships: RelationshipsRepo = {
    async listForUser() {
      return [...store.relationships];
    },
    async find({ fromEntityId, toEntityId, kind }) {
      return (
        store.relationships.find(
          (r) => r.fromEntityId === fromEntityId && r.toEntityId === toEntityId && r.kind === kind,
        ) ?? null
      );
    },
    async create(input) {
      store.calls.push(`relationships.create:${input.kind}`);
      const record: RelationshipRecord = {
        id: id("rel"),
        fromEntityId: input.fromEntityId,
        toEntityId: input.toEntityId,
        kind: input.kind,
        status: input.status,
        evidenceCount: input.evidenceCount,
        sourceObservationIds: input.sourceObservationIds,
        sourceConversationIds: input.sourceConversationIds,
      };
      store.relationships.push(record);
      return record;
    },
    async updateEvidence(input) {
      const row = store.relationships.find((r) => r.id === input.id)!;
      row.status = input.status;
      row.evidenceCount = input.evidenceCount;
      row.sourceObservationIds = input.sourceObservationIds;
      row.sourceConversationIds = input.sourceConversationIds;
      return row;
    },
  };

  const facts: FactsRepo = {
    async listForSubject(_userId, subjectEntityId, limit) {
      return store.facts.filter((f) => f.subjectEntityId === subjectEntityId).slice(0, limit);
    },
    async find({ subjectEntityId, key }) {
      return (
        store.facts.find((f) => f.subjectEntityId === subjectEntityId && f.key === key) ?? null
      );
    },
    async create(input) {
      store.calls.push(`facts.create:${input.key}`);
      const record: FactRecord = {
        id: id("fact"),
        subjectEntityId: input.subjectEntityId,
        key: input.key,
        value: input.value,
        status: input.status,
        evidenceCount: input.evidenceCount,
        sourceObservationIds: input.sourceObservationIds,
        sourceConversationIds: input.sourceConversationIds,
      };
      store.facts.push(record);
      return record;
    },
    async updateEvidence(input) {
      const row = store.facts.find((f) => f.id === input.id)!;
      row.value = input.value;
      row.status = input.status;
      row.evidenceCount = input.evidenceCount;
      row.sourceObservationIds = input.sourceObservationIds;
      row.sourceConversationIds = input.sourceConversationIds;
      return row;
    },
  };

  const episodes: EpisodesRepo = {
    async listBySourceMessage(_userId, messageId) {
      return store.episodes.filter((e) => e.sourceMessageIds.includes(messageId));
    },
    async listRecent(_userId, limit) {
      return [...store.episodes].slice(-limit);
    },
    async create(input) {
      store.calls.push("episodes.create");
      const record = {
        id: id("epi"),
        summary: input.summary,
        occurredAt: input.occurredAt,
        precision: input.precision,
        salience: input.salience,
        sourceMessageIds: input.sourceMessageIds,
        embedding: input.embedding,
      };
      store.episodes.push(record);
      return record;
    },
    async setEmbedding(episodeId, embedding) {
      const row = store.episodes.find((e) => e.id === episodeId);
      if (row) row.embedding = embedding;
    },
    async addMembers(episodeId, entityIds) {
      for (const entityId of entityIds) {
        // Composite PK: inserting the same pair twice is a no-op.
        if (!store.episodeMembers.some((m) => m.episodeId === episodeId && m.entityId === entityId)) {
          store.episodeMembers.push({ episodeId, entityId });
        }
      }
    },
    async matchByEmbedding(_userId, _embedding, limit) {
      return store.episodes.slice(0, limit).map((e) => ({ ...e, similarity: 0.9 }));
    },
  };

  const jobs: JobsRepo = {
    async createIngestJob(key, payload) {
      // UNIQUE(kind, key) in the real schema.
      if (store.jobs.some((j) => j.key === key)) return;
      store.jobs.push({ id: id("job"), key, payload, attempts: 0, completedAt: null, lastError: null });
    },
    async claim(limit) {
      const claimed: JobRecord[] = [];
      const seenConversations = new Set<string>();
      for (const job of store.jobs) {
        if (claimed.length >= limit) break;
        if (job.completedAt) continue;
        if (seenConversations.has(job.payload.conversationId)) continue;
        job.attempts += 1;
        seenConversations.add(job.payload.conversationId);
        claimed.push({ id: job.id, key: job.key, payload: job.payload, attempts: job.attempts });
      }
      return claimed;
    },
    async complete(jobId) {
      const job = store.jobs.find((j) => j.id === jobId);
      if (job) job.completedAt = new Date().toISOString();
    },
    async fail(jobId, message) {
      const job = store.jobs.find((j) => j.id === jobId);
      if (job) job.lastError = message;
    },
  };

  const messages: MessagesRepo = {
    async insert() {
      throw new Error("not used by ingestion tests");
    },
    async listRecent() {
      return [...store.messages];
    },
    async findById(messageId) {
      return store.messages.find((m) => m.id === messageId) ?? null;
    },
  };

  const interactionEvents: InteractionEventsRepo = {
    async listRecentPositive() {
      // Not a concern here: the proactive opening is tested on its own.
      return [];
    },
    async insertMany(events) {
      for (const event of events) {
        store.calls.push(`interactionEvents.insert:${event.eventType}:${event.polarity}`);
        // UNIQUE(user_id, ingest_fingerprint) in the real schema: a replayed
        // observation writes nothing new.
        const duplicate = store.interactionEvents.some(
          (existing) =>
            existing.userId === event.userId &&
            existing.ingestFingerprint === event.ingestFingerprint,
        );
        if (!duplicate) store.interactionEvents.push(event);
      }
    },
    async listForSeries({ userId, entityId, eventType, sinceIso }) {
      return store.interactionEvents
        .filter(
          (event) =>
            event.userId === userId &&
            event.entityId === entityId &&
            event.eventType === eventType &&
            event.occurredAt >= sinceIso,
        )
        .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt))
        .map((event) => ({
          // Stable across queries, like a real row id — the detection layer
          // uses the last event's id as part of a signal's identity.
          id: `ie-${event.ingestFingerprint}`,
          entityId: event.entityId,
          eventType: event.eventType,
          occurredAt: event.occurredAt,
          occurredAtPrecision: event.occurredAtPrecision,
          reportedAt: event.reportedAt,
          certainty: event.certainty,
          polarity: event.polarity,
          windowStart: event.windowStart,
          windowEnd: event.windowEnd,
          sourceObservationId: event.sourceObservationId ?? null,
          ingestFingerprint: event.ingestFingerprint,
        }));
    },
    async listRecentAbsences({ userId, sinceReportedIso, limit }) {
      return store.interactionEvents
        .filter(
          (event) =>
            event.userId === userId &&
            event.polarity === "absence" &&
            event.reportedAt >= sinceReportedIso,
        )
        .sort((a, b) => b.reportedAt.localeCompare(a.reportedAt))
        .slice(0, limit)
        .map((event) => ({
          id: `ie-${event.ingestFingerprint}`,
          entityId: event.entityId,
          eventType: event.eventType,
          occurredAt: event.occurredAt,
          occurredAtPrecision: event.occurredAtPrecision,
          reportedAt: event.reportedAt,
          certainty: event.certainty,
          polarity: event.polarity,
          windowStart: event.windowStart,
          windowEnd: event.windowEnd,
          sourceObservationId: event.sourceObservationId ?? null,
          ingestFingerprint: event.ingestFingerprint,
        }));
    },
    async earliestOccurredAt(userId) {
      const ordered = store.interactionEvents
        .filter((event) => event.userId === userId)
        .map((event) => event.occurredAt)
        .sort();
      return ordered[0] ?? null;
    },
  };

  const baselines: BaselinesRepo = {
    async save({ entityId, eventType, baseline, computedAt }) {
      store.calls.push(`baselines.save:${entityId}:${eventType}`);
      // Ingestion always saves a freshly derived baseline, so the fake can
      // keep the derivation detail the golden tests assert on.
      store.baselines.set(`${entityId}:${eventType}`, {
        ...(baseline as BaselineDerivation),
        entityId,
        eventType,
        computedAt,
      });
    },
    async find({ entityId, eventType }) {
      const hit = store.baselines.get(`${entityId}:${eventType}`);
      if (!hit) return null;
      return {
        id: `bl-${entityId}-${eventType}`,
        entityId,
        eventType: hit.eventType as "visit" | "call",
        status: hit.status,
        medianGapDays: hit.medianGapDays,
        madDays: hit.madDays,
        observationCount: hit.observationCount,
        windowStart: hit.windowStart ? hit.windowStart.toISOString() : null,
        windowEnd: hit.windowEnd ? hit.windowEnd.toISOString() : null,
        reasons: hit.reasons,
        methodVersion: hit.methodVersion,
        inputsHash: hit.inputsHash,
        computedAt: hit.computedAt,
      };
    },
    async listForUser() {
      return [];
    },
  };

  return {
    observations,
    entities,
    relationships,
    facts,
    episodes,
    jobs,
    messages,
    interactionEvents,
    baselines,
  };
}

export function ingestionDeps(
  store: MemoryStore,
  providers: { extraction: ExtractionProvider; embeddings: EmbeddingProvider },
  at = "2026-09-16T10:00:00.000Z",
): IngestionDeps {
  return {
    ...fakeMemoryRepos(store),
    extraction: providers.extraction,
    embeddings: providers.embeddings,
    clock: fixedClock(at),
  };
}
