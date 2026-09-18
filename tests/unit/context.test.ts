import { describe, expect, it } from "vitest";
import { renderEntityCard } from "@/core/memory/present";
import { conversationPromptV4 } from "@/server/prompts/conversation.v4";
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

    expect(context.promptRef).toBe("conversation.v4");
    expect(context.messages[0]).toEqual({
      role: "system",
      content: conversationPromptV4.system,
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
    // The SYSTEM PROMPT is constant and always present, so scanning it for
    // memory vocabulary tests the prompt's wording rather than this boundary.
    // What must be absent is a rendered memory SECTION, which is every message
    // other than the prompt and the turns themselves.
    const blob = context.messages
      .filter((m) => m.content !== conversationPromptV4.system)
      .map((m) => m.content)
      .join("\n")
      .toLowerCase();
    for (const leak of ["profile", "episode", "entity card", "baseline", "relationship"]) {
      expect(blob).not.toContain(leak);
    }
    // And there is nothing between the prompt and the turn at all.
    expect(context.messages).toHaveLength(2);
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
    expect(context.messages[0].content).toBe(conversationPromptV4.system);
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

describe("names reach the model as data, not as style", () => {
  /**
   * The other half of the fix. The card says which name to use; the prompt has
   * to say that using it is not optional — and has to say so in a way the
   * "be warm and natural" instructions above it cannot quietly outrank.
   */
  it("the prompt states the rule, with the forbidden shapes named", () => {
    const system = conversationPromptV4.system;
    expect(system).toContain("name to use");
    expect(system).toContain("use the 'name to use' exactly as");
    // Every shape the review listed, so a future edit cannot drop one quietly.
    for (const shape of [
      "nickname",
      "diminutive",
      "longer or shorter form",
      "different spelling",
      "honorific",
    ]) {
      expect(system, shape).toContain(shape);
    }
    // An ungrounded relationship label is forbidden separately, because a
    // grounded one is now explicitly allowed.
    expect(system).toContain("a relationship the notes do not record");
  });

  it("permits pronouns and grounded relationship words", () => {
    // The rule is about which NAME is used, not about naming someone every
    // time. Forcing the proper name into every sentence reads like a system,
    // not a companion.
    const system = conversationPromptV4.system;
    expect(system).toContain("You do not have to name someone every time");
    expect(system).toContain("'him', 'her', 'they' are");
    expect(system).toContain("a relationship the notes actually record");
    expect(system).toContain("WHENEVER you use a proper name");
  });

  it("the rule is scoped to recorded aliases, and to their use first", () => {
    const system = conversationPromptV4.system;
    expect(system).toContain("other names on record");
    expect(system).toContain("only if the user uses that recorded name first");
    // Never selected on the model's own initiative.
    expect(system).toContain("Do not choose one on your own");
    // And no claim about HOW an alias was learned: the data model records the
    // name, not its provenance.
    expect(system).not.toContain("used themselves");
    // And warmth is explicitly told it does not license a rename.
    expect(system).toContain("being warm never means");
  });

  it("v1 is kept unedited — a logged prompt ref must stay explicable", async () => {
    const { conversationPromptV1 } = await import("@/server/prompts/conversation.v1");
    expect(conversationPromptV1.ref).toBe("conversation.v1");
    expect(conversationPromptV1.system).not.toContain("name to use");
    expect(conversationPromptV4.ref).toBe("conversation.v4");
  });

  it("the prompt carries no example name from the demo fixture", () => {
    // The rule is generic. Coupling the prompt to the demo cast would be the
    // fixture leaking into shipped behaviour.
    for (const name of ["George", "John", "Johnny", "Simba"]) {
      expect(conversationPromptV4.system, name).not.toContain(name);
    }
  });

  it("an entity with no aliases sends the model exactly one name", () => {
    // End to end through the real assembler: what the model can see is the
    // stored name and nothing resembling it.
    const context = assembleContext({
      recentTurns: [turn("user", "I haven't seen John this week.", 1)],
      memory: {
        ...EMPTY_MEMORY,
        entityCards: [
          renderEntityCard({
            name: "John",
            type: "person",
            subtype: null,
            aliases: [],
            relationToUser: { kind: "son", status: "confirmed" },
            relatedEntities: [],
          }),
        ],
      },
    });

    const blob = context.messages.map((m) => m.content).join("\n");
    expect(blob).toContain("name to use: John");
    for (const invented of ["Johnny", "Jon ", "Jonathan", "Jonny"]) {
      expect(blob, invented).not.toContain(invented);
    }
  });

  it("the canonical name leads even when an alias IS on record", () => {
    // The acceptance case that matters, and the one the demo now carries: a
    // person WITH a recorded alias. The card must still say which name to use,
    // and the alias must arrive labelled rather than as an equal option.
    const context = assembleContext({
      recentTurns: [turn("user", "I haven't seen John this week.", 1)],
      memory: {
        ...EMPTY_MEMORY,
        entityCards: [
          renderEntityCard({
            name: "John",
            type: "person",
            subtype: null,
            aliases: ["Johnny"],
            relationToUser: { kind: "son", status: "confirmed" },
            relatedEntities: [],
          }),
        ],
      },
    });
    const blob = context.messages.map((m) => m.content).join("\n");

    expect(blob).toContain("name to use: John");
    expect(blob).toContain("other names on record: Johnny");
    // The alias appears exactly once, and only on the labelled line.
    expect(blob.match(/Johnny/g)).toHaveLength(1);
    expect(blob).not.toContain("also called");
    // And the rule that governs it travels with it.
    expect(blob).toContain("only if the user uses that recorded name first");
  });

  it("a recorded alias is passed through labelled, never as a bare synonym", () => {
    const context = assembleContext({
      recentTurns: [turn("user", "hello", 1)],
      memory: {
        ...EMPTY_MEMORY,
        entityCards: [
          renderEntityCard({
            name: "John",
            type: "person",
            subtype: null,
            aliases: ["Johnny"],
            relationToUser: { kind: "son", status: "confirmed" },
            relatedEntities: [],
          }),
        ],
      },
    });

    const blob = context.messages.map((m) => m.content).join("\n");
    expect(blob).toContain("name to use: John");
    expect(blob).toContain("other names on record: Johnny");
  });
});

describe("an observable absence is not an emotional state", () => {
  /**
   * The regression this closes.
   *
   * Told "I haven't seen John this week", the companion replied "I'm sorry—you
   * may be missing seeing John." The person reported a week; the reply reported
   * a feeling. The hard limits already forbade claims about mood, but missing
   * someone reads as a restatement of the same fact rather than as a mood
   * claim, so the rule never bit. It names the move explicitly now.
   *
   * This is the CONTRACT. The behavioural assertion needs a live model and
   * lives in tests/contract.
   */
  const system = conversationPromptV4.system;

  it("separates what happened from how it felt, in so many words", () => {
    expect(system).toContain("Feelings are theirs to state");
    expect(system).toContain("is an observable fact about a week, not a feeling about it");
    expect(system).toContain("never turn the first into the");
  });

  it("names every state it may not attribute", () => {
    for (const state of [
      "missing someone",
      "longing",
      "loneliness",
      "sadness",
      "worry",
      "distress",
      "disappointment",
      "any emotional effect",
    ]) {
      expect(system, state).toContain(state);
    }
    expect(system).toContain("unless they");
    expect(system).toContain("have said it in their own words");
  });

  it("closes the hedges — a guess is not made acceptable by softening it", () => {
    // The live failure was hedged: "you MAY BE missing seeing John".
    for (const hedge of ["'maybe'", "'perhaps'", "'it sounds like'", "'that must be'", "'you may be'"]) {
      expect(system, hedge).toContain(hedge);
    }
    expect(system).toContain("do not make an invented feeling acceptable");
    // And not as a question either, which is the obvious way round a ban on
    // statements.
    expect(system).toContain("not as a question");
  });

  it("quotes the sentences that are still allowed, so warmth is not banned", () => {
    // A rule that only lists prohibitions produces a companion that says
    // nothing. Both permitted shapes are written out.
    expect(system).toContain("Warmth is welcome");
    expect(system).toContain("I'm sorry you haven't seen Margaret this week");
    expect(system).toContain("Have you heard from her at all?");
    expect(system).toContain("If you would like to know how they feel, ask them");
  });

  it("quotes the sentences that are not, including the one live acceptance produced", () => {
    expect(system).toContain("You must be");
    expect(system).toContain("you may be missing seeing her");
    expect(system).toContain("that must be hard");
    expect(system).toContain("you");
    expect(system).toContain("sound lonely");
  });

  it("does not weaken the existing mood limit — it sits alongside it", () => {
    expect(system).toContain("Never make claims about their mood, loneliness, memory, cognition");
    expect(system).toContain("Stick to what they have actually told you.");
  });

  it("carries no fixture name", () => {
    for (const name of ["George", "John", "Johnny", "Simba"]) {
      expect(system, name).not.toContain(name);
    }
  });

  it("v1 never had the rule, and still does not", async () => {
    const { conversationPromptV1 } = await import("@/server/prompts/conversation.v1");
    expect(conversationPromptV1.system).not.toContain("Feelings are theirs to state");
    expect(conversationPromptV1.ref).toBe("conversation.v1");
  });

  it("the rule travels with every turn that carries an absence", () => {
    // End to end: the sentence that caused the failure, assembled for real.
    const context = assembleContext({
      recentTurns: [turn("user", "I haven't seen John this week.", 1)],
      memory: {
        ...EMPTY_MEMORY,
        entityCards: [
          renderEntityCard({
            name: "John",
            type: "person",
            subtype: null,
            aliases: ["Johnny"],
            relationToUser: { kind: "son", status: "confirmed" },
            relatedEntities: [],
          }),
        ],
      },
    });
    const blob = context.messages.map((m) => m.content).join("\n");
    expect(blob).toContain("Feelings are theirs to state");
    expect(blob).toContain("have said it in their own words");
  });
});

describe("a verified update survives an ambiguous reply", () => {
  /**
   * The regression this closes.
   *
   * After CareLoop had surfaced a verified family closure, the person typed
   * "no not yet" — deliberately ambiguous. The companion retracted the update
   * and announced that it could not send or receive messages at all.
   *
   * Two things caused it, and both were in the prompt:
   *
   *   1. The closure is structured context only on the turn it is SURFACED.
   *      `listUnsurfacedForUser` filters on `surfaced_at is null`, so by the
   *      next turn the only record is the transcript. That is fine — the
   *      sentence is right there in the persisted message — but nothing told
   *      the model that what it had already said was a record rather than a
   *      guess it could revisit.
   *
   *   2. The prompt said "You cannot contact anyone, send messages, or take
   *      actions in the world." For CareLoop that is simply false: with
   *      explicit consent it does send an exact message and does relay the
   *      reply. Under ambiguity the model reached for the strongest sentence
   *      it had been given, and that sentence was wrong.
   *
   * Fixed in the prompt alone — no closure, consent, notifier, lifecycle,
   * memory or fixture change — because the evidence was already in context.
   */
  const system = conversationPromptV4.system;

  it("states that what was already said is a record, not a guess", () => {
    expect(system).toContain("What is already established");
    expect(system).toContain("is a record");
    expect(system).toContain("not up for");
    // Checked with line breaks collapsed: the rule is the sentence, not the
    // column it happens to wrap at. v4 re-wrapped this line while leaving the
    // rule identical, and a character-exact assertion failed for no reason
    // anyone should have to investigate.
    expect(system.replace(/\s+/g, " ")).toContain(
      "revision because their next message is hard to read",
    );
  });

  it("but that record does NOT extend to family replies", () => {
    // The P0: v3 named "that someone replied, what they replied" as
    // established if the assistant had said it, which made the model's own
    // output its own evidence.
    expect(system).not.toContain("that someone replied, what they replied");
    expect(system.replace(/\s+/g, " ")).toContain(
      "This does NOT extend to family replies",
    );
    expect(system.replace(/\s+/g, " ")).toContain(
      "Your own earlier wording is not proof that a reply arrived",
    );
  });

  it("names ambiguity as ambiguity, not as a correction", () => {
    expect(system).toContain("A short, unclear or ambiguous reply is NOT a correction");
    // The exact live input, so the rule is anchored to the thing that broke.
    expect(system).toContain("'no not yet'");
    expect(system).toContain("none");
    expect(system).toContain("of them is proof that you were wrong");
  });

  it("tells it to ask rather than to guess", () => {
    expect(system).toContain("When you cannot tell what they mean, ask");
    expect(system).toContain("One short question");
    expect(system).toContain("better than taking something back");
  });

  it("forbids retraction outright, and forbids explaining ambiguity as its own error", () => {
    expect(system).toContain("Never retract, contradict or apologise for something established");
    expect(system).toContain("unless they plainly say it was wrong");
    expect(system).toContain("Never explain an ambiguous message");
    expect(system).toContain("by deciding you must have been mistaken");
  });

  it("no longer claims a capability CareLoop actually has", () => {
    // The false sentence is gone...
    expect(system).not.toContain("You cannot contact anyone, send messages");
    // ...replaced by what is true: never on its own, but it does relay.
    expect(system).toContain("You never contact anyone on your own initiative");
    expect(system).toContain("that message IS passed to the family member");
    expect(system).toContain("their reply");
    expect(system).toContain("IS passed back to you");
    expect(system).toContain("Never tell them you cannot send or receive");
  });

  it("still refuses to act on its own initiative", () => {
    // Correcting the disclaimer must not turn into permission.
    expect(system).toContain("never offer to");
    expect(system).toContain("when they have read an exact message and said");
    expect(system).toContain("yes to it");
  });

  it("v1 has neither the rule nor the correction", async () => {
    const { conversationPromptV1 } = await import("@/server/prompts/conversation.v1");
    expect(conversationPromptV1.system).not.toContain("What is already established");
    expect(conversationPromptV1.system).toContain("You cannot contact anyone, send messages");
    expect(conversationPromptV1.ref).toBe("conversation.v1");
  });

  it("the rule reaches the turn where the closure is NO LONGER structured context", () => {
    // The turn after the update: `pendingClosure` is null, the transcript
    // carries the sentence, and the rule that protects it must still be there.
    const context = assembleContext({
      recentTurns: [
        turn("assistant", "John replied that they are planning to visit this weekend.", 1),
        turn("user", "no not yet", 2),
      ],
      memory: { ...EMPTY_MEMORY, pendingClosure: null },
    });
    const blob = context.messages.map((m) => m.content).join("\n");

    expect(blob).toContain("What is already established");
    expect(blob).toContain("is NOT a correction");
    // The evidence the rule protects is present in the transcript.
    expect(blob).toContain("John replied that they are planning to visit this weekend.");
    // And the false disclaimer is nowhere in the turn.
    expect(blob).not.toContain("You cannot contact anyone, send messages");
  });

  it("carries no fixture name", () => {
    for (const name of ["George", "John", "Johnny", "Simba"]) {
      expect(system, name).not.toContain(name);
    }
  });
});

/**
 * A reply that has arrived is not a reply still coming (M8 regression 2).
 *
 * Live acceptance showed the verified update - "John replied that they are
 * planning to visit this weekend." - followed, in the same turn, by "I'll let
 * you know when John replies." Both sentences reached the person at once, and
 * one of them was false. The marker already said a reply had arrived; what it
 * did not say was that the waiting was therefore OVER, and a model that has
 * spent the whole conversation promising to pass on an answer will keep
 * promising it unless something says stop.
 */
describe("a reply that has arrived ends the waiting", () => {
  const closureContext = () =>
    assembleContext({
      recentTurns: [
        {
          id: "m1",
          role: "user",
          content: "thank you",
          createdAt: new Date().toISOString(),
        },
      ],
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

  const blobOf = (context: ReturnType<typeof assembleContext>) =>
    context.messages.map((message) => message.content).join("\n");

  it("says in so many words that nothing is still outstanding", () => {
    const blob = blobOf(closureContext());
    expect(blob).toContain("has already answered");
    expect(blob).toContain("nothing is still outstanding");
  });

  it("names the three sentences that are now false", () => {
    const blob = blobOf(closureContext()).toLowerCase();
    for (const forbidden of [
      "let them know when",
      "still waiting",
      "have not heard",
    ]) {
      expect(blob, forbidden).toContain(forbidden);
    }
  });

  it("does not ban ordinary warmth in the same breath", () => {
    // The rule is about the promise, not about being kind. A closure turn may
    // still say "you're very welcome" or wish the visit well.
    const blob = blobOf(closureContext());
    expect(blob).toContain("respond warmly");
  });

  it("the standing rule is in the prompt, not only in the marker", () => {
    // The marker is present for exactly one turn. The rule has to survive the
    // turns after it, when the news is only in the transcript.
    const system = conversationPromptV4.system;
    expect(system).toContain("the waiting is over");
    expect(system.toLowerCase()).toContain("still waiting");
    for (const name of ["George", "John", "Simba"]) {
      expect(system, name).not.toContain(name);
    }
  });
});

/**
 * A recorded label is not a possessive (M8 regression 3).
 *
 * The card no longer glosses one, and the prompt has to say why, because the
 * model is the thing that turned `family_pet` into "your dog". Neutral
 * entities throughout: a rule that only works on the demo fixture is not a
 * rule.
 */
describe("relationships reach the model with their direction intact", () => {
  const petCard = () =>
    renderEntityCard({
      name: "Pepper",
      type: "pet",
      subtype: "dog",
      aliases: [],
      relationToUser: { kind: "family_pet", status: "confirmed" },
      relatedEntities: [{ name: "Rowan", kind: "pet", status: "confirmed" }],
    });

  /** The memory message only: the base prompt NAMES the forbidden phrasings. */
  const memoryBlock = () =>
    assembleContext({
      recentTurns: [
        {
          id: "m1",
          role: "user",
          content: "Do you remember Pepper?",
          createdAt: new Date().toISOString(),
        },
      ],
      memory: { ...EMPTY_MEMORY, entityCards: [petCard()] },
    })
      .messages.filter((message) => message.content !== conversationPromptV4.system)
      .map((message) => message.content)
      .join("\n");

  it("both edges survive assembly, each with its source named", () => {
    const assembled = memoryBlock();
    expect(assembled).toContain("their recorded relationship to Pepper: family_pet");
    expect(assembled).toContain("Rowan's recorded relationship to Pepper: pet");
    // Nothing the model is told about Pepper reads as the user owning Pepper.
    expect(assembled).not.toMatch(/their (family_)?pet\b/i);
    expect(assembled).not.toMatch(/your dog\b/i);
  });

  it("the prompt forbids turning a label into ownership", () => {
    const system = conversationPromptV4.system;
    expect(system).toContain("family_pet");
    expect(system.toLowerCase()).toContain("is not a possessive");
    expect(system).toContain("does NOT make the animal theirs");
  });

  it("the prompt still permits a relationship the notes do record", () => {
    // The rule narrows what may be claimed, not what may be said. "your son"
    // stays available when an edge records it.
    const system = conversationPromptV4.system;
    expect(system).toContain("recorded relationship");
    expect(system).toContain("'your daughter' is fine");
  });

  it("the rule carries no fixture name", () => {
    for (const name of ["George", "John", "Simba", "Pepper", "Rowan"]) {
      expect(conversationPromptV4.system, name).not.toContain(name);
    }
  });
});

/**
 * "Who is Simba?" -> "a dog who is recorded as part of the family."
 *
 * Grounded, and thinner than the truth. The card carried both edges - the
 * user's `family_pet` and the son's `pet` - and the answer used only the
 * broader one. A companion that knows whose dog it is and does not say so is
 * remembering badly, which is the thing this product claims to be good at.
 *
 * The data never needed changing. What was missing was a rule saying that a
 * broad association does not stand in for a specific relationship, and that an
 * identity question wants the specific one.
 */
describe("an identity question wants the most specific relationship", () => {
  const system = conversationPromptV4.system;

  it("names the questions the rule applies to", () => {
    expect(system).toContain("Who is");
    expect(system).toContain("Do you remember");
    expect(system).toContain("How do I know");
  });

  it("says a broader association does not replace a specific one", () => {
    expect(system).toContain("MOST SPECIFIC");
    expect(system).toContain("never replaces a more specific one");
    expect(system).toContain("give both");
  });

  it("bounds where an ownership claim may come from", () => {
    // The permission is narrow on purpose: a confirmed edge from a named
    // person, plus a type that supports the noun. Nothing else licenses it.
    expect(system).toContain("recorded relationship to that animal is 'pet'");
    expect(system).toContain("type or subtype");
    expect(system).toContain("no recorded relationship names an owner");
  });

  it("the card gives the model everything that answer needs", () => {
    // Neutral entities. Both edges, both directed, both attributed.
    const card = renderEntityCard({
      name: "Pepper",
      type: "pet",
      subtype: "dog",
      aliases: [],
      relationToUser: { kind: "family_pet", status: "confirmed" },
      relatedEntities: [{ name: "Rowan", kind: "pet", status: "confirmed" }],
    });
    const assembled = assembleContext({
      recentTurns: [
        { id: "m1", role: "user", content: "Who is Pepper?", createdAt: new Date().toISOString() },
      ],
      memory: { ...EMPTY_MEMORY, entityCards: [card] },
    })
      .messages.filter((message) => message.content !== system)
      .map((message) => message.content)
      .join("\n");

    // Enough for "Pepper is Rowan's dog and a family pet", and nothing more.
    expect(assembled).toContain("pet (dog)");
    expect(assembled).toContain("Rowan's recorded relationship to Pepper: pet");
    expect(assembled).toContain("their recorded relationship to Pepper: family_pet");
    expect(assembled).not.toMatch(/your dog\b/i);
  });

  it("the specific edge survives however many broader ones there are", () => {
    // The `pet` edge must not be crowded out by household-level associations.
    const card = renderEntityCard({
      name: "Pepper",
      type: "pet",
      subtype: "dog",
      aliases: [],
      relationToUser: { kind: "family_pet", status: "confirmed" },
      relatedEntities: [
        { name: "Ash", kind: "family_pet", status: "confirmed" },
        { name: "Rowan", kind: "pet", status: "confirmed" },
      ],
    });
    expect(card).toContain("Rowan's recorded relationship to Pepper: pet");
    expect(card).toContain("Ash's recorded relationship to Pepper: family_pet");
    expect(card).toContain("their recorded relationship to Pepper: family_pet");
  });

  it("an unconfirmed owner edge is still marked as unconfirmed", () => {
    // The ownership permission is spent on CONFIRMED edges. A candidate one
    // reaches the model carrying its caveat, so the rule can bite.
    const card = renderEntityCard({
      name: "Pepper",
      type: "pet",
      subtype: "dog",
      aliases: [],
      relationToUser: null,
      relatedEntities: [{ name: "Rowan", kind: "pet", status: "candidate" }],
    });
    expect(card).toContain("Rowan's recorded relationship to Pepper: pet (not yet confirmed)");
  });

  it("the rule carries no fixture name", () => {
    for (const name of ["George", "John", "Simba", "Pepper", "Rowan", "Ash"]) {
      expect(system, name).not.toContain(name);
    }
  });
});
