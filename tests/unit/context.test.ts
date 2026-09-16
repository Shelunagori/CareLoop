import { describe, expect, it } from "vitest";
import { conversationPromptV1 } from "@/server/prompts/conversation.v1";
import { EMPTY_MEMORY, assembleContext } from "@/server/services/context";
import type { StoredMessage } from "@/server/repositories/messages";

function turn(role: StoredMessage["role"], content: string, n: number): StoredMessage {
  return { id: `m${n}`, role, content, createdAt: `2026-01-01T00:00:0${n}Z` };
}

describe("assembleContext", () => {
  it("emits the versioned system prompt and nothing else ahead of the turns", () => {
    const context = assembleContext({
      recentTurns: [turn("user", "hi", 1), turn("assistant", "hello", 2)],
    });

    expect(context.promptRef).toBe("conversation.v1");
    expect(context.messages[0]).toEqual({
      role: "system",
      content: conversationPromptV1.system,
    });
    expect(context.messages).toHaveLength(3);
  });

  it("preserves chronological order", () => {
    const context = assembleContext({
      recentTurns: [turn("user", "first", 1), turn("assistant", "second", 2), turn("user", "third", 3)],
    });
    expect(context.messages.slice(1).map((m) => m.content)).toEqual([
      "first",
      "second",
      "third",
    ]);
  });

  it("carries no memory sections in M1", () => {
    const context = assembleContext({ recentTurns: [turn("user", "hi", 1)] });
    const blob = context.messages.map((m) => m.content).join("\n").toLowerCase();
    for (const leak of ["profile", "episode", "entity card", "baseline", "relationship"]) {
      expect(blob).not.toContain(leak);
    }
  });

  it("accepts the empty-memory constant", () => {
    expect(() =>
      assembleContext({ recentTurns: [], memory: EMPTY_MEMORY }),
    ).not.toThrow();
  });

  it("renders retrieved memory as a separate system message (M2)", () => {
    const context = assembleContext({
      recentTurns: [turn("user", "hi", 1)],
      memory: {
        ...EMPTY_MEMORY,
        profileCard: "What you know about them:\n- preferred_drink: tea",
        entityCards: ["Simba\n- pet (dog)\n- pet of John"],
        episodes: ["- John visited with Simba (2026-09-15)"],
      },
    });

    // The base prompt is never mutated.
    expect(context.messages[0].content).toBe(conversationPromptV1.system);
    expect(context.messages[1].role).toBe("system");
    expect(context.messages[1].content).toContain("preferred_drink: tea");
    expect(context.messages[1].content).toContain("Simba");
    expect(context.messages[1].content).toContain("John visited with Simba");
    // Recent turns still follow.
    expect(context.messages[2]).toEqual({ role: "user", content: "hi" });
  });

  it("renders a closure as a marker, never the family member's words (M5)", () => {
    const context = assembleContext({
      recentTurns: [],
      memory: {
        ...EMPTY_MEMORY,
        pendingClosure: {
          type: "family_response",
          entityName: "John",
          response: "yes",
          timeframe: "this weekend",
        },
      },
    });
    const serialized = JSON.stringify(context);
    expect(serialized).toContain("John");
    expect(serialized).toContain("this weekend");
    // The model is told the news was already stated, so it neither repeats nor
    // embroiders it.
    expect(serialized).toContain("ALREADY told them this");
    expect(serialized).toContain("do not guess how anyone feels");
  });

  it("renders a drafted opportunity as a marker and nothing more (E1)", () => {
    const context = assembleContext({
      recentTurns: [],
      memory: {
        ...EMPTY_MEMORY,
        draftedOpportunityMarker: { entityId: "e1", entityName: "John", status: "drafted" },
      },
    });
    const serialized = JSON.stringify(context);
    expect(serialized).toContain("John");
    expect(serialized).toContain("word for word");
    // The three things the marker must never carry.
    for (const leak of ["rendered_text", "renderedText", "sharePayload", "ask_if_visiting"]) {
      expect(serialized).not.toContain(leak);
    }
    // And the entity id is not needed by the model either.
    expect(serialized).not.toContain("e1");
  });
});
