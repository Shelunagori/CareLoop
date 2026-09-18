import { describe, expect, it } from "vitest";
import { boundToBudget, estimateTokens } from "@/core/llm/context-budget";
import { chatConfig, CLOUDFLARE_INPUT_TOKEN_BUDGET } from "@/server/config";

/**
 * KEEPING THE PROMPT INSIDE A 24k WINDOW.
 *
 * gpt-4o-mini had 128k and nobody had to think about it. The Llama model has
 * 24k, shared between input, output and overhead.
 *
 * What normally keeps CareLoop's context flat is not this function: it is
 * `chatConfig.recentTurnLimit` and the `memoryConfig` caps, which bound the
 * prompt by construction so it cannot grow with the length of a relationship.
 * This is the backstop for what those caps do not bound - twenty unusually
 * long turns - and its rules are about WHICH context is expendable.
 */
const words = (count: number) => "word ".repeat(count).trim();

const system = { role: "system" as const, content: "You are Nora." };
const latest = { role: "user" as const, content: "Have I told you about John?" };

describe("bounded context", () => {
  it("leaves an ordinary conversation completely alone", () => {
    const messages = [
      system,
      { role: "user" as const, content: "Morning." },
      { role: "assistant" as const, content: "Good morning, George." },
      latest,
    ];

    const result = boundToBudget(messages, CLOUDFLARE_INPUT_TOKEN_BUDGET);

    expect(result.messages).toEqual(messages);
    expect(result.droppedMessages).toBe(0);
  });

  it("trims the OLDEST history first when the budget is exceeded", () => {
    const messages = [
      system,
      { role: "user" as const, content: `oldest ${words(2000)}` },
      { role: "assistant" as const, content: `middle ${words(2000)}` },
      { role: "user" as const, content: `newest ${words(2000)}` },
      latest,
    ];

    const result = boundToBudget(messages, 3_000);

    expect(result.droppedMessages).toBeGreaterThan(0);
    const kept = result.messages.map((m) => m.content);
    expect(kept.some((c) => c.startsWith("oldest"))).toBe(false);
    // Recency is what a companion needs; the oldest turn is the expendable one.
    expect(kept.some((c) => c.startsWith("newest"))).toBe(true);
  });

  it("NEVER drops the latest user turn, whatever the budget", () => {
    const messages = [system, { role: "assistant" as const, content: words(5000) }, latest];

    // A budget far too small for any of it.
    const result = boundToBudget(messages, 10);

    expect(result.messages).toContainEqual(latest);
    // And it is not truncated either - the person's actual words go through
    // intact or not at all. chatConfig.maxMessageLength already bounds them.
    expect(result.messages.at(-1)?.content).toBe(latest.content);
  });

  it("NEVER drops a system message — the grounding rules are not optional", () => {
    const messages = [
      system,
      { role: "system" as const, content: "Never invent a name." },
      { role: "user" as const, content: words(5000) },
      latest,
    ];

    const result = boundToBudget(messages, 10);

    expect(result.messages.filter((m) => m.role === "system")).toHaveLength(2);
  });

  it("keeps message order after trimming", () => {
    const messages = [
      system,
      { role: "user" as const, content: words(1500) },
      { role: "assistant" as const, content: words(1500) },
      { role: "user" as const, content: words(1500) },
      latest,
    ];

    const result = boundToBudget(messages, 2_000);
    const indexes = result.messages.map((m) => messages.indexOf(m));
    expect(indexes).toEqual([...indexes].sort((a, b) => a - b));
  });

  it("the estimate is deliberately pessimistic", () => {
    // No tokenizer ships with this app, so the budget is defended with a
    // character heuristic. It must OVER-count: under-counting is what puts a
    // request over the real window and turns a conversation into a 400.
    const text = words(100);
    const conservative = Math.ceil(text.length / 4);
    expect(estimateTokens(text)).toBeGreaterThanOrEqual(conservative);
  });

  it("the configured budget leaves room for the largest output ceiling", () => {
    // 24k context, shared. If the input budget plus the biggest output
    // allowance approached the window, a long extraction would fail at the
    // provider rather than here.
    expect(CLOUDFLARE_INPUT_TOKEN_BUDGET + 2048).toBeLessThan(24_000);
  });

  it("the existing turn cap still does the real work", () => {
    // Twenty turns at the API's own per-message ceiling is the realistic worst
    // case, and it fits the budget without this backstop firing at all. If
    // that stops being true, this test is where it shows up.
    const worstCase = Array.from({ length: chatConfig.recentTurnLimit }, () => ({
      role: "user" as const,
      content: "x".repeat(chatConfig.maxMessageLength),
    }));

    const result = boundToBudget([system, ...worstCase, latest], CLOUDFLARE_INPUT_TOKEN_BUDGET);
    expect(result.droppedMessages).toBe(0);
  });
});
