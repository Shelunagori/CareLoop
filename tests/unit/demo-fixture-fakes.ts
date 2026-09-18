import { fixedClock } from "@/server/adapters/clock";

/** The instant the fixture suites freeze time at. */
export const FIXTURE_NOW = new Date("2026-09-16T12:00:00.000Z");
import type { DemoFixtureDeps } from "@/server/services/demo-fixture";
import type { DemoFixtureRepo } from "@/server/repositories/demo-fixture";
import type { ConversationsRepo } from "@/server/repositories/conversations";
import type { MessagesRepo } from "@/server/repositories/messages";
import type { EntityRecord } from "@/server/repositories/entities";
import { fakeMemoryRepos, type MemoryStore } from "./memory-fakes";

/**
 * The demo fixture's repository fakes, shared by the M6 suite and the M10
 * isolation suite.
 *
 * Extracted rather than duplicated. A second hand-written fake is a second
 * opinion about how the repositories behave, and the moment the two disagree
 * the wrong one is whichever suite is not currently failing. These are the
 * fakes the M6 tests already trust, so the isolation proof is measured against
 * the same behaviour.
 */
export type StoredProfile = { displayName: string | null; familyDisplayName: string | null };

/**
 * The decision graph the memory fakes do not model: signals, opportunities and
 * the consent/family loop hanging off them.
 *
 * It exists so the counting fake can WALK FOREIGN KEYS the way the repository
 * does, rather than being handed an answer. A fake that simply returned the
 * fixture's numbers would have passed happily against the bug this closes.
 */
type DecisionStore = {
  signals: Array<{ id: string; userId: string; entityId: string; status: string }>;
  opportunities: Array<{ id: string; userId: string; entityId: string; status: string }>;
  grants: Array<{ id: string; opportunityId: string }>;
  requests: Array<{ id: string; opportunityId: string }>;
  responses: Array<{ id: string; requestId: string }>;
  closures: Array<{ id: string; opportunityId: string }>;
};

export const emptyDecisions = (): DecisionStore => ({
  signals: [],
  opportunities: [],
  grants: [],
  requests: [],
  responses: [],
  closures: [],
});

/** Stable instance: cleared in place, never reassigned, so importers may alias it. */
export const fixtureDecisions: DecisionStore = emptyDecisions();
const decisions = fixtureDecisions;

/**
 * Conversations and their messages.
 *
 * The memory fakes model messages without a conversation, which is fine for
 * ingestion and useless here: the whole question is WHICH conversation a
 * message belongs to. `started_at` ordering is modelled by insertion order,
 * as the real `findLatest` does with its descending sort.
 */
type ChatStore = {
  conversations: Array<{ id: string; userId: string }>;
  messages: Array<{ id: string; conversationId: string; role: "user" | "assistant"; content: string }>;
};

export const fixtureChat: ChatStore = { conversations: [], messages: [] };
const chat = fixtureChat;
let chatSeq = 0;

export function fakeConversations(): ConversationsRepo {
  return {
    async create(userId) {
      const row = { id: `conv-${++chatSeq}`, userId };
      chat.conversations.push(row);
      return { id: row.id };
    },
    async findOwned(conversationId, userId) {
      const row = chat.conversations.find((c) => c.id === conversationId && c.userId === userId);
      return row ? { id: row.id } : null;
    },
    async findLatest(userId) {
      const owned = chat.conversations.filter((c) => c.userId === userId);
      const row = owned[owned.length - 1];
      return row ? { id: row.id } : null;
    },
    async earliestStartedAt() {
      return null;
    },
  };
}

export function fakeMessages(): MessagesRepo {
  return {
    async insert({ conversationId, role, content }) {
      const row = {
        id: `msg-${++chatSeq}`,
        conversationId,
        role: role as "user" | "assistant",
        content,
      };
      chat.messages.push(row);
      return { id: row.id, role, content, createdAt: FIXTURE_NOW.toISOString() };
    },
    async listRecent(conversationId, limit) {
      return chat.messages
        .filter((m) => m.conversationId === conversationId)
        .slice(-limit)
        .map((m) => ({ id: m.id, role: m.role, content: m.content, createdAt: FIXTURE_NOW.toISOString() }));
    },
    async findById(id) {
      const row = chat.messages.find((m) => m.id === id);
      return row
        ? { id: row.id, role: row.role, content: row.content, createdAt: FIXTURE_NOW.toISOString() }
        : null;
    },
  };
}

/** The one repository the ordinary fakes do not cover: identity and deletion. */
export function fakeDemoRepo(store: MemoryStore, profiles: Map<string, StoredProfile>): DemoFixtureRepo {
  return {
    async readProfile(userId) {
      const row = profiles.get(userId);
      return row
        ? { existed: true, displayName: row.displayName, familyDisplayName: row.familyDisplayName }
        : { existed: false, displayName: null, familyDisplayName: null };
    },
    async writeProfile({ userId, displayName, familyDisplayName }) {
      profiles.set(userId, { displayName, familyDisplayName });
    },
    async deleteProfile(userId) {
      profiles.delete(userId);
    },
    async createEntityWithId(input) {
      store.entities.push({
        id: input.id,
        type: input.type as EntityRecord["type"],
        subtype: input.subtype,
        displayName: input.displayName,
        aliases: [...input.aliases],
        status: "active",
        lastMentionedAt: null,
      });
    },
    async createEpisodeWithId(input) {
      store.episodes.push({
        id: input.id,
        summary: input.summary,
        occurredAt: input.occurredAt,
        precision: input.precision as "day",
        salience: input.salience,
        embedding: null,
        sourceMessageIds: [],
      });
    },
    async addEpisodeMembers(episodeId, entityIds) {
      for (const entityId of entityIds) {
        if (!store.episodeMembers.some((m) => m.episodeId === episodeId && m.entityId === entityId)) {
          store.episodeMembers.push({ episodeId, entityId });
        }
      }
    },
    async findEntityIds({ ids }) {
      return store.entities.filter((e) => ids.includes(e.id)).map((e) => e.id);
    },
    async findEpisodeIds({ ids }) {
      return store.episodes.filter((e) => ids.includes(e.id)).map((e) => e.id);
    },
    async deleteEpisodesByIds({ ids }) {
      const before = store.episodes.length;
      store.episodes = store.episodes.filter((e) => !ids.includes(e.id));
      store.episodeMembers = store.episodeMembers.filter((m) => !ids.includes(m.episodeId));
      return before - store.episodes.length;
    },
    async deleteEntities({ entityIds }) {
      const doomed = new Set(entityIds);
      const before = store.entities.length;
      store.entities = store.entities.filter((e) => !doomed.has(e.id));
      // The cascades the frozen schema declares, modelled rather than stubbed.
      store.interactionEvents = store.interactionEvents.filter((e) => !doomed.has(e.entityId));
      store.relationships = store.relationships.filter(
        (r) => !doomed.has(r.toEntityId) && !(r.fromEntityId && doomed.has(r.fromEntityId)),
      );
      store.episodeMembers = store.episodeMembers.filter((m) => !doomed.has(m.entityId));
      // Facts ABOUT a deleted entity go with it - which is how the manifest,
      // anchored to a fixture entity, cleans itself up.
      store.facts = store.facts.filter(
        (f) => f.subjectEntityId === null || !doomed.has(f.subjectEntityId),
      );
      for (const key of [...store.baselines.keys()]) {
        if (doomed.has(key.split(":")[0])) store.baselines.delete(key);
      }
      // signals -> opportunities -> grants / requests -> responses / closures,
      // exactly as the frozen schema cascades.
      decisions.signals = decisions.signals.filter((sig) => !doomed.has(sig.entityId));
      const goneOpportunities = new Set(
        decisions.opportunities.filter((o) => doomed.has(o.entityId)).map((o) => o.id),
      );
      decisions.opportunities = decisions.opportunities.filter((o) => !doomed.has(o.entityId));
      const goneRequests = new Set(
        decisions.requests.filter((r) => goneOpportunities.has(r.opportunityId)).map((r) => r.id),
      );
      decisions.grants = decisions.grants.filter((g) => !goneOpportunities.has(g.opportunityId));
      decisions.requests = decisions.requests.filter(
        (r) => !goneOpportunities.has(r.opportunityId),
      );
      decisions.responses = decisions.responses.filter((r) => !goneRequests.has(r.requestId));
      decisions.closures = decisions.closures.filter(
        (c) => !goneOpportunities.has(c.opportunityId),
      );
      return before - store.entities.length;
    },
    async deleteUserFacts({ keys }) {
      const before = store.facts.length;
      store.facts = store.facts.filter(
        (f) => !(f.subjectEntityId === null && keys.includes(f.key)),
      );
      return before - store.facts.length;
    },
    async latestEventAt({ entityId, eventType }) {
      const rows = store.interactionEvents
        .filter(
          (e) => e.entityId === entityId && e.eventType === eventType && e.polarity === "positive",
        )
        .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
      return rows[0]?.occurredAt ?? null;
    },

    async countsForFixture({ userId, entityIds }) {
      const ids = new Set(entityIds);
      if (ids.size === 0) {
        return {
          interactionEvents: 0,
          baselines: 0,
          signalsOpen: 0,
          opportunitiesOpen: 0,
          consentGrants: 0,
          familyRequests: 0,
          familyResponses: 0,
          closures: 0,
        };
      }

      // The same traversal the repository performs: entity ids -> opportunity
      // ids -> request ids. Nothing is counted by user_id.
      const opportunities = decisions.opportunities.filter(
        (o) => o.userId === userId && ids.has(o.entityId),
      );
      const opportunityIds = new Set(opportunities.map((o) => o.id));
      const requests = decisions.requests.filter((r) => opportunityIds.has(r.opportunityId));
      const requestIds = new Set(requests.map((r) => r.id));

      return {
        interactionEvents: store.interactionEvents.filter((e) => ids.has(e.entityId)).length,
        baselines: [...store.baselines.keys()].filter((key) => ids.has(key.split(":")[0])).length,
        signalsOpen: decisions.signals.filter(
          (sig) => sig.userId === userId && ids.has(sig.entityId) && sig.status === "detected",
        ).length,
        opportunitiesOpen: opportunities.filter((o) =>
          ["proposed", "drafted", "offered", "approved"].includes(o.status),
        ).length,
        consentGrants: decisions.grants.filter((g) => opportunityIds.has(g.opportunityId)).length,
        familyRequests: requests.length,
        familyResponses: decisions.responses.filter((r) => requestIds.has(r.requestId)).length,
        closures: decisions.closures.filter((c) => opportunityIds.has(c.opportunityId)).length,
      };
    },
  };
}


export function fixtureDeps(input: {
  store: MemoryStore;
  profiles: Map<string, StoredProfile>;
  now: Date;
}): DemoFixtureDeps {
  const { store, profiles, now } = input;
  const repos = fakeMemoryRepos(store);
  return {
    clock: fixedClock(now),
    entities: repos.entities,
    relationships: repos.relationships,
    episodes: repos.episodes,
    facts: repos.facts,
    interactionEvents: repos.interactionEvents,
    baselines: repos.baselines,
    conversations: fakeConversations(),
    messages: fakeMessages(),
    demo: fakeDemoRepo(store, profiles),
  };
}


/** The profile rows the fixture borrows and restores. */
export const fixtureProfiles = new Map<string, StoredProfile>();

/** Call from `beforeEach`. Clears in place so every alias stays valid. */
export function resetFixtureFakes(): void {
  for (const key of Object.keys(fixtureDecisions) as Array<keyof DecisionStore>) {
    fixtureDecisions[key].length = 0;
  }
  fixtureChat.conversations.length = 0;
  fixtureChat.messages.length = 0;
  fixtureProfiles.clear();
  chatSeq = 0;
}
