import { describe, expect, it } from "vitest";
import { handleTurn } from "@/server/services/conversation";
import { OUTREACH_FALLBACK } from "@/core/safety/outreach-guard";
import { drainEvents, emptyMemoryLoader, fakeJobs, fakeRepos, type CallLog } from "./fakes";

/**
 * One authority for external actions, on the wire.
 *
 * `outreach-guard.test.ts` proves the rule. This proves that the streaming
 * turn applies it, that the person never SEES a suppressed sentence, and
 * that ordinary prose is not slowed down to achieve either.
 */
const USER = "user-a";

function turnWith(chunks: readonly string[]) {
  const log: CallLog = [];
  const repos = fakeRepos({ log });
  const jobs = fakeJobs({ log });
  return {
    log,
    repos,
    deps: {
      ...repos,
      jobs: jobs.repo,
      memory: emptyMemoryLoader,
      llm: {
        async streamChat() {
          return (async function* () {
            for (const chunk of chunks) yield chunk;
          })();
        },
      },
    },
  };
}

const spoken = (events: Array<{ type: string } & Record<string, unknown>>) =>
  events
    .filter((event) => event.type === "delta")
    .map((event) => event.text as string)
    .join("");

describe("1. the sentence observed in the browser never reaches the person", () => {
  it("is not streamed, and is not persisted", async () => {
    const { deps, repos } = turnWith([
      "That's good ",
      "to hear. ",
      "Would you like to send ",
      "a message to someone, by the way?",
    ]);
    const turn = await handleTurn(deps, { userId: USER, text: "I am doing good what about you?" });
    const events = await drainEvents(turn.stream);

    expect(spoken(events)).toBe("That's good to hear.");
    // Persisted too: the transcript a reload shows must match what was
    // said. A guard that only filtered the stream would put the suppressed
    // sentence back on screen at the next page load.
    const stored = await repos.messages.listRecent(turn.conversationId, 10);
    const assistant = stored.filter((message) => message.role === "assistant");
    expect(assistant.at(-1)?.content).toBe("That's good to hear.");
  });

  it("no delta ever contains a fragment of it", async () => {
    // The point of holding a suspicious sentence rather than retracting it:
    // "Would you like me to" must never appear on screen at all.
    const { deps } = turnWith(["Lovely. ", "Would ", "you ", "like ", "me ", "to ", "ring him?"]);
    const turn = await handleTurn(deps, { userId: USER, text: "hi" });
    const events = await drainEvents(turn.stream);
    for (const event of events) {
      if (event.type !== "delta") continue;
      expect(event.text as string).not.toMatch(/would/i);
    }
  });
});

describe("2. ordinary prose is not held back", () => {
  it("streams chunk by chunk, not sentence by sentence", async () => {
    const chunks = ["That ", "sounds ", "such ", "a lovely ", "morning."];
    const { deps } = turnWith(chunks);
    const turn = await handleTurn(deps, { userId: USER, text: "hello" });
    const events = await drainEvents(turn.stream);
    const deltas = events.filter((e) => e.type === "delta");

    // One delta per chunk: nothing was coalesced into a sentence-sized
    // wait. This is the property `conversation-service.test.ts` guards with
    // a gated generator, restated here as a count.
    expect(deltas.length).toBe(chunks.length);
    expect(spoken(events)).toBe("That sounds such a lovely morning.");
  });

  it("holds only from the word that could begin an offer", async () => {
    // "like" is the start of "like me to…", so the tail waits — for one
    // more chunk, until it is clearly something else. That is the entire
    // cost of the check on ordinary prose.
    const { deps } = turnWith(["That ", "sounds ", "like ", "a lovely ", "morning."]);
    const turn = await handleTurn(deps, { userId: USER, text: "hello" });
    const events = await drainEvents(turn.stream);
    expect(spoken(events)).toBe("That sounds like a lovely morning.");
    expect(events.filter((e) => e.type === "delta").length).toBe(4);
  });

  it("a question about the PERSON's own week is untouched", async () => {
    const { deps } = turnWith(["Lovely. Did you ring Margaret back in the end?"]);
    const turn = await handleTurn(deps, { userId: USER, text: "hello" });
    expect(spoken(await drainEvents(turn.stream))).toBe(
      "Lovely. Did you ring Margaret back in the end?",
    );
  });

  it("a sentence that merely STARTS like an offer is delayed, then delivered whole", async () => {
    const { deps } = turnWith(["Would ", "you ", "like ", "a cup of tea with that?"]);
    const turn = await handleTurn(deps, { userId: USER, text: "hello" });
    const events = await drainEvents(turn.stream);
    expect(spoken(events)).toBe("Would you like a cup of tea with that?");
    // Held as one piece rather than four, which is the cost of the check
    // and the whole of it.
    expect(events.filter((e) => e.type === "delta").length).toBe(1);
  });
});

describe("3. a turn that was nothing but an offer", () => {
  it("falls back rather than failing the turn", async () => {
    const { deps } = turnWith(["Would you like me to send him a message?"]);
    const turn = await handleTurn(deps, { userId: USER, text: "hello" });
    expect(spoken(await drainEvents(turn.stream))).toBe(OUTREACH_FALLBACK);
  });
});

describe("4. the smalltalk transcripts that prompted this, end to end", () => {
  it.each([
    ["hello", ["Hello there. ", "Good to hear from you."]],
    ["good and u", ["I'm glad you're doing well. ", "What have you been up to today?"]],
    ["how are you doing?", ["I'm here with you. ", "Tell me about your morning."]],
    [
      "I am doing good what about you?",
      ["I'm glad to hear it. ", "Would you like to send a message to someone, by the way?"],
    ],
  ])("%j produces no external-action suggestion", async (text, chunks) => {
    const { deps } = turnWith(chunks);
    const turn = await handleTurn(deps, { userId: USER, text });
    const said = spoken(await drainEvents(turn.stream));

    for (const leak of [
      /would you like (me )?to send/i,
      /send (a )?message to someone/i,
      /shall i (send|message|ring|contact)/i,
      /i can (send|message|contact)/i,
    ]) {
      expect(said, `${text}: ${leak}`).not.toMatch(leak);
    }
    expect(said.length).toBeGreaterThan(0);
  });

  it("and no reconnect offer is presented on any of them", async () => {
    // The deps here carry no consent hooks at all, so there is structurally
    // nothing that could emit one. The cadence presentation gate is proved
    // separately in cadence-presentation.test.ts against the same words.
    const { deps } = turnWith(["Hello there."]);
    const turn = await handleTurn(deps, { userId: USER, text: "hello" });
    const events = await drainEvents(turn.stream);
    expect(events.some((e) => e.type === "offer")).toBe(false);
  });
});
