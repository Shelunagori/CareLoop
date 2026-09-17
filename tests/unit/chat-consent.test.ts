import { beforeEach, describe, expect, it } from "vitest";
import { fixedClock } from "@/server/adapters/clock";
import { handleTurn } from "@/server/services/conversation";
import { buildConsentHooks } from "@/server/services/consent-hooks";
import { OFFER_CLOSING_QUESTION } from "@/core/share/offer";
import { sha256Hex } from "@/core/share/text-hash";
import { drain, fakeJobs, fakeLlm, fakeRepos, type CallLog } from "./fakes";
import { createStore, resetIds } from "./detection-fakes";
import { m5Deps, resetM5Ids, withM5, type M5Store } from "./consent-fakes";

/**
 * The turn.
 *
 * Two properties are asserted here that nowhere else can be: the model is
 * never given the draft, and a clear yes or no is handled without calling the
 * model at all. Between them they are the whole consent guarantee at the point
 * where it is easiest to lose.
 */
const NOW = new Date("2026-09-16T12:00:00.000Z");
const HOUR = 3_600_000;
const USER = "user-1";
const JOHN = "entity-john";
const TEXT = "Hi John — are you visiting this weekend? Dad’s hoping so.";
const HASH = sha256Hex(TEXT);

function m5Store(status: "drafted" | "offered" = "drafted"): M5Store {
  const store = withM5(
    createStore({
      entities: [
        {
          id: JOHN, type: "person", subtype: null, displayName: "John",
          aliases: [], status: "active", lastMentionedAt: null,
        },
      ],
    }),
  );
  store.opportunities.push({
    id: "opp-1",
    userId: USER,
    signalId: "sig-1",
    entityId: JOHN,
    proposal: { entityId: JOHN, entityName: "John" },
    sharePayload: {
      fromDisplayName: "Dad",
      topic: "visit",
      question: "ask_if_visiting",
    },
    renderedText: TEXT,
    renderedTextHash: HASH,
    status,
    offeredAt: status === "offered" ? NOW.toISOString() : null,
    resolvedAt: null,
    expiresAt: new Date(NOW.getTime() + 24 * HOUR).toISOString(),
    createdAt: NOW.toISOString(),
  });
  return store;
}

function harness(store: M5Store, options: { chunks?: string[] } = {}) {
  const log: CallLog = [];
  const repos = fakeRepos({ log, ownedConversationIds: ["conv-1"] });
  const llm = fakeLlm({ log, chunks: options.chunks ?? ["It has been a lovely week."] });
  const jobs = fakeJobs({ log });
  const services = m5Deps({ store, clock: fixedClock(NOW) });
  // The REAL consent services, bound to the in-memory store.
  const consent = buildConsentHooks({
    consent: services.consent,
    closure: services.closure,
  });
  return {
    log,
    llm,
    repos,
    services,
    deps: {
      conversations: repos.conversations,
      messages: repos.messages,
      jobs: jobs.repo,
      llm,
      memory: async () => (await import("@/server/services/context")).EMPTY_MEMORY,
      consent,
      // The turn's terminal `state` event is derived from these.
      opportunities: services.consent.opportunities,
      entities: services.consent.entities,
    },
  };
}

beforeEach(() => {
  resetIds();
  resetM5Ids();
});

describe("1. the offer is appended by the application, verbatim", () => {
  it("persists the model's reply followed by the exact stored draft", async () => {
    const store = m5Store();
    const h = harness(store);

    const turn = await handleTurn(h.deps, {
      userId: USER, conversationId: "conv-1", text: "How are you?",
    });
    const output = await drain(turn.stream);

    expect(turn.deterministic).toBe(false);
    expect(output).toContain("It has been a lovely week.");
    expect(output).toContain(`I can send John this message:\n\n${TEXT}\n\n${OFFER_CLOSING_QUESTION}`);

    // The persisted transcript carries the draft byte for byte (F1b).
    const assistant = h.repos.assistantMessages().at(-1)!;
    expect(assistant.content).toContain(TEXT);
    expect(store.opportunities[0].status).toBe("offered");
    expect(store.opportunities[0].offeredAt).toBe(NOW.toISOString());
  });

  it("one perturbed character would break the byte-for-byte assertion", async () => {
    const store = m5Store();
    store.opportunities[0].renderedText = `${TEXT}!`;
    const h = harness(store);
    await drain(
      (await handleTurn(h.deps, { userId: USER, conversationId: "conv-1", text: "hi" })).stream,
    );
    const assistant = h.repos.assistantMessages().at(-1)!;
    expect(assistant.content).toContain(`${TEXT}!`);
    expect(assistant.content).not.toContain(`${TEXT}\n\n${OFFER_CLOSING_QUESTION}`);
  });

  it("the model is given a marker and never the draft (F1a / E1)", async () => {
    const store = m5Store();
    const h = harness(store);
    await drain(
      (await handleTurn(h.deps, { userId: USER, conversationId: "conv-1", text: "hi" })).stream,
    );

    const prompt = JSON.stringify(h.llm.lastRequest());
    expect(prompt).toContain("John");
    expect(prompt).toContain("word for word");
    for (const leak of [
      TEXT, HASH, "rendered_text", "renderedText", "sharePayload",
      "ask_if_visiting", "fromDisplayName",
    ]) {
      expect(prompt, leak).not.toContain(leak);
    }
  });

  it("does not present the same draft twice", async () => {
    const store = m5Store();
    const h = harness(store);
    await drain(
      (await handleTurn(h.deps, { userId: USER, conversationId: "conv-1", text: "hi" })).stream,
    );
    const second = await handleTurn(h.deps, {
      userId: USER, conversationId: "conv-1", text: "Tell me about the garden.",
    });
    const output = await drain(second.stream);
    expect(output).not.toContain(OFFER_CLOSING_QUESTION);
  });
});

describe("2. a clear answer never reaches the model", () => {
  it("approves deterministically, with zero model calls", async () => {
    const store = m5Store("offered");
    const h = harness(store);

    const turn = await handleTurn(h.deps, {
      userId: USER, conversationId: "conv-1", text: "yes please",
    });
    const output = await drain(turn.stream);

    expect(turn.deterministic).toBe(true);
    expect(turn.pendingSendOpportunityId).toBe("opp-1");
    expect(output).toBe("Thank you — I'll send that to John now.");
    // The whole point: general chat generation cannot swallow or reinterpret
    // the answer, because it was never asked.
    expect(h.log.filter((entry) => entry === "llm.streamChat")).toHaveLength(0);
    expect(store.opportunities[0].status).toBe("approved");
    expect(store.grants).toHaveLength(1);
    expect(store.grants[0].renderedTextSnapshot).toBe(TEXT);
    expect(store.grants[0].grantingMessageId).toBe(h.repos.userMessages().at(-1)!.id);
  });

  it("declines deterministically, and sends nothing", async () => {
    const store = m5Store("offered");
    const h = harness(store);

    const turn = await handleTurn(h.deps, {
      userId: USER, conversationId: "conv-1", text: "no, don't send it",
    });
    const output = await drain(turn.stream);

    expect(turn.pendingSendOpportunityId).toBeNull();
    expect(output).toBe("No problem. I won't send it.");
    expect(h.log.filter((entry) => entry === "llm.streamChat")).toHaveLength(0);
    expect(store.opportunities[0].status).toBe("declined");
    expect(store.grants).toHaveLength(0);
  });

  it("asks once more on hesitation, without re-showing the message", async () => {
    const store = m5Store("offered");
    const h = harness(store);

    const output = await drain(
      (await handleTurn(h.deps, { userId: USER, conversationId: "conv-1", text: "maybe later" }))
        .stream,
    );

    expect(output).toContain("would you like me to send that message to John?");
    expect(output).not.toContain(TEXT);
    expect(store.opportunities[0].status).toBe("offered");
    expect(store.grants).toHaveLength(0);
  });

  it("lets an unrelated remark be an unrelated remark", async () => {
    const store = m5Store("offered");
    const h = harness(store);

    const turn = await handleTurn(h.deps, {
      userId: USER, conversationId: "conv-1", text: "The roses came out beautifully.",
    });
    await drain(turn.stream);

    // The model DOES answer, the offer stands, and nothing was consented to.
    expect(turn.deterministic).toBe(false);
    expect(h.log.filter((entry) => entry === "llm.streamChat")).toHaveLength(1);
    expect(store.opportunities[0].status).toBe("offered");
    expect(store.grants).toHaveLength(0);
  });
});

describe("3. the closure is stated by the application, once", () => {
  it("leads the turn with the factual sentence and marks it surfaced", async () => {
    const store = m5Store("offered");
    store.opportunities[0].status = "consumed";
    store.requests.push({
      id: "req-1", opportunityId: "opp-1", contactId: "c1",
      renderedBody: TEXT, renderedBodyHash: HASH,
      payload: { fromDisplayName: "Dad", topic: "visit", question: "ask_if_visiting" },
      accessTokenHash: "hash", tokenExpiresAt: new Date(NOW.getTime() + 7 * 86_400_000).toISOString(),
      status: "answered", deliveryAttempts: 1, lastDeliveryError: null,
      createdAt: NOW.toISOString(), deliveredAt: NOW.toISOString(), openedAt: null,
    });
    store.responses.push({
      id: "res-1", requestId: "req-1", rawBody: "Yes, we're visiting this weekend.",
      parsed: { intent: "yes", timeframe: "this weekend" }, receivedAt: NOW.toISOString(),
    });
    store.familyClosures.push({
      id: "clo-1", opportunityId: "opp-1", responseId: "res-1",
      surfacedMessageId: null, surfacedAt: null, createdAt: NOW.toISOString(),
    });

    const h = harness(store);
    const output = await drain(
      (await handleTurn(h.deps, { userId: USER, conversationId: "conv-1", text: "Morning!" }))
        .stream,
    );

    expect(output.startsWith("John replied that they are planning to visit this weekend.")).toBe(true);
    expect(store.familyClosures[0].surfacedAt).toBe(NOW.toISOString());
    expect(store.familyClosures[0].surfacedMessageId).toBe(
      h.repos.assistantMessages().at(-1)!.id,
    );

    // Told once: the next turn says nothing about it.
    const second = await drain(
      (await handleTurn(h.deps, { userId: USER, conversationId: "conv-1", text: "And you?" }))
        .stream,
    );
    expect(second).not.toContain("John replied");
  });
});
