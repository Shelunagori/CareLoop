import { beforeEach, describe, expect, it } from "vitest";
import { fixedClock } from "@/server/adapters/clock";
import { handleConsentReply, prepareOffer } from "@/server/services/consent";
import { readConsent } from "@/core/consent/decision";
import { buildOfferBlock } from "@/core/share/offer";
import { sha256Hex } from "@/core/share/text-hash";
import { createStore, resetIds, type StoredOpportunity } from "./detection-fakes";
import { m5Deps, resetM5Ids, withM5, type M5Store } from "./consent-fakes";

/**
 * ONLY AN OFFER SOMEBODY WAS SHOWN CAN BE ANSWERED (M12g).
 *
 * Reported from a live browser. The person typed:
 *
 *     "Yeah, it was good. Tell me about something about weather."
 *
 * and CareLoop answered "Thank you — I'll send that to them now." — an
 * approval, of a card they had never seen, for an entity whose name the
 * product refuses to print. It then went on to send it.
 *
 * TWO FAILURES COMPOUNDED, and each is worth its own rule.
 *
 * The parser read "Yeah, …" as a yes. `affirmative_opener` is anchored at
 * the start and said nothing about the forty characters after it, so a
 * sentence that opens agreeably and then changes the subject approved an
 * irreversible family action — the same shape as the "yes but later" bug
 * M9 fixed, in a new disguise.
 *
 * And `handleConsentReply` acted on an opportunity that `prepareOffer` had
 * REFUSED to present. M12e.3 put provenance on the presentation path and
 * not on the answering path, so an invisible card stayed answerable. The
 * general rule is stronger than provenance: a person cannot be answering
 * something they were never shown.
 */
const NOW = new Date("2026-09-21T12:00:00.000Z");
const HOUR = 3_600_000;
const USER = "user-1";
const SUBJECT = "entity-subject";
const TEXT = "Dad was wondering — are you able to visit soon?";

function storeWith(
  origin: "user" | "demo" | "dev",
  overrides: Partial<StoredOpportunity> = {},
): M5Store {
  const store = withM5(
    createStore({
      entities: [
        {
          id: SUBJECT, type: "person", subtype: null, displayName: "TestPersonA",
          aliases: [], status: "active", origin, lastMentionedAt: null,
        },
      ],
    }),
  );
  store.opportunities.push({
    id: "opp-1",
    userId: USER,
    signalId: "sig-1",
    entityId: SUBJECT,
    proposal: {
      entityId: SUBJECT, entityName: "TestPersonA", eventType: "visit" as const,
      observation: {
        kind: "user_stated_absence" as const,
        window: { start: "2026-09-14T00:00:00.000Z", end: NOW.toISOString() },
        statedAt: NOW.toISOString(),
      },
      question: "ask_if_visiting" as const,
    },
    sharePayload: {
      fromDisplayName: "Dad", topic: "visit" as const, question: "ask_if_visiting" as const,
    },
    renderedText: TEXT,
    renderedTextHash: sha256Hex(TEXT),
    status: "offered",
    offeredAt: NOW.toISOString(),
    resolvedAt: null,
    expiresAt: new Date(NOW.getTime() + 24 * HOUR).toISOString(),
    createdAt: NOW.toISOString(),
    ...overrides,
  });
  return store;
}

/** A transcript in which the card really was drawn. */
const SHOWN = [
  { role: "user", content: "I haven't seen TestPersonA recently.", createdAt: NOW.toISOString() },
  {
    role: "assistant",
    content: buildOfferBlock({ entityName: "TestPersonA", renderedText: TEXT }),
    createdAt: NOW.toISOString(),
  },
];

/** A transcript in which it was not. */
const NOT_SHOWN = [
  { role: "user", content: "How are you doing today?", createdAt: NOW.toISOString() },
  { role: "assistant", content: "I'm glad we get to chat today.", createdAt: NOW.toISOString() },
];

const answer = (
  store: M5Store,
  text: string,
  recentMessages: { role: string; content: string; createdAt: string }[] = SHOWN,
) =>
  handleConsentReply(m5Deps({ store, clock: fixedClock(NOW) }).consent, {
    userId: USER,
    text,
    grantingMessageId: "msg-1",
    recentMessages,
  });

beforeEach(() => {
  resetIds();
  resetM5Ids();
});

describe("1. the reported sentence, verbatim", () => {
  const REPORTED = "Yeah, it was good. Tell me about something about weather.";

  it("is not a yes", () => {
    expect(readConsent(REPORTED).decision).not.toBe("approve");
  });

  it("is not an answer at all, so the conversation carries on", async () => {
    // `not_an_answer` is what lets the turn fall through to ordinary chat.
    // `unclear` would ask "yes or no?" at somebody who asked about the
    // weather, which is its own kind of wrong.
    const outcome = await answer(storeWith("user"), REPORTED);
    expect(outcome.outcome).toBe("not_an_answer");
  });

  it("sends nothing and resolves nothing", async () => {
    const store = storeWith("user");
    await answer(store, REPORTED);
    expect(store.grants).toHaveLength(0);
    expect(store.requests).toHaveLength(0);
    expect(store.delivered).toHaveLength(0);
    expect(store.opportunities[0].status).toBe("offered");
  });
});

describe("2. an opener is a yes only when the message is one", () => {
  it.each([
    "yes", "Yes please", "yeah, go ahead", "okay send it", "sure, that's fine",
    "yes please send it to them",
  ])("%j approves", (text) => {
    expect(readConsent(text).decision).toBe("approve");
  });

  it.each([
    "Yeah, it was good. Tell me about something about weather.",
    "Yes I was thinking about the garden and whether the roses need cutting back",
    "okay so anyway what were we talking about before all of this started",
    "sure but tell me what the weather is going to do tomorrow afternoon",
  ])("%j does not", (text) => {
    expect(readConsent(text).decision).not.toBe("approve");
  });

  it("a long message that really does approve still approves", () => {
    // The bounded rule is on the OPENER alone. The explicit phrases are
    // unanchored and unbounded, so somebody being wordy about agreeing is
    // not punished for it.
    expect(
      readConsent("That's very kind of you, yes, please send it to them when you can"),
    ).toEqual({ decision: "approve", matchedRule: "send_it" });
    expect(readConsent("I have been thinking it over all morning and yes please")).toEqual({
      decision: "approve",
      matchedRule: "yes_please",
    });
    expect(readConsent("I have thought about it and I would like you to send it")).toEqual({
      decision: "approve",
      matchedRule: "send_it",
    });
  });

  it("refusal still wins over length", () => {
    expect(readConsent("no, don't send it, I'd rather tell them myself").decision).toBe("decline");
  });
});

describe("3. an offer nobody saw cannot be answered", () => {
  it("a plain yes does nothing when the card was never drawn", async () => {
    const store = storeWith("user");
    const outcome = await answer(store, "yes please", NOT_SHOWN);

    expect(outcome.outcome).toBe("no_offer");
    expect(store.grants).toHaveLength(0);
    expect(store.opportunities[0].status).toBe("offered");
  });

  it("and the same yes works when it was", async () => {
    const store = storeWith("user");
    const outcome = await answer(store, "yes please", SHOWN);
    expect(outcome.outcome).toBe("approved");
    expect(store.grants).toHaveLength(1);
  });

  it("a decline needs to have been shown one too", async () => {
    const store = storeWith("user");
    expect((await answer(store, "no thanks", NOT_SHOWN)).outcome).toBe("no_offer");
    expect(store.opportunities[0].status).toBe("offered");
  });
});

describe("4. a card the product refuses to print cannot be answered either", () => {
  it("a dev-provenance offer is not answerable, even with the bytes on screen", async () => {
    // `prepareOffer` refuses to present it (M12e.3). The answering path
    // has to refuse too, or the rule only covers the half of the loop
    // somebody can see.
    const store = storeWith("dev");
    const outcome = await answer(store, "yes please", SHOWN);

    expect(outcome.outcome).toBe("no_offer");
    expect(store.grants).toHaveLength(0);
    expect(store.delivered).toHaveLength(0);
  });

  it("the two halves of the loop agree", async () => {
    const store = storeWith("dev", { status: "drafted", offeredAt: null });
    const shown = await prepareOffer(m5Deps({ store, clock: fixedClock(NOW) }).consent, {
      userId: USER,
      conversationId: "conv-1",
      recentMessages: SHOWN,
    });
    expect(shown.outcome).toBe("none");
    expect((await answer(store, "yes please", SHOWN)).outcome).toBe("no_offer");
  });

  it("a demo entity is answerable — the seeded demo IS the product", async () => {
    const store = storeWith("demo");
    expect((await answer(store, "yes please", SHOWN)).outcome).toBe("approved");
  });
});
