import { beforeEach, describe, expect, it } from "vitest";
import { fixedClock } from "@/server/adapters/clock";
import { prepareOffer } from "@/server/services/consent";
import { detectionConfig } from "@/core/detection/config";
import { sha256Hex } from "@/core/share/text-hash";
import type { ReconnectProposal } from "@/core/detection/proposal";
import { createStore, resetIds, type StoredOpportunity } from "./detection-fakes";
import { conversationUnderway, m5Deps, resetM5Ids, withM5, type M5Store } from "./consent-fakes";

/**
 * When a cadence-only offer is allowed to interrupt.
 *
 * Observed in production:
 *
 *   person:  "hello"
 *   CareLoop: (ordinary reply)
 *   person:  "good and u"
 *   CareLoop: "...I can send John this message..."
 *
 * Nothing about the detection was wrong. What was wrong is that the
 * application chose the second thing the person had ever said to raise a
 * family matter. This gate is the smallest deterministic rule that prevents
 * it, and it is pacing, not suppression: the opportunity stays `drafted` and
 * is offered on the next qualifying turn inside its existing 24h window.
 *
 * Explicit absence is exempt on purpose. "I haven't seen John this week" is
 * the person opening the subject, and making them wait two more turns to be
 * answered would be the system ignoring the clearest evidence it gets.
 */
const NOW = new Date("2026-09-16T12:00:00.000Z");
const HOUR = 3_600_000;
const USER = "user-1";
const CONV = "conv-1";
const JOHN = "entity-john";
const TEXT = "Hi John — are you and Simba visiting this weekend?";

const GATE = detectionConfig.minUserTurnsBeforeCadenceOffer;

/** The greeting exchange observed in the browser, verbatim. */
const SMALLTALK = ["hello", "good and u", "how are you doing?", "I am doing good what about you?"];

function smalltalk(userLines: readonly string[]) {
  let at = NOW.getTime() - userLines.length * 120_000;
  return userLines.flatMap((content) => {
    at += 60_000;
    const user = { role: "user", content, createdAt: new Date(at).toISOString() };
    at += 60_000;
    const reply = { role: "assistant", content: "Mm.", createdAt: new Date(at).toISOString() };
    return [user, reply];
  });
}

const cadenceProposal: ReconnectProposal = {
  entityId: JOHN,
  entityName: "John",
  eventType: "visit",
  observation: { kind: "no_mention_since", days: 13 },
  pattern: { medianGapDays: 7 },
  question: "ask_if_visiting",
};

const absenceProposal: ReconnectProposal = {
  entityId: JOHN,
  entityName: "John",
  eventType: "visit",
  observation: {
    kind: "user_stated_absence",
    statedPhrase: "I haven't seen John this week",
    window: { start: "2026-09-09", end: "2026-09-16" },
  },
  question: "ask_if_visiting",
};

function storeWith(overrides: Partial<StoredOpportunity> = {}): M5Store {
  const store = withM5(
    createStore({
      entities: [
        {
          id: JOHN, type: "person", subtype: null, displayName: "John",
          aliases: [], status: "active", origin: "user" as const, lastMentionedAt: null,
        },
      ],
    }),
  );
  store.opportunities.push({
    id: "opp-1",
    userId: USER,
    signalId: "sig-1",
    entityId: JOHN,
    proposal: cadenceProposal,
    sharePayload: {
      fromDisplayName: "Dad",
      aboutEntityName: "Simba",
      topic: "visit",
      question: "ask_if_visiting",
    },
    renderedText: TEXT,
    renderedTextHash: sha256Hex(TEXT),
    status: "drafted",
    offeredAt: null,
    resolvedAt: null,
    expiresAt: new Date(NOW.getTime() + 24 * HOUR).toISOString(),
    createdAt: NOW.toISOString(),
    ...overrides,
  });
  return store;
}

const offerWith = (store: M5Store, recentMessages: ReturnType<typeof smalltalk>) =>
  prepareOffer(m5Deps({ store, clock: fixedClock(NOW) }).consent, {
    userId: USER,
    conversationId: CONV,
    recentMessages,
  });

beforeEach(() => {
  resetIds();
  resetM5Ids();
});

describe("1. the gate is one number, next to the other pacing numbers", () => {
  it("lives in detectionConfig, where a non-engineer can read it", () => {
    expect(GATE).toBe(3);
  });
});

describe("2. a cadence-only offer waits for the conversation to get going", () => {
  it.each([1, 2, 3, 4])("stays quiet through %i turns of pleasantries", async (turns) => {
    const store = storeWith();
    const result = await offerWith(store, smalltalk(SMALLTALK.slice(0, turns)));
    expect(result.outcome).toBe("none");
  });

  it("surfaces once the person is actually talking about their day", async () => {
    const store = storeWith();
    const result = await offerWith(store, conversationUnderway(NOW));
    expect(result.outcome).toBe("offered");
  });

  it("does not surface in a fresh sitting of a long-running conversation", async () => {
    // The browser report: a conversation row used all day, reopened, and
    // the second thing said in the new sitting brought up a family matter.
    const yesterday = conversationUnderway(new Date(NOW.getTime() - 26 * 3_600_000));
    const today = smalltalk(SMALLTALK.slice(0, 2));
    const store = storeWith();
    const result = await offerWith(store, [...yesterday, ...today]);
    expect(result.outcome).toBe("none");
  });
});

describe("3. withheld is not spent, and not suppressed", () => {
  /**
   * The bug this guards against is the offer being marked `offered` by a
   * turn that never showed it — which would burn the opportunity, start the
   * 7-day offer cooldown, and leave the person having declined nothing.
   */
  it("the opportunity is untouched while the gate holds", async () => {
    const store = storeWith();
    await offerWith(store, smalltalk(SMALLTALK.slice(0, 2)));
    expect(store.opportunities[0].status).toBe("drafted");
    expect(store.opportunities[0].offeredAt).toBeNull();
  });

  it("the same opportunity is offered on a later, better turn", async () => {
    const store = storeWith();
    expect((await offerWith(store, smalltalk(SMALLTALK.slice(0, 2)))).outcome).toBe("none");

    const later = await offerWith(store, conversationUnderway(NOW));
    expect(later.outcome).toBe("offered");
    if (later.outcome !== "offered") return;
    expect(later.opportunityId).toBe("opp-1");
    // The same bytes, unchanged by having waited.
    expect(later.renderedText).toBe(TEXT);
  });
});

describe("4. an explicit absence is never paced", () => {
  it("is offered on the very first turn", async () => {
    const store = storeWith({ proposal: absenceProposal });
    const result = await offerWith(store, smalltalk(SMALLTALK.slice(0, 1)));
    expect(result.outcome).toBe("offered");
  });

  it("carries no preamble, because the person supplied the context", async () => {
    const store = storeWith({ proposal: absenceProposal });
    const result = await offerWith(store, smalltalk(SMALLTALK.slice(0, 1)));
    if (result.outcome !== "offered") throw new Error("expected an offer");
    expect(result.preamble).toBeNull();
  });
});

describe("5. the offer says why it appeared", () => {
  it("attaches the deterministic sentence to a cadence offer", async () => {
    const store = storeWith();
    const result = await offerWith(store, conversationUnderway(NOW));
    if (result.outcome !== "offered") throw new Error("expected an offer");
    expect(result.preamble).toBe(
      "You usually see John about once a week, and it's been 13 days.",
    );
  });

  it("keeps the preamble out of the block, so the card still strips cleanly", async () => {
    const store = storeWith();
    const result = await offerWith(store, conversationUnderway(NOW));
    if (result.outcome !== "offered") throw new Error("expected an offer");
    expect(result.block).toBe(
      `I can send John this message:\n\n${TEXT}\n\nWould you like me to send it?`,
    );
    expect(result.block).not.toContain("usually");
  });
});

describe("6. a proposal that cannot be read makes no claim and paces nothing", () => {
  /**
   * Fail-closed on the REASON, fail-open on the PACING. A row this deploy
   * cannot parse holds no cadence claim, so no sentence is invented for it;
   * and pacing is a property of a cadence claim, so a row without one is
   * offered exactly as it was before this rule existed. Timing is a comfort
   * decision; asserting an unevidenced fact is not.
   */
  it("offers immediately and says nothing about a rhythm", async () => {
    const store = storeWith({ proposal: { entityId: JOHN, entityName: "John" } });
    const result = await offerWith(store, smalltalk(SMALLTALK.slice(0, 1)));
    expect(result.outcome).toBe("offered");
    if (result.outcome !== "offered") return;
    expect(result.preamble).toBeNull();
  });

  it("does the same for a null proposal", async () => {
    const store = storeWith({ proposal: null });
    const result = await offerWith(store, smalltalk(SMALLTALK.slice(0, 1)));
    expect(result.outcome).toBe("offered");
  });
});

describe("7. the gate reads the transcript it was given, and nothing else", () => {
  /**
   * The previous version asked the database for a lifetime count of the
   * conversation's user messages. That answered the wrong question: a
   * conversation row outlives a conversation, so the count was satisfied
   * permanently after somebody's first visit. It reads timestamps now, and
   * those arrive with the turn — no extra query, and the rule means what
   * its name says.
   */
  it("a transcript of assistant turns alone does not open the gate", async () => {
    const store = storeWith();
    const result = await prepareOffer(m5Deps({ store, clock: fixedClock(NOW) }).consent, {
      userId: USER,
      conversationId: CONV,
      recentMessages: Array.from({ length: 20 }, (_, i) => ({
        role: "assistant",
        content: `a fairly long assistant turn number ${i}, going on a bit`,
        createdAt: new Date(NOW.getTime() - (20 - i) * 60_000).toISOString(),
      })),
    });
    expect(result.outcome).toBe("none");
  });

  it("asks the database nothing extra to decide it", async () => {
    // The consent deps no longer carry a messages repository at all, which
    // is the strongest available statement that no query happens here.
    const deps = m5Deps({ store: storeWith(), clock: fixedClock(NOW) }).consent;
    expect("messages" in deps).toBe(false);
  });
});
