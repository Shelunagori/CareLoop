import { describe, expect, it } from "vitest";
import { conversationPromptV2 } from "@/server/prompts/conversation.v2";
import { renderEntityCard } from "@/core/memory/present";
import { assembleContext, EMPTY_MEMORY } from "@/server/services/context";
import { createOpenAiLlm } from "@/server/adapters/openai/llm";

/**
 * Real-API contract test. Run explicitly:
 *
 *   OPENAI_API_KEY=... npm run test:llm-contract
 *
 * It answers the one question the deterministic tests cannot: under the
 * current prompt version, does the live model actually keep a stored name?
 * Live acceptance found it shortening one, and a rule that is only asserted
 * against its own text is a rule nobody has checked.
 *
 * It does NOT gate an ordinary run. A probabilistic assertion in CI is a
 * flake, and a muted test is worse than no test — so it lives here, beside
 * the extraction contract, and is run deliberately before a prompt change.
 */
const STORED_NAME = "Katherine";
/** Every shape the rule forbids, for a name that strongly invites them. */
const FORBIDDEN = ["Kathy", "Kate", "Katie", "Kath", "Catherine", "Kat ", "Kitty"];

const PROMPTS = [
  "I haven't seen Katherine this week.",
  "Do you remember Katherine?",
  "Katherine usually comes on Sundays.",
];

function contextFor(text: string, aliases: readonly string[], name = STORED_NAME) {
  return assembleContext({
    recentTurns: [
      { id: "m1", role: "user", content: text, createdAt: new Date().toISOString() },
    ],
    memory: {
      ...EMPTY_MEMORY,
      entityCards: [
        renderEntityCard({
          name,
          type: "person",
          subtype: null,
          aliases: [...aliases],
          relationToUser: { kind: "daughter", status: "confirmed" },
          relatedEntities: [],
        }),
      ],
    },
  });
}

async function reply(
  text: string,
  aliases: readonly string[] = [],
  name = STORED_NAME,
): Promise<string> {
  const context = contextFor(text, aliases, name);
  const stream = await createOpenAiLlm().streamChat({
    promptRef: context.promptRef,
    messages: context.messages,
  });
  let out = "";
  for await (const delta of stream) out += delta;
  return out;
}

describe("the live model keeps a stored name", () => {
  it("uses the prompt version that carries the rule", () => {
    expect(contextFor("hello", []).promptRef).toBe(conversationPromptV2.ref);
  });

  it("never invents a diminutive for an entity with no recorded alias", async () => {
    for (const prompt of PROMPTS) {
      const text = await reply(prompt);
      for (const invented of FORBIDDEN) {
        expect(text, `${prompt} -> ${invented}`).not.toContain(invented.trim());
      }
    }
  }, 60_000);

  it("keeps the stored name when it names the person at all", async () => {
    const text = await reply("I haven't seen Katherine this week.");
    // It may use a pronoun instead; what it may not do is use another name.
    const namesSomeone = /\b[A-Z][a-z]{2,}\b/.test(text.replace(/^[^.!?]*/, ""));
    if (namesSomeone && /Kath|Kate|Kat|Cath/i.test(text)) {
      expect(text).toContain(STORED_NAME);
    }
  }, 30_000);

  it("does not lead with a recorded alias the person has not used", async () => {
    // The acceptance case the review asked for: a canonical name WITH a stored
    // alias. Using the alias is permitted only after the person does.
    for (const prompt of PROMPTS) {
      const text = await reply(prompt, ["Kitty"]);
      expect(text, prompt).not.toContain("Kitty");
      for (const invented of FORBIDDEN) {
        expect(text, `${prompt} -> ${invented}`).not.toContain(invented.trim());
      }
    }
  }, 60_000);

  it("may use the recorded alias once the person uses it first", async () => {
    // Not asserting that it DOES - a pronoun is equally correct - only that
    // the alias is no longer forbidden, and that no OTHER form appears.
    const text = await reply("Kitty hasn't been round this week.", ["Kitty"]);
    for (const invented of FORBIDDEN.filter((name) => name.trim() !== "Kitty")) {
      expect(text, invented).not.toContain(invented.trim());
    }
  }, 30_000);

  it("a pronoun or a grounded relationship word is acceptable", async () => {
    // The refined rule: the companion need not repeat the proper name every
    // time. What it may never do is use a DIFFERENT name.
    const text = await reply("I haven't seen Katherine this week.");
    const usesSomething =
      text.includes(STORED_NAME) || /\b(she|her|they|them|your daughter)\b/i.test(text);
    expect(usesSomething).toBe(true);
  }, 30_000);
});

/**
 * The other half of grounding: what the person said happened, versus how they
 * felt about it.
 *
 * Live acceptance produced "I'm sorry - you may be missing seeing John" from a
 * turn that reported only a week without a visit. The prompt now forbids it,
 * and this is the only place that can check whether the live model obeys.
 */
const FEELING_CLAIMS = [
  "miss",
  "missing",
  "lonely",
  "loneliness",
  "sad",
  "upset",
  "upsetting",
  "worried",
  "worry",
  "hard for you",
  "difficult for you",
  "disappoint",
  "must be",
  "sounds like you",
];

describe("an observable absence is not turned into a feeling", () => {
  it("acknowledges the week without attributing an emotion", async () => {
    for (const attempt of [0, 1, 2]) {
      const text = await reply("I haven't seen Margaret this week.", [], "Margaret");
      const lower = text.toLowerCase();
      for (const claim of FEELING_CLAIMS) {
        expect(lower, `attempt ${attempt}: "${claim}" in ${text}`).not.toContain(claim);
      }
    }
  }, 90_000);

  it("may still be warm, and may still ask a grounded follow-up", async () => {
    const text = await reply("I haven't seen Margaret this week.", [], "Margaret");
    // Not asserting a particular sentence - only that it engaged at all rather
    // than going silent to satisfy the rule.
    expect(text.trim().length).toBeGreaterThan(10);
    expect(/margaret|her|she|they/i.test(text)).toBe(true);
  }, 30_000);

  it("a feeling the person DOES state may be acknowledged", async () => {
    // The rule bans inventing one, not hearing one.
    const text = await reply("I miss Margaret. I haven't seen her this week.", [], "Margaret");
    expect(text.trim().length).toBeGreaterThan(10);
  }, 30_000);
});

/**
 * The ambiguity regression, against the live model.
 *
 * After a verified update, "no not yet" made the companion retract the update
 * and deny being able to send or receive messages at all. Deterministic tests
 * can only check that the rule is in the prompt; whether the model honours it
 * is a question for the model.
 */
const RETRACTIONS = [
  "i cannot send",
  "i can't send",
  "i cannot contact",
  "i can't contact",
  "unable to send",
  "i don't have the ability",
  "i do not have the ability",
  "i'm not able to send",
  "i was mistaken",
  "i apologise for the confusion",
  "i apologize for the confusion",
  "i shouldn't have said",
  "that wasn't accurate",
];

async function replyAfterUpdate(followUp: string): Promise<string> {
  const context = assembleContext({
    recentTurns: [
      {
        id: "m1",
        role: "assistant",
        content: "Margaret replied that they are planning to visit this weekend.",
        createdAt: new Date().toISOString(),
      },
      { id: "m2", role: "user", content: followUp, createdAt: new Date().toISOString() },
    ],
    memory: { ...EMPTY_MEMORY, pendingClosure: null },
  });
  const stream = await createOpenAiLlm().streamChat({
    promptRef: context.promptRef,
    messages: context.messages,
  });
  let out = "";
  for await (const delta of stream) out += delta;
  return out;
}

describe("an ambiguous reply does not retract a verified update", () => {
  it("never denies a capability CareLoop has, and never takes the update back", async () => {
    for (const followUp of ["no not yet", "hmm", "not really", "no"]) {
      const text = (await replyAfterUpdate(followUp)).toLowerCase();
      for (const retraction of RETRACTIONS) {
        expect(text, `"${followUp}" -> ${retraction}`).not.toContain(retraction);
      }
    }
  }, 120_000);

  it("engages rather than going silent, and may ask what they meant", async () => {
    const text = await replyAfterUpdate("no not yet");
    expect(text.trim().length).toBeGreaterThan(5);
  }, 30_000);
});
