import { describe, expect, it } from "vitest";
import { assembleContext, EMPTY_MEMORY, type MemorySections } from "@/server/services/context";
import { renderEntityCard } from "@/core/memory/present";

/**
 * Memory that is USED, not merely held.
 *
 * "John called yesterday." got "That's nice to hear." The entity card was in
 * the context; nothing in the context said he had just been brought up, and
 * every instruction about memory was a boundary rather than a purpose.
 *
 * These tests are about the CONTEXT — what the model is handed. Whether it
 * then writes a good sentence is a live question, and it is graded in
 * `tests/evals`, not asserted here.
 */
const card = (name: string, kind: string, status: "confirmed" | "candidate" = "confirmed") =>
  renderEntityCard({
    name,
    type: "person",
    subtype: null,
    aliases: [],
    relationToUser: { kind, status },
    relatedEntities: [],
  });

const withMemory = (overrides: Partial<MemorySections>): string => {
  const context = assembleContext({
    recentTurns: [],
    memory: { ...EMPTY_MEMORY, ...overrides },
  });
  // The memory block is the SECOND system message; the first is the sealed
  // prompt and must stay byte-identical whatever memory arrives.
  return context.messages[1]?.content ?? "";
};

describe("1. a person just named is pointed at", () => {
  it("says who was mentioned in this message", () => {
    const block = withMemory({
      entityCards: [card("Alan", "son")],
      mentionedNow: ["Alan"],
    });
    expect(block).toContain("They have just mentioned Alan in this message.");
  });

  it("asks for one question about what they said, not an inventory", () => {
    const block = withMemory({ entityCards: [card("Alan", "son")], mentionedNow: ["Alan"] });
    expect(block).toContain("ask ONE about what they told you");
    expect(block).toContain("Do not");
    expect(block).toContain("list what you know about them");
  });

  it("names two when two were mentioned", () => {
    const block = withMemory({
      entityCards: [card("Alan", "son"), card("Priya", "daughter")],
      mentionedNow: ["Alan", "Priya"],
    });
    expect(block).toContain("just mentioned Alan and Priya");
  });
});

describe("2. unrelated memory is present but never pointed at", () => {
  it("a recently-active entity nobody mentioned gets no spotlight", () => {
    const block = withMemory({
      entityCards: [card("Alan", "son"), card("Rex", "family_pet")],
      mentionedNow: ["Alan"],
    });
    // Rex's card is still available — the model may need it if they bring
    // him up — but nothing invites the companion to raise him.
    expect(block).toContain("Rex");
    expect(block).toContain("just mentioned Alan in this message");
    expect(block).not.toContain("just mentioned Rex");
  });

  it("says outright not to raise what they did not raise", () => {
    const block = withMemory({ entityCards: [card("Alan", "son")], mentionedNow: ["Alan"] });
    expect(block).toContain("do not mention anything above that");
    expect(block).toContain("they did not bring up");
  });

  it("no spotlight line at all when nobody was named", () => {
    const block = withMemory({ entityCards: [card("Alan", "son")] });
    expect(block).not.toContain("just mentioned");
  });
});

describe("3. unconfirmed memory is never promoted", () => {
  it("a candidate relationship is still marked, even when spotlit", () => {
    const block = withMemory({
      entityCards: [card("Alan", "son", "candidate")],
      mentionedNow: ["Alan"],
    });
    expect(block).toContain("(not yet confirmed)");
  });

  it("and the prompt forbids stating it as fact", async () => {
    const { conversationPromptV6 } = await import("@/server/prompts/conversation.v6");
    expect(conversationPromptV6.system).toContain("not yet confirmed");
    expect(conversationPromptV6.system).toContain("Never state it as fact");
  });
});

describe("4. ambiguity stays explicit", () => {
  it("the prompt requires a question rather than a guess", async () => {
    const { conversationPromptV6 } = await import("@/server/prompts/conversation.v6");
    expect(conversationPromptV6.system).toContain("If you cannot tell WHICH person");
    expect(conversationPromptV6.system).toContain("A wrong name");
    expect(conversationPromptV6.system).toContain("used confidently is worse than a question");
  });

  it("two entries that could both fit are both offered, undecided", () => {
    // The context does not resolve it. Nothing here picks one.
    const block = withMemory({
      entityCards: [card("Alan", "son"), card("Alan", "neighbour")],
      mentionedNow: ["Alan", "Alan"],
    });
    expect(block.match(/name to use: Alan/g)?.length).toBe(2);
  });
});

describe("5. the spotlight adds no fact", () => {
  it("names only, and only names the cards already carry", () => {
    const block = withMemory({
      entityCards: [card("Alan", "son")],
      mentionedNow: ["Alan"],
    });
    const spotlight = block.slice(block.indexOf("They have just mentioned"));
    // No relationship, no date, no claim — a pointer, not a statement.
    // Word boundaries, because "person" contains "son" and a substring
    // check here would be testing English rather than the code.
    for (const leak of [/\bson\b/, /\byesterday\b/, /\bcalled\b/, /\bconfirmed\b/]) {
      expect(spotlight, String(leak)).not.toMatch(leak);
    }
  });

  it("an empty-memory turn is byte-identical to one with no memory at all", () => {
    const bare = assembleContext({ recentTurns: [] });
    const empty = assembleContext({ recentTurns: [], memory: EMPTY_MEMORY });
    expect(empty.messages).toEqual(bare.messages);
    expect(empty.messages.length).toBe(1);
  });
});

describe("6. verified family state still outranks all of it", () => {
  it("an awaiting-reply marker survives alongside the spotlight", () => {
    const block = withMemory({
      entityCards: [card("Alan", "son")],
      mentionedNow: ["Alan"],
      awaitingFamilyReply: { entityName: "Alan", status: "awaiting_response" },
    });
    expect(block).toContain("NO reply has been recorded");
    expect(block).toContain("has NOT replied");
  });
});
