import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { conversationPromptV1 } from "@/server/prompts/conversation.v1";
import { conversationPromptV2 } from "@/server/prompts/conversation.v2";
import { conversationPromptV3 } from "@/server/prompts/conversation.v3";
import { assembleContext, EMPTY_MEMORY } from "@/server/services/context";

/**
 * A prompt is versioned BEHAVIOUR.
 *
 * `promptRef` is written to the provider log on every call, so a turn
 * generated last month has to stay explicable by the exact bytes that produced
 * it. That only holds if a shipped version is immutable: the moment v2 is
 * edited after being pushed, every historical `conversation.v2` log line
 * points at text that no longer exists, and the log stops being evidence.
 *
 * M8's grounding rules therefore live in v3, and the two sealed versions are
 * pinned here by content hash - a comparison the test can make on its own,
 * with no git history to depend on.
 */
const hash = (file: string) =>
  createHash("sha256").update(readFileSync(file)).digest("hex");

/** The bytes pushed at HEAD 27972d6, where M0-M7 were locked. */
const SEALED = {
  "server/prompts/conversation.v1.ts":
    "e57e8fef3e456cab761f821ef032a68a3802d3ffbf314e80c596ea3562b61dcb",
  "server/prompts/conversation.v2.ts":
    "2db98998c9b29dadd55360503dbed5e05b91ae25c34d4b6ca75583494c10c7f4",
} as const;

/** Everything M8 acceptance added. None of it may appear in a sealed version. */
const M8_RULES = [
  "the waiting is over",
  "still waiting to hear",
  "you have not heard yet",
  "Relationships:",
  "recorded relationship",
  "is not a possessive",
  "family_pet",
  "does NOT make the animal theirs",
  "MOST SPECIFIC",
  "never replaces a more specific one",
  "no recorded relationship names an owner",
];

describe("1. the sealed versions are sealed", () => {
  it.each(Object.entries(SEALED))("%s is byte-for-byte the pushed file", (file, digest) => {
    expect(hash(file)).toBe(digest);
  });

  it("neither sealed version has grown an M8 rule", () => {
    for (const rule of M8_RULES) {
      expect(conversationPromptV1.system, `v1: ${rule}`).not.toContain(rule);
      expect(conversationPromptV2.system, `v2: ${rule}`).not.toContain(rule);
    }
  });

  it("each version still declares its own ref", () => {
    expect(conversationPromptV1.ref).toBe("conversation.v1");
    expect(conversationPromptV2.ref).toBe("conversation.v2");
    expect(conversationPromptV3.ref).toBe("conversation.v3");
    expect(new Set([conversationPromptV1.ref, conversationPromptV2.ref, conversationPromptV3.ref]).size)
      .toBe(3);
  });
});

describe("2. v3 is v2 plus the M8 rules, and nothing lost", () => {
  it("carries every M8 rule", () => {
    for (const rule of M8_RULES) {
      expect(conversationPromptV3.system, rule).toContain(rule);
    }
  });

  it("keeps everything v2 was carrying", () => {
    // Section by section, so a rewrite that quietly dropped one of M7's
    // hard-won rules could not pass.
    for (const section of [
      "How to speak:",
      "Names:",
      "What is already established:",
      "Feelings are theirs to state:",
      "Hard limits:",
    ]) {
      expect(conversationPromptV3.system, section).toContain(section);
    }
    for (const rule of [
      // M7: canonical names.
      "name to use",
      "other names on record",
      "being warm never means",
      // M7: a verified update survives an ambiguous reply.
      "is NOT a correction",
      "Never retract, contradict or apologise",
      // M7: emotional non-inference.
      "Never attribute missing someone",
      "If you would like to know how they feel, ask them",
      // M5: the capability disclaimer that must never come back.
      "Never tell them you cannot send or receive",
    ]) {
      expect(conversationPromptV3.system, rule).toContain(rule);
    }
  });

  it("carries no name from the demo fixture", () => {
    for (const name of ["George", "John", "Johnny", "Simba"]) {
      expect(conversationPromptV3.system, name).not.toContain(name);
    }
  });
});

describe("3. v3 is the version that actually runs", () => {
  it("the assembled context sends v3's bytes", () => {
    const context = assembleContext({ recentTurns: [], memory: EMPTY_MEMORY });
    expect(context.messages[0].content).toBe(conversationPromptV3.system);
    expect(context.messages[0].content).not.toBe(conversationPromptV2.system);
  });

  it("and logs conversation.v3 as the ref", () => {
    // `promptRef` is what reaches the provider log, so this IS the provenance
    // record for every new call.
    expect(assembleContext({ recentTurns: [], memory: EMPTY_MEMORY }).promptRef).toBe(
      "conversation.v3",
    );
  });

  it("nothing on the live path still imports a sealed version", () => {
    const source = readFileSync("server/services/context.ts", "utf8");
    expect(source).toContain("conversation.v3");
    expect(source).not.toContain("conversation.v2");
    expect(source).not.toContain("conversation.v1");
  });
});
