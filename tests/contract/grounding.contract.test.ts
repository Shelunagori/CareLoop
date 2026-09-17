import { describe, expect, it } from "vitest";
import { renderEntityCard } from "@/core/memory/present";
import { assembleContext, EMPTY_MEMORY, type MemorySections } from "@/server/services/context";
import { createOpenAiLlm } from "@/server/adapters/openai/llm";

/**
 * Real-API contract tests. Run explicitly:
 *
 *   OPENAI_API_KEY=... npm run test:llm-contract
 *
 * Two live regressions from M8 acceptance, and the only place either can
 * actually be checked. A prompt rule asserted against its own text is a rule
 * nobody has tested; a probabilistic assertion in CI is a flake. So they live
 * here, beside the name-grounding contract, and are run deliberately before a
 * prompt change.
 *
 * Neutral entities throughout. A rule that only holds for the demo fixture is
 * not a rule, and a contract test that proves it on the fixture proves nothing
 * about anybody else's dog.
 */
const hasKey = Boolean(process.env.OPENAI_API_KEY);

async function reply(memory: MemorySections, text: string): Promise<string> {
  const context = assembleContext({
    recentTurns: [
      { id: "m1", role: "user", content: text, createdAt: new Date().toISOString() },
    ],
    memory,
  });
  const stream = await createOpenAiLlm().streamChat({
    promptRef: context.promptRef,
    messages: context.messages,
  });
  let out = "";
  for await (const delta of stream) out += delta;
  return out;
}

/* ------------------------------------------------------------------ */
/* A reply that has arrived is not a reply still coming.               */
/* ------------------------------------------------------------------ */

const STILL_WAITING = [
  "let you know when",
  "let you know as soon as",
  "when he replies",
  "when they reply",
  "when rowan replies",
  "still waiting",
  "waiting to hear",
  "haven't heard",
  "have not heard",
  "hear back from",
  "as soon as i hear",
];

describe.skipIf(!hasKey)("the live model does not wait for a reply it already has", () => {
  const closureMemory: MemorySections = {
    ...EMPTY_MEMORY,
    pendingClosure: {
      type: "family_response",
      entityName: "Rowan",
      response: "yes",
      timeframe: "this weekend",
    },
  };

  it.each([
    "thank you",
    "oh that's good",
    "lovely, thanks for doing that",
  ])("never promises to pass on an answer it has already given (%j)", async (utterance) => {
    const text = (await reply(closureMemory, utterance)).toLowerCase();
    for (const phrase of STILL_WAITING) {
      expect(text, `${utterance} -> ${phrase}`).not.toContain(phrase);
    }
  }, 60_000);

  it("warmth after the news is still allowed", async () => {
    const text = await reply(closureMemory, "thank you");
    expect(text.trim().length).toBeGreaterThan(0);
  }, 30_000);
});

/* ------------------------------------------------------------------ */
/* A recorded label is not a possessive.                               */
/* ------------------------------------------------------------------ */

const OWNERSHIP = ["your dog", "your pet", "your puppy", "your little dog"];

describe.skipIf(!hasKey)("the live model keeps a relationship pointing the right way", () => {
  const petMemory: MemorySections = {
    ...EMPTY_MEMORY,
    entityCards: [
      renderEntityCard({
        name: "Pepper",
        type: "pet",
        subtype: "dog",
        aliases: [],
        // The user's edge is household membership, not ownership...
        relationToUser: { kind: "family_pet", status: "confirmed" },
        // ...and the only `pet` edge belongs to someone else.
        relatedEntities: [{ name: "Rowan", kind: "pet", status: "confirmed" }],
      }),
      renderEntityCard({
        name: "Rowan",
        type: "person",
        subtype: null,
        aliases: [],
        relationToUser: { kind: "son", status: "confirmed" },
        relatedEntities: [],
      }),
    ],
  };

  it.each([
    "Do you remember Pepper?",
    "Tell me about Pepper.",
    "Has Pepper been round lately?",
  ])("never calls a family_pet theirs (%j)", async (utterance) => {
    const text = (await reply(petMemory, utterance)).toLowerCase();
    for (const claim of OWNERSHIP) {
      expect(text, `${utterance} -> ${claim}`).not.toContain(claim);
    }
  }, 60_000);

  it("attributes the animal to the person whose `pet` edge it is", async () => {
    const text = await reply(petMemory, "Do you remember Pepper?");
    // It may answer with a pronoun or stay general; what it may not do is
    // assign the animal to the wrong person.
    if (/dog|pet/i.test(text)) {
      expect(text.toLowerCase()).not.toContain("your dog");
    }
    expect(text).not.toMatch(/your (dog|pet)\b/i);
  }, 30_000);

  it.each([
    "Who is Pepper?",
    "Do you remember Pepper?",
    "How do I know Pepper?",
  ])("answers an identity question with the specific relationship (%j)", async (utterance) => {
    // The M8 acceptance gap: "a dog who is recorded as part of the family" is
    // grounded and thinner than the truth. The owner is on the card; the
    // answer has to use it.
    const text = await reply(petMemory, utterance);
    expect(text, utterance).toContain("Rowan");
    for (const claim of OWNERSHIP) {
      expect(text.toLowerCase(), `${utterance} -> ${claim}`).not.toContain(claim);
    }
  }, 60_000);

  it("a family_pet with no other owner edge is still not theirs", async () => {
    const orphan: MemorySections = {
      ...EMPTY_MEMORY,
      entityCards: [
        renderEntityCard({
          name: "Pepper",
          type: "pet",
          subtype: "dog",
          aliases: [],
          relationToUser: { kind: "family_pet", status: "confirmed" },
          relatedEntities: [],
        }),
      ],
    };
    const text = (await reply(orphan, "Do you remember Pepper?")).toLowerCase();
    for (const claim of OWNERSHIP) {
      expect(text, claim).not.toContain(claim);
    }
  }, 30_000);
});
