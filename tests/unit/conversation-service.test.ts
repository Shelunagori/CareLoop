import { describe, expect, it } from "vitest";
import { chatConfig } from "@/server/config";
import { conversationPromptV1 } from "@/server/prompts/conversation.v1";
import {
  ConversationNotFoundError,
  handleTurn,
} from "@/server/services/conversation";
import { drain, emptyMemoryLoader, fakeJobs, fakeLlm, fakeRepos, type CallLog } from "./fakes";

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
    expect(request!.promptRef).toBe("conversation.v1");

    const [system, ...rest] = request!.messages;
    expect(system.role).toBe("system");
    // Byte-identical to the versioned prompt: nothing is appended at runtime.
    expect(system.content).toBe(conversationPromptV1.system);
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
    expect(first.value).toBe("first");
    // Nothing is persisted yet: the turn is still in flight.
    expect(repos.assistantMessages()).toHaveLength(0);

    openGate();
    const second = await iterator.next();
    expect(second.value).toBe("second");
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
