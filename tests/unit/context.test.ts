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

  it("refuses populated memory rather than silently dropping it", () => {
    expect(() =>
      assembleContext({
        recentTurns: [],
        memory: { ...EMPTY_MEMORY, profileCard: "George, 82" },
      }),
    ).toThrow(/not implemented until M2/);
  });
});
