import { beforeEach, describe, expect, it } from "vitest";
import { fixedClock } from "@/server/adapters/clock";
import { handleTurn, type TurnEvent } from "@/server/services/conversation";
import { buildConsentHooks } from "@/server/services/consent-hooks";
import { resolveSpeakable } from "@/server/services/speakable";
import { sha256Hex } from "@/core/share/text-hash";
import { drainEvents, fakeJobs, fakeLlm, fakeRepos, type CallLog } from "./fakes";
import { createStore, resetIds } from "./detection-fakes";
import { m5Deps, resetM5Ids, withM5, type M5Store } from "./consent-fakes";

/**
 * The reconnect card survives the turn that created it (M8 regression 1).
 *
 * The turn ends with a `state` event, and the browser treats it as the
 * server's closing word on the reconnect - including `null`, which retires the
 * card. That makes the event load-bearing: if the turn path cannot READ the
 * pending offer, every turn ends by telling the browser there is nothing on
 * the table, and the card the same turn just drew disappears half a second
 * later. The offer is still open, the draft is still stored, and the person
 * has nothing to press.
 */
const NOW = new Date("2026-09-16T12:00:00.000Z");
const HOUR = 3_600_000;
const USER = "user-1";
const JOHN = "entity-john";
const TEXT = "Hi John — are you visiting this weekend? Dad's hoping so.";

function store(status: "drafted" | "offered" = "drafted"): M5Store {
  const s = withM5(
    createStore({
      entities: [
        {
          id: JOHN,
          type: "person",
          subtype: null,
          displayName: "John",
          aliases: [],
          status: "active",
          origin: "user" as const,
          lastMentionedAt: null,
        },
      ],
    }),
  );
  s.opportunities.push({
    id: "opp-1",
    userId: USER,
    signalId: "sig-1",
    entityId: JOHN,
    proposal: { entityId: JOHN, entityName: "John" },
    sharePayload: { fromDisplayName: "Dad", topic: "visit", question: "ask_if_visiting" },
    renderedText: TEXT,
    renderedTextHash: sha256Hex(TEXT),
    status,
    offeredAt: status === "offered" ? NOW.toISOString() : null,
    resolvedAt: null,
    expiresAt: new Date(NOW.getTime() + 24 * HOUR).toISOString(),
    createdAt: NOW.toISOString(),
  });
  return s;
}

function harness(s: M5Store) {
  const log: CallLog = [];
  const repos = fakeRepos({ log, ownedConversationIds: ["conv-1"] });
  const services = m5Deps({ store: s, clock: fixedClock(NOW) });
  return {
    services,
    deps: {
      conversations: repos.conversations,
      messages: repos.messages,
      jobs: fakeJobs({ log }).repo,
      llm: fakeLlm({ log, chunks: ["I have a message ready for John."] }),
      memory: async () => (await import("@/server/services/context")).EMPTY_MEMORY,
      consent: buildConsentHooks({ consent: services.consent, closure: services.closure }),
      // The read model the terminal `state` event is derived from.
      opportunities: services.consent.opportunities,
      entities: services.consent.entities,
    },
  };
}

beforeEach(() => {
  resetIds();
  resetM5Ids();
});

describe("1. the turn that presents an offer does not then retire it", () => {
  it("ends with a state event carrying the offer it just drew", async () => {
    const s = store();
    const { deps } = harness(s);

    const turn = await handleTurn(deps, {
      userId: USER,
      conversationId: "conv-1",
      text: "I haven't seen John in a while.",
    });
    const events: TurnEvent[] = await drainEvents(turn.stream);

    const offer = events.find((e) => e.type === "offer");
    expect(offer, "the turn should present an offer").toBeTruthy();

    const last = events.at(-1);
    expect(last?.type).toBe("state");
    if (last?.type !== "state") throw new Error("expected a terminal state event");

    // The regression: this was null, so the browser retired the card the
    // instant the turn finished.
    expect(last.pendingOffer).not.toBeNull();
    expect(last.pendingOffer).toMatchObject({
      opportunityId: "opp-1",
      entityName: "John",
      state: "offered",
      renderedText: TEXT,
    });
    // The bytes on the card are the stored bytes, in both events.
    expect(last.pendingOffer!.renderedText).toBe(s.opportunities[0].renderedText);
  });

  it("the composition root supplies the read model the event needs", async () => {
    const saved = {
      url: process.env.NEXT_PUBLIC_SUPABASE_URL,
      key: process.env.SUPABASE_SERVICE_ROLE_KEY,
      openai: process.env.OPENAI_API_KEY,
    };
    process.env.NEXT_PUBLIC_SUPABASE_URL ??= "http://localhost:54321";
    process.env.SUPABASE_SERVICE_ROLE_KEY ??= "test-service-role-key";
    process.env.OPENAI_API_KEY ??= "test-openai-key";
    try {
      const { createConversationDeps } = await import("@/server/services/deps");
      const deps = createConversationDeps();
      // Present is not enough - a placeholder that answers "nothing open" is
      // indistinguishable from the bug. These must be the REAL repositories,
      // so the check is against the full repository surface.
      const { opportunitiesRepo } = await import("@/server/repositories/opportunities");
      const { entitiesRepo } = await import("@/server/repositories/entities");
      const { createServiceRoleClient } = await import("@/server/db/client");
      const db = createServiceRoleClient();

      for (const [name, wired, real] of [
        ["opportunities", deps.opportunities, opportunitiesRepo(db)],
        ["entities", deps.entities, entitiesRepo(db)],
      ] as const) {
        expect(wired, name).toBeTruthy();
        expect(Object.keys(wired as object).sort(), name).toEqual(
          Object.keys(real as object).sort(),
        );
      }
    } finally {
      for (const [name, value] of [
        ["NEXT_PUBLIC_SUPABASE_URL", saved.url],
        ["SUPABASE_SERVICE_ROLE_KEY", saved.key],
        ["OPENAI_API_KEY", saved.openai],
      ] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it("an already-offered reconnect is still reported by the terminal state", async () => {
    // The re-presenting case: the card must come back on the next turn too.
    const s = store("offered");
    const { deps } = harness(s);
    const turn = await handleTurn(deps, {
      userId: USER,
      conversationId: "conv-1",
      text: "How are you today?",
    });
    const events: TurnEvent[] = await drainEvents(turn.stream);
    const last = events.at(-1);
    if (last?.type !== "state") throw new Error("expected a terminal state event");
    expect(last.pendingOffer).toMatchObject({ opportunityId: "opp-1", state: "offered" });
  });
});

describe("2. reading the turn aloud changes nothing about the reconnect", () => {
  it("resolving speech leaves the opportunity exactly as it was", async () => {
    const s = store("offered");
    const { services } = harness(s);
    const before = JSON.stringify(s.opportunities[0]);

    const resolved = await resolveSpeakable(
      {
        ...services.closure,
        conversations: {
          async create() {
            throw new Error("not used");
          },
          async findOwned(id, userId) {
            return id === "conv-1" && userId === USER ? { id } : null;
          },
          async findLatest() {
            return { id: "conv-1" };
          },
          async earliestStartedAt() {
            return null;
          },
        },
        messages: {
          async insert() {
            throw new Error("not used");
          },
          async findById() {
            return null;
          },
          async listRecent() {
            return [];
          },
        },
      },
      { userId: USER, conversationId: "conv-1", source: { type: "offer", id: "opp-1" } },
    );

    expect(resolved.outcome).toBe("resolved");
    // Speech is a read. Nothing about the reconnect lifecycle moved.
    expect(JSON.stringify(s.opportunities[0])).toBe(before);
    expect(s.opportunities[0].status).toBe("offered");
  });
});
