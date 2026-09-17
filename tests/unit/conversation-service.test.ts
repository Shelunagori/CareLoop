import { describe, expect, it } from "vitest";
import { chatConfig } from "@/server/config";
import { conversationPromptV3 } from "@/server/prompts/conversation.v3";
import {
  ConversationNotFoundError,
  handleTurn,
  loadConversationView,
} from "@/server/services/conversation";
import { drain, drainEvents, emptyMemoryLoader, fakeJobs, fakeLlm, fakeRepos, type CallLog } from "./fakes";

const USER = "user-a";
const OTHER_USERS_CONVERSATION = "conv-owned-by-someone-else";

function setup(options: Parameters<typeof fakeLlm>[0] & {
  ownedConversationIds?: string[];
}) {
  const log: CallLog = [];
  const repos = fakeRepos({ log, ownedConversationIds: options.ownedConversationIds });
  const llm = fakeLlm({ ...options, log });
  const jobs = fakeJobs({ log });
  return {
    log,
    repos,
    llm,
    jobs,
    deps: { ...repos, llm, jobs: jobs.repo, memory: emptyMemoryLoader },
  };
}

describe("handleTurn", () => {
  it("creates a conversation when none is supplied", async () => {
    const { deps, log } = setup({ log: [] });
    const turn = await handleTurn(deps, { userId: USER, text: "hello" });
    await drain(turn.stream);

    expect(log[0]).toBe(`conversations.create:${USER}`);
    expect(turn.conversationId).toBe("conv-1");
  });

  it("refuses a conversation the user does not own, and writes nothing", async () => {
    const { deps, repos, log } = setup({ log: [], ownedConversationIds: [] });

    await expect(
      handleTurn(deps, {
        userId: USER,
        conversationId: OTHER_USERS_CONVERSATION,
        text: "let me read this",
      }),
    ).rejects.toBeInstanceOf(ConversationNotFoundError);

    expect(repos.stored).toHaveLength(0);
    expect(log.some((entry) => entry.startsWith("messages.insert"))).toBe(false);
    expect(log).not.toContain("llm.streamChat");
  });

  it("persists the user message BEFORE calling the model", async () => {
    const { deps, log } = setup({ log: [] });
    const turn = await handleTurn(deps, { userId: USER, text: "hello" });
    await drain(turn.stream);

    expect(log.indexOf("messages.insert:user")).toBeLessThan(
      log.indexOf("llm.streamChat"),
    );
  });

  it("persists the assistant message after a successful stream", async () => {
    const { deps, repos } = setup({ log: [], chunks: ["Good ", "morning."] });
    const turn = await handleTurn(deps, { userId: USER, text: "hello" });
    const text = await drain(turn.stream);

    expect(text).toBe("Good morning.");
    expect(repos.assistantMessages()).toHaveLength(1);
    expect(repos.assistantMessages()[0].content).toBe("Good morning.");
  });

  it("does not persist an assistant message when the request fails", async () => {
    const { deps, repos } = setup({ log: [], failOnRequest: true });

    await expect(
      handleTurn(deps, { userId: USER, text: "hello" }),
    ).rejects.toThrow(/upstream rejected/);

    expect(repos.assistantMessages()).toHaveLength(0);
    // The user's own words survive the failure.
    expect(repos.userMessages()).toHaveLength(1);
  });

  it("does not persist an assistant message when the stream fails midway", async () => {
    const { deps, repos } = setup({
      log: [],
      chunks: ["Half a thou"],
      failMidStream: true,
    });
    const turn = await handleTurn(deps, { userId: USER, text: "hello" });

    await expect(drain(turn.stream)).rejects.toThrow(/mid-stream/);
    expect(repos.assistantMessages()).toHaveLength(0);
    expect(repos.userMessages()).toHaveLength(1);
  });

  it("bounds the context to the configured recent-turn limit", async () => {
    const { deps, repos } = setup({ log: [] });
    const turn = await handleTurn(deps, { userId: USER, text: "hello" });
    await drain(turn.stream);

    expect(repos.lastListRecentLimit).toBe(chatConfig.recentTurnLimit);
  });

  it("sends no fabricated memory — system prompt only, plus real turns", async () => {
    const { deps, llm } = setup({ log: [] });
    const turn = await handleTurn(deps, { userId: USER, text: "hello" });
    await drain(turn.stream);

    const request = llm.lastRequest();
    expect(request).not.toBeNull();
    expect(request!.promptRef).toBe("conversation.v3");

    const [system, ...rest] = request!.messages;
    expect(system.role).toBe("system");
    // Byte-identical to the versioned prompt: nothing is appended at runtime.
    expect(system.content).toBe(conversationPromptV3.system);
    expect(rest).toEqual([{ role: "user", content: "hello" }]);
  });

  it("delivers deltas incrementally — the consumer sees chunk 1 before chunk 2 is produced", async () => {
    // A gate the fake model will not pass until the consumer has already
    // received the first delta. If anything buffered the full completion
    // before yielding, this would deadlock rather than pass.
    let openGate!: () => void;
    const gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });

    const log: CallLog = [];
    const repos = fakeRepos({ log });
    const jobs = fakeJobs({ log });
    const deps = {
      ...repos,
      jobs: jobs.repo,
      memory: emptyMemoryLoader,
      llm: {
        async streamChat() {
          return (async function* () {
            yield "first";
            await gate;
            yield "second";
          })();
        },
      },
    };

    const turn = await handleTurn(deps, { userId: USER, text: "hello" });
    const iterator = turn.stream[Symbol.asyncIterator]();

    const first = await iterator.next();
    // The event framing is transport; the incremental guarantee is unchanged.
    expect(first.value).toEqual({ type: "delta", text: "first" });
    // Nothing is persisted yet: the turn is still in flight.
    expect(repos.assistantMessages()).toHaveLength(0);

    openGate();
    const second = await iterator.next();
    expect(second.value).toEqual({ type: "delta", text: "second" });
    await iterator.next();

    expect(repos.assistantMessages()[0].content).toBe("firstsecond");
  });

  it("does not send the current user message twice", async () => {
    const { deps, llm } = setup({ log: [] });
    const turn = await handleTurn(deps, { userId: USER, text: "hello" });
    await drain(turn.stream);

    const userTurns = llm
      .lastRequest()!
      .messages.filter((m) => m.role === "user" && m.content === "hello");
    expect(userTurns).toHaveLength(1);
  });
});

describe("the reconnect card's lifecycle is the server's to decide", () => {
  /**
   * The bug: after the family member replied, the card still said "Approved —
   * on its way to John" about a message John had already answered. The
   * terminal state lived in the browser, where nothing could correct it.
   *
   * The read model below is the correction. It reads STATUS, never prose, and
   * it describes only a reconnect that is still actionable or still in flight.
   * Everything past that is the conversation's job, not a card's.
   */
  const USER_ID = "u-1";
  const NOW = "2026-09-17T12:00:00.000Z";

  type Status = "proposed" | "drafted" | "offered" | "approved" | "consumed" | "declined" | "expired";

  function deps(statuses: Status[]) {
    const rows = statuses.map((status, i) => ({
      id: `opp-${i}`,
      userId: USER_ID,
      signalId: `sig-${i}`,
      entityId: "e-john",
      proposal: {},
      sharePayload: {},
      renderedText: "Dad was wondering — are you able to visit soon?",
      renderedTextHash: "hash",
      status,
      offeredAt: null,
      resolvedAt: null,
      expiresAt: "2026-09-30T00:00:00.000Z",
      createdAt: NOW,
    }));
    return {
      conversations: {
        async findLatest() {
          return { id: "conv-1" };
        },
        async create() {
          return { id: "conv-1" };
        },
        async findOwned() {
          return { id: "conv-1" };
        },
        async earliestStartedAt() {
          return null;
        },
      },
      messages: {
        async listRecent() {
          return [];
        },
        async insert() {
          throw new Error("not used");
        },
        async findById() {
          return null;
        },
      },
      opportunities: {
        // The real repository returns PRE-TERMINAL statuses only. Modelling
        // that is the point: `consumed`, `declined` and `expired` are not open,
        // so they can never reach the card.
        async listOpenForUser() {
          return rows.filter((row) =>
            ["proposed", "drafted", "offered", "approved"].includes(row.status),
          );
        },
      },
      entities: {
        async listForUser() {
          return [
            {
              id: "e-john",
              type: "person" as const,
              subtype: null,
              displayName: "John",
              aliases: [],
              status: "active" as const,
              lastMentionedAt: null,
            },
          ];
        },
      },
    } as unknown as Parameters<typeof loadConversationView>[0];
  }

  const offerFor = async (statuses: Status[]) =>
    (await loadConversationView(deps(statuses), USER_ID)).pendingOffer;

  it("offered is the only actionable state", async () => {
    expect(await offerFor(["offered"])).toMatchObject({ entityName: "John", state: "offered" });
  });

  it("approved is in flight, and says so rather than claiming delivery", async () => {
    expect(await offerFor(["approved"])).toMatchObject({ state: "sending" });
  });

  it("a drafted opportunity is not a card — nobody has been shown it", async () => {
    expect(await offerFor(["drafted"])).toBeNull();
    expect(await offerFor(["proposed"])).toBeNull();
  });

  it("consumed shows nothing: the request is authorized and the card is done", async () => {
    // This is the state the loop reaches once the send finalises, and the
    // state it was still showing a stale card in.
    expect(await offerFor(["consumed"])).toBeNull();
  });

  it("declined and expired show nothing", async () => {
    expect(await offerFor(["declined"])).toBeNull();
    expect(await offerFor(["expired"])).toBeNull();
    expect(await offerFor(["declined", "expired", "consumed"])).toBeNull();
  });

  it("an answer the person still owes outranks one in flight", async () => {
    const offer = await offerFor(["approved", "offered"]);
    expect(offer).toMatchObject({ state: "offered" });
  });

  it("the card carries the exact stored bytes, never a rebuild", async () => {
    const offer = await offerFor(["offered"]);
    expect(offer!.renderedText).toBe("Dad was wondering — are you able to visit soon?");
    expect(offer!.block).toContain(offer!.renderedText);
  });

  it("every turn ends by telling the browser the current state", async () => {
    const { deps: turnDeps } = setup({ log: [] });
    const turn = await handleTurn(turnDeps, { userId: USER, text: "hello" });
    const events = await drainEvents(turn.stream);

    const last = events[events.length - 1];
    expect(last.type).toBe("state");
    // Exactly one, and it is last: a card can never be left describing a
    // moment the turn has already moved past.
    expect(events.filter((e) => e.type === "state")).toHaveLength(1);
  });

  it("the state event carries no message text", async () => {
    // It describes the reconnect, not the turn. Nothing about it is persisted.
    const { deps: turnDeps, repos } = setup({ log: [] });
    const turn = await handleTurn(turnDeps, { userId: USER, text: "hello" });
    const text = await drain(turn.stream);
    expect(repos.assistantMessages()[0].content).toBe(text);
    expect(text).not.toContain("pendingOffer");
  });
});
