import { beforeEach, describe, expect, it } from "vitest";
import { fixedClock } from "@/server/adapters/clock";
import { handleConsentReply, prepareOffer } from "@/server/services/consent";
import { sendApprovedOpportunity } from "@/server/services/family-send";
import { loadAwaitingFamilyReply, loadPendingClosure } from "@/server/services/closure";
import { recordFamilyReply } from "@/server/services/family-response";
import { assembleContext, EMPTY_MEMORY } from "@/server/services/context";
import { handleTurn } from "@/server/services/conversation";
import { buildConsentHooks } from "@/server/services/consent-hooks";
import { drainEvents, fakeJobs, fakeLlm, fakeRepos, type CallLog } from "./fakes";
import { sha256Hex } from "@/core/share/text-hash";
import { createStore, resetIds } from "./detection-fakes";
import { m5Deps, resetM5Ids, withM5, type M5Store } from "./consent-fakes";

/**
 * P0: CARELOOP MUST NEVER INVENT A FAMILY REPLY.
 *
 * A live recording caught it doing exactly that. An approved message was sent.
 * The recipient never opened the link and never answered. The older adult
 * asked "have you heard from him at all?" and CareLoop answered that his son
 * had replied and would love to come and visit. The database was checked
 * afterwards: the family_request existed, family_responses was empty, closures
 * was empty. Nothing had happened.
 *
 * Whether someone replied is an external-world fact. The model is a sensor and
 * a renderer; it is never the one that decides such a fact occurred.
 *
 * These tests work on the CONTEXT - what the application hands the model -
 * rather than on generated text. A test that stubbed the model to say the
 * right sentence would prove only that a stub can be told what to say, and the
 * production bug was never that the model was incapable of answering well. It
 * was that nothing in the turn told it the truth.
 */
const NOW = new Date("2026-09-16T12:00:00.000Z");
const HOUR = 3_600_000;
const USER = "user-1";
const JOHN = "entity-john";
const TEXT = "Dad was wondering whether you might be able to visit soon.";

/** Every way the person might ask. None may produce a reply that never came. */
const THE_QUESTIONS = [
  "Have you heard from him at all?",
  "Did John reply?",
  "Has John answered?",
  "Have you heard back from him?",
  "What did John say?",
  "Is he coming?",
];

function seed(): M5Store {
  const store = withM5(
    createStore({
      entities: [
        {
          id: JOHN,
          type: "person",
          subtype: null,
          displayName: "John",
          aliases: [],
          status: "active",
          lastMentionedAt: null,
        },
      ],
    }),
  );
  store.opportunities.push({
    id: "opp-1",
    userId: USER,
    signalId: "sig-1",
    entityId: JOHN,
    proposal: {
      entityId: JOHN,
      entityName: "John",
      eventType: "visit",
      observation: { kind: "no_mention_since", days: 13 },
      pattern: { medianGapDays: 7 },
      question: "ask_if_visiting",
      transcriptNote: "",
    },
    sharePayload: { fromDisplayName: "Dad", topic: "visit", question: "ask_if_visiting" },
    renderedText: TEXT,
    renderedTextHash: sha256Hex(TEXT),
    status: "drafted",
    offeredAt: null,
    resolvedAt: null,
    expiresAt: new Date(NOW.getTime() + 24 * HOUR).toISOString(),
    createdAt: NOW.toISOString(),
  });
  return store;
}

/** The exact production state: approved, delivered, nobody answered. */
async function deliveredAndUnanswered() {
  const store = seed();
  const deps = m5Deps({ store, clock: fixedClock(NOW) });

  await prepareOffer(deps.consent, { userId: USER, recentMessages: [] });
  const approval = await handleConsentReply(deps.consent, {
    userId: USER,
    text: "yes please",
    grantingMessageId: "msg-1",
  });
  if (approval.outcome !== "approved") throw new Error(`expected approval: ${approval.outcome}`);

  const sent = await sendApprovedOpportunity(deps.send, {
    userId: USER,
    opportunityId: "opp-1",
  });
  if (sent.outcome !== "sent") throw new Error(`expected sent: ${sent.outcome}`);

  return { store, deps };
}

beforeEach(() => {
  resetIds();
  resetM5Ids();
});

describe("the production state: delivered, zero responses, zero closures", () => {
  it("reproduces exactly what the live database showed", async () => {
    const { store } = await deliveredAndUnanswered();

    expect(store.requests).toHaveLength(1);
    expect(store.requests[0].status).toBe("delivered");
    // The two counts that made this a hallucination rather than a stale row.
    expect(store.responses).toHaveLength(0);
    expect(store.familyClosures).toHaveLength(0);
  });

  it("there is NO closure to surface — so nothing verified says anyone replied", async () => {
    const { deps } = await deliveredAndUnanswered();
    expect(await loadPendingClosure(deps.closure, { userId: USER })).toBeNull();
  });

  it("the application states the NEGATIVE as a fact of its own", async () => {
    // The gap that let the model invent: it was told when a reply HAD arrived
    // and told nothing at all when one had not, so "has he replied?" was
    // answered from silence.
    const { deps } = await deliveredAndUnanswered();

    const awaiting = await loadAwaitingFamilyReply(deps.closure, { userId: USER });
    expect(awaiting).not.toBeNull();
    expect(awaiting!.entityName).toBe("John");
  });

  it("the awaiting state names a person and carries nothing else", async () => {
    // No address, no capability token, no request id in the marker the model
    // sees, no payload, no transcript.
    const { deps } = await deliveredAndUnanswered();
    const awaiting = await loadAwaitingFamilyReply(deps.closure, { userId: USER });

    const context = assembleContext({
      recentTurns: [],
      memory: {
        ...EMPTY_MEMORY,
        awaitingFamilyReply: { entityName: awaiting!.entityName, status: "awaiting_response" },
      },
    });
    const rendered = context.messages.map((m) => m.content).join("\n");

    expect(rendered).toContain("John");
    for (const secret of ["dev-inbox:", "token", "opp-1", TEXT, awaiting!.familyRequestId]) {
      expect(rendered, secret).not.toContain(secret);
    }
  });

  for (const question of THE_QUESTIONS) {
    it(`"${question}" is answered from a stated fact, not from silence`, async () => {
      const { deps } = await deliveredAndUnanswered();
      const awaiting = await loadAwaitingFamilyReply(deps.closure, { userId: USER });

      const context = assembleContext({
        recentTurns: [
          {
            id: "m1",
            role: "user",
            content: question,
            createdAt: NOW.toISOString(),
          },
        ],
        memory: {
          ...EMPTY_MEMORY,
          awaitingFamilyReply: { entityName: awaiting!.entityName, status: "awaiting_response" },
        },
      });
      const rendered = context.messages.map((m) => m.content).join("\n");

      // The truth is in the turn, in so many words.
      expect(rendered).toContain("NO reply has been recorded");
      expect(rendered).toContain("has NOT replied");

      // And nothing in the turn asserts the opposite.
      expect(rendered).not.toContain("has replied to the message you sent");
      expect(rendered).not.toContain("This reply has ARRIVED");
    });
  }

  it("the prompt forbids inventing one, and no longer self-authenticates", async () => {
    const { deps } = await deliveredAndUnanswered();
    const awaiting = await loadAwaitingFamilyReply(deps.closure, { userId: USER });
    const system = assembleContext({
      recentTurns: [],
      memory: {
        ...EMPTY_MEMORY,
        awaitingFamilyReply: { entityName: awaiting!.entityName, status: "awaiting_response" },
      },
    }).messages[0].content;

    expect(system).toContain("A family reply is never yours to announce");
    // v3's sentence, which made the model's own output its own evidence.
    expect(system).not.toContain("that someone replied, what they replied");
  });
});

describe("a real reply changes everything — and only a real one", () => {
  async function replied() {
    const { store, deps } = await deliveredAndUnanswered();
    const url = store.delivered[0].responseUrl;
    const token = url.slice(url.lastIndexOf("/") + 1);

    const outcome = await recordFamilyReply(deps.family, {
      token,
      choiceId: "yes_soon",
    });
    if (outcome.outcome !== "recorded") throw new Error(`expected recorded: ${outcome.outcome}`);
    return { store, deps };
  }

  it("persists a response AND a closure through the ordinary path", async () => {
    const { store } = await replied();
    expect(store.responses).toHaveLength(1);
    expect(store.familyClosures).toHaveLength(1);
  });

  it("the closure sentence comes from deterministic code, not from the model", async () => {
    const { deps } = await replied();
    const closure = await loadPendingClosure(deps.closure, { userId: USER });

    expect(closure).not.toBeNull();
    expect(closure!.sentence).toContain("John");
    // Rendered by renderClosureSentence from the stored reply. The model is
    // never asked to phrase this, and never gets the family member's words.
    expect(typeof closure!.sentence).toBe("string");
    expect(closure!.sentence.length).toBeGreaterThan(0);
  });

  it("the awaiting state is GONE — the two can never both be true", async () => {
    const { deps } = await replied();
    expect(await loadAwaitingFamilyReply(deps.closure, { userId: USER })).toBeNull();
  });

  it("a closure and an awaiting marker never render together", () => {
    // Belt to the repository's braces: even handed both, the context renders
    // only the closure. Saying a reply arrived and that none has, in one turn,
    // is the contradiction this whole fix is about.
    const rendered = assembleContext({
      recentTurns: [],
      memory: {
        ...EMPTY_MEMORY,
        pendingClosure: {
          type: "family_response",
          entityName: "John",
          response: "yes",
          timeframe: "this weekend",
        },
        awaitingFamilyReply: { entityName: "John", status: "awaiting_response" },
      },
    })
      .messages.map((m) => m.content)
      .join("\n");

    expect(rendered).toContain("has replied to the message you sent");
    expect(rendered).not.toContain("NO reply has been recorded");
  });
});

describe("a request that is not actually waiting produces no marker", () => {
  it("an undelivered request does not claim a message was sent", async () => {
    const { store, deps } = await deliveredAndUnanswered();
    store.requests[0].status = "pending";

    // "A message was sent to John" would be false: it has not gone yet.
    expect(await loadAwaitingFamilyReply(deps.closure, { userId: USER })).toBeNull();
  });

  it("an expired window stops waiting the moment it closes", async () => {
    const { store, deps } = await deliveredAndUnanswered();
    store.requests[0].tokenExpiresAt = new Date(NOW.getTime() - HOUR).toISOString();

    // Checked against the clock, not the status column: the lazy transition
    // may not have run, and a dead link is not something still awaited.
    expect(await loadAwaitingFamilyReply(deps.closure, { userId: USER })).toBeNull();
  });

  it("a response row wins over a stale status column", async () => {
    const { store, deps } = await deliveredAndUnanswered();
    store.responses.push({
      id: "resp-stale",
      requestId: store.requests[0].id,
      rawBody: "yes",
      parsed: { intent: "yes" },
      receivedAt: NOW.toISOString(),
    });

    // If the two ever disagree, the one that must win is the one that cannot
    // invent a reply.
    expect(await loadAwaitingFamilyReply(deps.closure, { userId: USER })).toBeNull();
  });

  it("no message sent at all means no marker", async () => {
    const store = seed();
    const deps = m5Deps({ store, clock: fixedClock(NOW) });
    expect(await loadAwaitingFamilyReply(deps.closure, { userId: USER })).toBeNull();
  });
});

describe("Restart Demo leaves no family history behind", () => {
  it("after the fixture cascade, neither marker can be produced", async () => {
    const { store, deps } = await deliveredAndUnanswered();
    const url = store.delivered[0].responseUrl;
    await recordFamilyReply(deps.family, {
      token: url.slice(url.lastIndexOf("/") + 1),
      choiceId: "yes_soon",
    });
    // A real reply existed before the reset.
    expect(store.responses).toHaveLength(1);
    expect(store.familyClosures).toHaveLength(1);

    /**
     * What Restart Demo does, through the frozen schema's own cascade: one
     * delete on the fixture entity retires the opportunity, and the request,
     * response and closure go with it. Modelled here rather than re-tested -
     * the cascade itself is the demo fixture's own coverage - because what
     * matters for THIS bug is what the next turn can then say.
     */
    store.opportunities.length = 0;
    store.requests.length = 0;
    store.responses.length = 0;
    store.familyClosures.length = 0;

    expect(await loadPendingClosure(deps.closure, { userId: USER })).toBeNull();
    expect(await loadAwaitingFamilyReply(deps.closure, { userId: USER })).toBeNull();

    // And with neither marker, the turn carries no family claim at all.
    const rendered = assembleContext({ recentTurns: [], memory: EMPTY_MEMORY })
      .messages.map((m) => m.content)
      .join("\n");
    expect(rendered).not.toContain("has replied to the message you sent");
    expect(rendered).not.toContain("NO reply has been recorded");
  });
});

describe("the WIRING — a real turn actually carries the awaiting state", () => {
  /**
   * The gap this closes. Every assertion above proves a PART: the repository
   * finds the request, the service builds the marker, the renderer writes the
   * sentence. None of them proved that `handleTurn` asks for it.
   *
   * Deleting the one line in conversation.ts that calls `loadAwaitingReply`
   * left the whole suite green - the production bug, reintroduced, with
   * nothing failing. So this exercises the real composition root through the
   * real hooks and reads what the model was actually handed.
   */
  async function turnAfterDelivery(text: string) {
    const { store, deps: services } = await deliveredAndUnanswered();
    const log: CallLog = [];
    const repos = fakeRepos({ log, ownedConversationIds: ["conv-1"] });
    const llm = fakeLlm({ log, chunks: ["Not yet, I'm afraid."] });

    const turn = await handleTurn(
      {
        conversations: repos.conversations,
        messages: repos.messages,
        jobs: fakeJobs({ log }).repo,
        llm,
        memory: async () => EMPTY_MEMORY,
        // The REAL hook composition, not a stub that returns what we want.
        consent: buildConsentHooks({ consent: services.consent, closure: services.closure }),
        opportunities: services.consent.opportunities,
        entities: services.consent.entities,
      },
      { userId: USER, conversationId: "conv-1", text },
    );
    await drainEvents(turn.stream);

    return { store, request: llm.lastRequest() };
  }

  it("the model is TOLD no reply has been recorded", async () => {
    const { request } = await turnAfterDelivery("Have you heard from him at all?");
    const sent = request!.messages.map((m) => m.content).join("\n");

    expect(sent).toContain("A message was sent to John");
    expect(sent).toContain("NO reply has been recorded");
    expect(sent).toContain("has NOT replied");
  });

  it("and the turn logs the v4 prompt that forbids inventing one", async () => {
    const { request } = await turnAfterDelivery("Did John reply?");
    expect(request!.promptRef).toBe("conversation.v4");
  });

  it("nothing about the message itself reaches the model", async () => {
    const { store, request } = await turnAfterDelivery("What did John say?");
    const sent = request!.messages.map((m) => m.content).join("\n");

    for (const secret of [TEXT, store.requests[0].id, store.delivered[0].responseUrl]) {
      expect(sent, secret).not.toContain(secret);
    }
  });
});
