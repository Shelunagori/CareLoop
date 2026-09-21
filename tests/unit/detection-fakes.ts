import type { LlmMessage } from "@/server/adapters/openai/types";
import type { FamilyRenderProvider } from "@/server/adapters/openai/types";
import type { EntityRecord } from "@/server/repositories/entities";
import type { InteractionEventRecord } from "@/server/repositories/interaction-events";
import type { RelationshipRecord } from "@/server/repositories/relationships";
import type { StoredBaseline } from "@/server/repositories/baselines";
import type { OpportunityRecord } from "@/server/repositories/opportunities";
import type { SignalRecord } from "@/server/repositories/signals";
import type { ObservationRecord } from "@/server/repositories/observations";
import type { ProfileRecord } from "@/server/repositories/profiles";
import type { ReconnectDeps } from "@/server/services/reconnect";
import { buildFamilyRenderMessagesV2 } from "@/server/prompts/family-render.v2";
import { OPEN_OPPORTUNITY_STATUSES, type OpportunityStatus } from "@/core/consent/status";
import type { Clock } from "@/server/adapters/clock";

/**
 * In-memory stand-ins for the M4 repositories.
 *
 * The one that matters is `materialize`: it reproduces the database function's
 * semantics — a per-(user, entity) critical section, an idempotent reload by
 * signal, a signal-status precondition and an open-opportunity recheck INSIDE
 * that section. Modelling the transaction rather than stubbing it is what lets
 * the concurrency tests mean anything.
 */
export type StoredOpportunity = OpportunityRecord & { userId: string };

export type StoredSignal = SignalRecord & { userId: string };

export type ReconnectStore = {
  signals: StoredSignal[];
  opportunities: StoredOpportunity[];
  entities: EntityRecord[];
  relationships: RelationshipRecord[];
  baselines: Map<string, StoredBaseline>;
  interactionEvents: InteractionEventRecord[];
  /** Raw payloads, for absence-phrase provenance. */
  observations: ObservationRecord[];
  profile: ProfileRecord | null;
  earliestConversationAt: string | null;
  outstandingFamilyRequests: number;
  calls: string[];
};

export function createStore(overrides: Partial<ReconnectStore> = {}): ReconnectStore {
  return {
    signals: [],
    opportunities: [],
    entities: [],
    relationships: [],
    baselines: new Map(),
    interactionEvents: [],
    observations: [],
    profile: null,
    earliestConversationAt: null,
    outstandingFamilyRequests: 0,
    calls: [],
    ...overrides,
  };
}

const OPEN = new Set<string>(OPEN_OPPORTUNITY_STATUSES);

let seq = 0;
export function resetIds() {
  seq = 0;
}
const nextId = (prefix: string) => `${prefix}-${++seq}`;

export type FakeRenderOptions = {
  /** Text the provider returns. A function sees the call index. */
  text?: string | ((call: number) => string);
  failWith?: Error;
};

export type FakeFamilyRender = FamilyRenderProvider & {
  calls: Array<{ promptRef: string; messages: LlmMessage[]; serialized: string }>;
};

export function fakeFamilyRender(options: FakeRenderOptions = {}): FakeFamilyRender {
  const provider: FakeFamilyRender = {
    calls: [],
    async render(request) {
      // The COMPLETE runtime input, built by the production function. The
      // privacy snapshot asserts over these exact bytes.
      const messages = buildFamilyRenderMessagesV2(request.payload);
      provider.calls.push({
        promptRef: request.promptRef,
        messages,
        serialized: JSON.stringify(messages),
      });
      if (options.failWith) throw options.failWith;
      const text =
        typeof options.text === "function"
          ? options.text(provider.calls.length)
          : (options.text ?? "Dad was wondering — are you able to visit soon?");
      return { text, model: "fake-render-model" };
    },
  };
  return provider;
}

export type FakeHooks = {
  /** Runs at the start of materialize, BEFORE the critical section. */
  beforeMaterialize?: () => Promise<void>;
  /** Runs inside draftOpportunity's provider call. */
  beforeSaveDraft?: () => Promise<void>;
};

export function fakeReconnectDeps(input: {
  store: ReconnectStore;
  clock: Clock;
  familyRender?: FamilyRenderProvider;
  hooks?: FakeHooks;
}): ReconnectDeps {
  const { store, clock } = input;
  const locks = new Map<string, Promise<unknown>>();

  /** Serialises a body per key, the way the advisory lock does per entity. */
  async function withLock<T>(key: string, body: () => Promise<T>): Promise<T> {
    const previous = locks.get(key) ?? Promise.resolve();
    const run = previous.then(body, body);
    locks.set(
      key,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  return {
    clock,

    signals: {
      async insert(signal) {
        const row: StoredSignal = {
          id: nextId("sig"),
          userId: signal.userId,
          entityId: signal.entityId,
          baselineId: signal.baselineId,
          signalType: signal.signalType,
          status: "detected",
          explanation: signal.explanation,
          detectedAt: signal.detectedAt,
          suppressionReason: null,
          materializedAt: null,
        };
        store.signals.push(row);
        store.calls.push(`signals.insert:${signal.signalType}`);
        return row;
      },
      async listRecent(userId, sinceIso, limit) {
        return store.signals
          .filter((s) => s.userId === userId && s.detectedAt >= sinceIso)
          .sort((a, b) => b.detectedAt.localeCompare(a.detectedAt))
          .slice(0, limit);
      },
      async markSuppressed(id, reason) {
        const row = store.signals.find((s) => s.id === id);
        // Conditional, like the real UPDATE ... WHERE status = 'detected'.
        if (row && row.status === "detected") {
          row.status = "suppressed";
          row.suppressionReason = reason;
        }
        store.calls.push(`signals.markSuppressed:${reason}`);
      },
    },

    opportunities: {
      async materialize(args) {
        store.calls.push("opportunities.materialize");
        await input.hooks?.beforeMaterialize?.();
        // Identity BEFORE anything else — same order as the SQL, so a unit
        // test cannot pass against semantics the database does not have.
        const signal = store.signals.find(
          (row) => row.id === args.signalId && row.userId === args.userId,
        );
        if (!signal) return { outcome: "signal_not_found" as const, opportunityId: null };
        if (signal.entityId !== args.entityId) {
          return { outcome: "signal_entity_mismatch" as const, opportunityId: null };
        }
        if (!store.entities.some((entity) => entity.id === args.entityId)) {
          return { outcome: "entity_not_found" as const, opportunityId: null };
        }

        return withLock(`${args.userId}:${signal.entityId}`, async () => {
          const existing = store.opportunities.find(
            (o) =>
              o.signalId === args.signalId &&
              o.userId === args.userId &&
              o.entityId === signal.entityId,
          );
          if (existing) return { outcome: "reloaded" as const, opportunityId: existing.id };

          if (signal.status !== "detected") {
            return { outcome: "signal_not_detected" as const, opportunityId: null };
          }
          if (args.expiresAt <= args.now) {
            return { outcome: "invalid_expiry" as const, opportunityId: null };
          }
          if (
            store.opportunities.some(
              (o) =>
                o.userId === args.userId && o.entityId === signal.entityId && OPEN.has(o.status),
            )
          ) {
            return { outcome: "blocked_open_opportunity" as const, opportunityId: null };
          }

          const row: StoredOpportunity = {
            id: nextId("opp"),
            userId: args.userId,
            signalId: args.signalId,
            entityId: signal.entityId,
            proposal: args.proposal,
            sharePayload: null,
            renderedText: null,
            renderedTextHash: null,
            status: "proposed",
            offeredAt: null,
            resolvedAt: null,
            expiresAt: args.expiresAt,
            createdAt: args.now,
          };
          store.opportunities.push(row);
          signal.status = "materialized";
          signal.materializedAt = args.now;
          return { outcome: "materialized" as const, opportunityId: row.id };
        });
      },

      async findById(id) {
        return store.opportunities.find((o) => o.id === id) ?? null;
      },
      async findOwnedById(id, userId) {
        return store.opportunities.find((o) => o.id === id && o.userId === userId) ?? null;
      },
      async findBySignal(signalId) {
        return store.opportunities.find((o) => o.signalId === signalId) ?? null;
      },
      async listOpenForUser(userId, limit) {
        return store.opportunities
          .filter((o) => o.userId === userId && OPEN.has(o.status))
          .slice(0, limit);
      },
      async listRecentForUser(userId, sinceIso, limit) {
        return store.opportunities
          .filter((o) => o.userId === userId && o.createdAt >= sinceIso)
          .slice(0, limit);
      },
      async saveDraft(args) {
        await input.hooks?.beforeSaveDraft?.();
        const row = store.opportunities.find((o) => o.id === args.id);
        // The conditional update, exactly: status still `proposed` AND still
        // offerable. A loser writes nothing.
        if (!row || row.status !== "proposed" || row.expiresAt <= args.now) return null;
        row.sharePayload = args.sharePayload;
        row.renderedText = args.renderedText;
        row.renderedTextHash = args.renderedTextHash;
        row.status = "drafted";
        store.calls.push("opportunities.saveDraft");
        return row;
      },
      async markOffered({ id, now }) {
        const row = store.opportunities.find((o) => o.id === id);
        // Conditional, exactly like the real UPDATE ... WHERE.
        if (!row || row.status !== "drafted" || row.expiresAt <= now) return null;
        row.status = "offered";
        row.offeredAt = now;
        store.calls.push("opportunities.markOffered");
        return row;
      },
      async markApproved({ id, now }) {
        const row = store.opportunities.find((o) => o.id === id);
        if (!row || row.status !== "offered" || row.expiresAt <= now) return null;
        row.status = "approved";
        store.calls.push("opportunities.markApproved");
        return row;
      },
      async markDeclined({ id, now }) {
        const row = store.opportunities.find((o) => o.id === id);
        if (!row || row.status !== "offered") return null;
        row.status = "declined";
        row.resolvedAt = now;
        store.calls.push("opportunities.markDeclined");
        return row;
      },
      async listByStatusForUser(userId, statuses, limit) {
        return store.opportunities
          .filter((o) => o.userId === userId && statuses.includes(o.status))
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
          .slice(0, limit);
      },
      async markExpired(id, now) {
        const row = store.opportunities.find((o) => o.id === id);
        if (row && ["proposed", "drafted", "offered"].includes(row.status) && row.expiresAt <= now) {
          row.status = "expired" as OpportunityStatus;
          row.resolvedAt = now;
        }
        store.calls.push("opportunities.markExpired");
      },
    },

    baselines: {
      async save() {},
      async find({ entityId, eventType }) {
        return store.baselines.get(`${entityId}:${eventType}`) ?? null;
      },
      async listForUser() {
        return [...store.baselines.values()];
      },
    },

    interactionEvents: {
      /**
       * The real ordering, so a supersession test cannot pass against a
       * fake that simply returns the first row it finds.
       */
      async latestPositiveSince({ entityId, sinceOccurredIso }) {
        return (
          store.interactionEvents
            .filter(
              (e) =>
                e.entityId === entityId &&
                e.polarity === "positive" &&
                e.occurredAt >= sinceOccurredIso,
            )
            .sort((a, b) => b.reportedAt.localeCompare(a.reportedAt))[0] ?? null
        );
      },
      async listRecentPositive() {
        // Not a concern here: the proactive opening is tested on its own.
        return [];
      },
      async insertMany() {},
      async listForSeries({ entityId, eventType, sinceIso }) {
        return store.interactionEvents.filter(
          (e) => e.entityId === entityId && e.eventType === eventType && e.occurredAt >= sinceIso,
        );
      },
      async listRecentAbsences({ sinceReportedIso, limit }) {
        return store.interactionEvents
          .filter((e) => e.polarity === "absence" && e.reportedAt >= sinceReportedIso)
          .sort((a, b) => b.reportedAt.localeCompare(a.reportedAt))
          .slice(0, limit);
      },
      async earliestOccurredAt() {
        const sorted = store.interactionEvents.map((e) => e.occurredAt).sort();
        return sorted[0] ?? null;
      },
    },

    entities: {
      async listForUser() {
        return store.entities;
      },
      /** Mirrors the SQL filter: presentation never sees a `dev` row. */
      async listPresentableForUser(userId: string, limit: number) {
        const all = await this.listForUser(userId, limit);
        return all.filter((row) => row.origin !== "dev");
      },

      async listRecentlyMentioned() {
        return [];
      },
      async create() {
        throw new Error("not used");
      },
      async addAlias() {},
      async touchMention() {},
      async flagNeedsConfirmation() {},
    },

    relationships: {
      async listForUser() {
        return store.relationships;
      },
      async find() {
        return null;
      },
      async create() {
        throw new Error("not used");
      },
      async updateEvidence() {
        throw new Error("not used");
      },
    },

    observations: {
      async findById(_userId, id) {
        return store.observations.find((row) => row.id === id) ?? null;
      },
      async findByMessage() {
        return null;
      },
      async insert() {
        throw new Error("not used");
      },
      async markProcessed() {},
    },

    profiles: {
      async find() {
        return store.profile;
      },
    },

    familyRequests: {
      async countOutstandingForUser() {
        return store.outstandingFamilyRequests;
      },
    },

    conversations: {
      async create() {
        throw new Error("not used");
      },
      async findOwned() {
        return null;
      },
      async findLatest() {
        return null;
      },
      async earliestStartedAt() {
        return store.earliestConversationAt;
      },
    },

    familyRender: input.familyRender ?? fakeFamilyRender(),
  };
}
