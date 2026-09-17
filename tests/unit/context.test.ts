import { describe, expect, it } from "vitest";
import { renderEntityCard } from "@/core/memory/present";
import { conversationPromptV2 } from "@/server/prompts/conversation.v2";
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

    expect(context.promptRef).toBe("conversation.v2");
    expect(context.messages[0]).toEqual({
      role: "system",
      content: conversationPromptV2.system,
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
      .filter((m) => m.content !== conversationPromptV2.system)
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
    expect(context.messages[0].content).toBe(conversationPromptV2.system);
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
    const system = conversationPromptV2.system;
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
    const system = conversationPromptV2.system;
    expect(system).toContain("You do not have to name someone every time");
    expect(system).toContain("'him', 'her', 'they' are");
    expect(system).toContain("a relationship the notes actually record");
    expect(system).toContain("WHENEVER you use a proper name");
  });

  it("the rule is scoped to recorded aliases, and to their use first", () => {
    const system = conversationPromptV2.system;
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
    expect(conversationPromptV2.ref).toBe("conversation.v2");
  });

  it("the prompt carries no example name from the demo fixture", () => {
    // The rule is generic. Coupling the prompt to the demo cast would be the
    // fixture leaking into shipped behaviour.
    for (const name of ["George", "John", "Johnny", "Simba"]) {
      expect(conversationPromptV2.system, name).not.toContain(name);
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
  const system = conversationPromptV2.system;

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
  const system = conversationPromptV2.system;

  it("states that what was already said is a record, not a guess", () => {
    expect(system).toContain("What is already established");
    expect(system).toContain("is a record");
    expect(system).toContain("not up for");
    expect(system).toContain("revision because their next message is hard to read");
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
