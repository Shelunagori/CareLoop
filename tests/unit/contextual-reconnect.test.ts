import { beforeEach, describe, expect, it } from "vitest";
import { fixedClock } from "@/server/adapters/clock";
import { prepareOffer } from "@/server/services/consent";
import { currentSitting, mayPresentOpportunity } from "@/core/detection/presentation";
import { absenceIsSuperseded, detectAssertedAbsence } from "@/core/detection/absence";
import { buildOfferBlock, needsRepresenting } from "@/core/share/offer";
import { sha256Hex } from "@/core/share/text-hash";
import { createStore, resetIds, type StoredOpportunity } from "./detection-fakes";
import { m5Deps, resetM5Ids, withM5, type M5Store } from "./consent-fakes";

/**
 * DETECTED IS NOT PRESENT NOW (M12e).
 *
 * Observed in a real browser: after "How are you doing?" / "It was good,
 * what about you?", CareLoop produced a reconnect card — and produced
 * effectively the same card again later in the same conversation. Both are
 * in here as literal transcripts, because a rule written against a
 * paraphrase of a bug is a rule written against the wrong bug.
 */
const NOW = new Date("2026-09-21T12:00:00.000Z");
const MINUTE = 60_000;
const HOUR = 3_600_000;
const USER = "user-1";
const DON = "entity-don";
const TEXT = "Dad was wondering — are you able to visit soon?";
const HASH = sha256Hex(TEXT);

const at = (minutesAgo: number) => new Date(NOW.getTime() - minutesAgo * MINUTE).toISOString();

const ABSENCE_PROPOSAL = {
  entityId: DON,
  entityName: "Don",
  eventType: "visit" as const,
  observation: {
    kind: "user_stated_absence" as const,
    statedPhrase: "I haven't seen Don recently",
    window: { start: "2026-09-13T00:00:00.000Z", end: "2026-09-20T00:00:00.000Z" },
  },
  question: "ask_if_visiting" as const,
};

const CADENCE_PROPOSAL = {
  entityId: DON,
  entityName: "Don",
  eventType: "visit" as const,
  observation: { kind: "no_mention_since" as const, days: 13 },
  pattern: { medianGapDays: 7 },
  question: "ask_if_visiting" as const,
};

function storeWith(overrides: Partial<StoredOpportunity> = {}): M5Store {
  const store = withM5(
    createStore({
      entities: [
        {
          id: DON, type: "person", subtype: null, displayName: "Don",
          aliases: [], status: "active", origin: "user" as const, lastMentionedAt: null,
        },
      ],
    }),
  );
  store.opportunities.push({
    id: "opp-1",
    userId: USER,
    signalId: "sig-1",
    entityId: DON,
    proposal: { ...ABSENCE_PROPOSAL },
    sharePayload: {
      fromDisplayName: "Dad",
      topic: "visit" as const,
      question: "ask_if_visiting" as const,
    },
    renderedText: TEXT,
    renderedTextHash: HASH,
    status: "drafted",
    offeredAt: null,
    resolvedAt: null,
    expiresAt: new Date(NOW.getTime() + 24 * HOUR).toISOString(),
    createdAt: NOW.toISOString(),
    ...overrides,
  });
  return store;
}

const offer = (store: M5Store, recentMessages: { role: string; content: string; createdAt: string }[]) =>
  prepareOffer(m5Deps({ store, clock: fixedClock(NOW) }).consent, {
    userId: USER,
    conversationId: "conv-1",
    recentMessages,
  });

/** The observed transcript, verbatim, in one sitting starting 6 minutes ago. */
const SMALLTALK = [
  { role: "assistant", content: "Good morning.", createdAt: at(6) },
  { role: "user", content: "How are you doing?", createdAt: at(5) },
  { role: "assistant", content: "I'm well, thank you. How has your morning been?", createdAt: at(4) },
  { role: "user", content: "It was good, what about you?", createdAt: at(0) },
];

describe("1. generic smalltalk cannot surface a reconnect card", () => {
  it("withholds an absence opportunity raised in an EARLIER sitting", async () => {
    // Yesterday's "I haven't seen Don recently" is still inside the
    // absence detector's 14-day window and inside the opportunity's own
    // 24-hour window. Neither of those is a reason to raise it against
    // "It was good, what about you?".
    const store = storeWith({ createdAt: new Date(NOW.getTime() - 20 * HOUR).toISOString() });
    const result = await offer(store, SMALLTALK);
    expect(result.outcome).toBe("none");
  });

  it("withholds a cadence opportunity against pleasantries", async () => {
    const store = storeWith({ proposal: { ...CADENCE_PROPOSAL } });
    const result = await offer(store, SMALLTALK);
    expect(result.outcome).toBe("none");
  });

  it.each([
    "It was good, what about you?",
    "How are you doing?",
    "Good morning.",
    "I'm alright thanks.",
  ])("withholds against the pleasantry %j", async (content) => {
    const store = storeWith({ createdAt: new Date(NOW.getTime() - 20 * HOUR).toISOString() });
    const result = await offer(store, [{ role: "user", content, createdAt: at(0) }]);
    expect(result.outcome).toBe("none");
  });

  it("withholds even when an unrelated wellbeing statement is made", async () => {
    const store = storeWith({ createdAt: new Date(NOW.getTime() - 20 * HOUR).toISOString() });
    const result = await offer(store, [
      { role: "user", content: "I was not feeling good today.", createdAt: at(0) },
    ]);
    expect(result.outcome).toBe("none");
  });
});

describe("2. a withheld opportunity WAITS — it is not consumed", () => {
  it("spends no state at all: still drafted, never offered, no second row", async () => {
    const store = storeWith({ createdAt: new Date(NOW.getTime() - 20 * HOUR).toISOString() });
    await offer(store, SMALLTALK);

    expect(store.opportunities).toHaveLength(1);
    const row = store.opportunities[0];
    expect(row.status).toBe("drafted");
    expect(row.offeredAt).toBeNull();
    expect(row.resolvedAt).toBeNull();
    // The bytes are untouched, so whatever is eventually approved is still
    // the string that was drafted.
    expect(row.renderedText).toBe(TEXT);
    expect(store.grants).toHaveLength(0);
  });

  it("is still there, unspent, on the next turn of the sitting that raised it", async () => {
    // Raised in THIS sitting, but withheld on the turn it landed because
    // the entity label was unpresentable at that moment. The opportunity
    // waits; nothing about it was consumed.
    const store = storeWith({ createdAt: at(4) });
    store.entities[0].origin = "dev";
    expect((await offer(store, SMALLTALK)).outcome).toBe("none");
    expect(store.opportunities[0].status).toBe("drafted");

    store.entities[0].origin = "user";
    const result = await offer(store, SMALLTALK);
    expect(result.outcome).toBe("offered");
    if (result.outcome !== "offered") return;
    expect(result.opportunityId).toBe("opp-1");
    expect(result.renderedText).toBe(TEXT);
  });
});

describe("3. the same card is not resurfaced, unchanged, in the same sitting", () => {
  it("does not re-present after the draft scrolls out of the bounded window", () => {
    // The real mechanism: `needsRepresenting` asks whether the recent
    // transcript contains the bytes, and the recent transcript is the last
    // 20 messages. Ten exchanges later the presenting message is gone and
    // every turn concluded the earlier one had died.
    const offeredAt = at(20);
    const scrolled = Array.from({ length: 20 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `ordinary turn ${i}`,
      createdAt: at(19 - i),
    }));
    const sitting = currentSitting(scrolled);

    expect(
      needsRepresenting(scrolled, {
        renderedText: TEXT,
        offeredAt,
        sittingStartedAtMs: sitting.startedAtMs,
      }),
    ).toBe(false);
  });

  it("STILL re-presents a genuinely dead stream inside the same sitting", () => {
    const offeredAt = at(3);
    const messages = [
      { role: "user", content: "I haven't seen Don recently.", createdAt: at(4) },
      { role: "assistant", content: "Sorry — something went wrong.", createdAt: at(2) },
    ];
    const sitting = currentSitting(messages);
    expect(
      needsRepresenting(messages, {
        renderedText: TEXT,
        offeredAt,
        sittingStartedAtMs: sitting.startedAtMs,
      }),
    ).toBe(true);
  });

  it("refuses a second presentation in the sitting even when the person names them again", () => {
    const verdict = mayPresentOpportunity(
      [
        { role: "user", content: "I haven't seen Don recently.", createdAt: at(10) },
        { role: "assistant", content: buildOfferBlock({ entityName: "Don", renderedText: TEXT }), createdAt: at(9) },
        { role: "user", content: "Don is always busy.", createdAt: at(0) },
      ],
      {
        kind: "user_stated_absence",
        entityName: "Don",
        raisedAtIso: at(10),
        offeredAtIso: at(9),
      },
    );
    expect(verdict.present).toBe(false);
    expect(verdict.reason).toBe("already_presented_in_this_sitting");
  });

  it("an already-offered card is not shown again by prepareOffer in its own sitting", async () => {
    const store = storeWith({ status: "offered", offeredAt: at(9), createdAt: at(10) });
    const result = await offer(store, [
      { role: "user", content: "I haven't seen Don recently.", createdAt: at(10) },
      { role: "assistant", content: buildOfferBlock({ entityName: "Don", renderedText: TEXT }), createdAt: at(9) },
      { role: "user", content: "Don is always busy.", createdAt: at(0) },
    ]);
    expect(result.outcome).toBe("none");
  });
});

describe("4. explicit absence still works — in the sitting it was raised in", () => {
  it("offers on the turn the person says it", async () => {
    const store = storeWith({ createdAt: at(1) });
    const result = await offer(store, [
      { role: "user", content: "I haven't seen Don recently.", createdAt: at(1) },
      { role: "assistant", content: "That's a while.", createdAt: at(0) },
    ]);
    expect(result.outcome).toBe("offered");
    if (result.outcome !== "offered") return;
    expect(result.entityName).toBe("Don");
    // The person supplied the context, so nothing explains it back at them.
    expect(result.preamble).toBeNull();
  });

  it("is reached past a cadence offer about somebody else that is paced out", async () => {
    // A cadence offer about Mary sits FIRST in the candidate list and is
    // withheld — the sitting is two short turns. The loop must `continue`
    // rather than `return`, because behind it is the person's own words.
    const store = storeWith({
      proposal: { ...CADENCE_PROPOSAL, entityId: "entity-mary", entityName: "Mary" },
      entityId: "entity-mary",
      createdAt: at(1),
    });
    store.entities.push({
      id: "entity-mary", type: "person", subtype: null, displayName: "Mary",
      aliases: [], status: "active", origin: "user" as const, lastMentionedAt: null,
    });
    store.opportunities.push({
      ...store.opportunities[0],
      id: "opp-2",
      signalId: "sig-2",
      entityId: DON,
      proposal: { ...ABSENCE_PROPOSAL },
      createdAt: at(1),
    });

    const result = await offer(store, [
      { role: "user", content: "I haven't seen Don recently.", createdAt: at(1) },
    ]);
    expect(result.outcome).toBe("offered");
    if (result.outcome !== "offered") return;
    expect(result.opportunityId).toBe("opp-2");
    expect(result.entityName).toBe("Don");
  });
});

describe("5. cadence still works when a conversation is genuinely underway", () => {
  it("offers once the sitting passes both the turn and the substance bar", async () => {
    const store = storeWith({ proposal: { ...CADENCE_PROPOSAL } });
    const result = await offer(store, [
      { role: "user", content: "The garden has been hard work this week — the roses all need cutting back and I never seem to get to them.", createdAt: at(8) },
      { role: "assistant", content: "That sounds like a lot.", createdAt: at(7) },
      { role: "user", content: "It is, but I enjoy it when the weather is kind.", createdAt: at(6) },
      { role: "assistant", content: "What else is growing?", createdAt: at(5) },
      { role: "user", content: "Tomatoes, mostly, and far too much mint.", createdAt: at(0) },
    ]);
    expect(result.outcome).toBe("offered");
    if (result.outcome !== "offered") return;
    // And it still explains itself, which is the M12 behaviour.
    expect(result.preamble).toBe("You usually see Don about once a week, and it's been 13 days.");
  });
});

describe("6. provenance decides who may be named on a card", () => {
  it("refuses an entity created by a development seeding route", async () => {
    const store = storeWith({ createdAt: at(1) });
    store.entities[0].origin = "dev";
    store.entities[0].displayName = "TestPersonA";
    const result = await offer(store, [
      { role: "user", content: "I haven't seen TestPersonA recently.", createdAt: at(1) },
    ]);
    // `sanitizeLabel` cannot refuse this: it is letters all the way through.
    expect(result.outcome).toBe("none");
  });

  it("still presents a demo-fixture entity — the seeded demo IS the product", async () => {
    const store = storeWith({ createdAt: at(1) });
    store.entities[0].origin = "demo";
    const result = await offer(store, [
      { role: "user", content: "I haven't seen Don recently.", createdAt: at(1) },
    ]);
    expect(result.outcome).toBe("offered");
  });
});

beforeEach(() => {
  resetIds();
  resetM5Ids();
});

/**
 * 7. A NAME IS NOT A REVIVAL, AND NEWER CONTACT ENDS IT (M12e.1).
 *
 * The first version of the gate accepted "the person named the entity
 * again" as support for any kind of opportunity. For an explicit absence
 * that is too weak, and in the observed case exactly backwards:
 *
 *     yesterday   "I haven't seen Don recently."
 *     today       "Don sent me a message this morning."
 *
 * The second turn contains "Don" and is evidence AGAINST the first.
 */
const ABSENCE_STATED_AT = new Date(NOW.getTime() - 20 * HOUR).toISOString();
const ABSENCE_WINDOW_START = new Date(NOW.getTime() - 7 * 24 * HOUR).toISOString();

function absenceStore(overrides: Partial<StoredOpportunity> = {}): M5Store {
  return storeWith({
    proposal: {
      ...ABSENCE_PROPOSAL,
      observation: {
        ...ABSENCE_PROPOSAL.observation,
        window: { start: ABSENCE_WINDOW_START, end: ABSENCE_STATED_AT },
        statedAt: ABSENCE_STATED_AT,
      },
    },
    createdAt: ABSENCE_STATED_AT,
    ...overrides,
  });
}

/** A positive contact with Don, recorded after the absence was stated. */
function contactWithDon(store: M5Store, options: { occurredAt: string; reportedAt: string }) {
  store.interactionEvents.push({
    id: "evt-1",
    entityId: DON,
    eventType: "call",
    occurredAt: options.occurredAt,
    occurredAtPrecision: "day",
    reportedAt: options.reportedAt,
    certainty: 0.9,
    polarity: "positive",
    windowStart: null,
    windowEnd: null,
    sourceObservationId: null,
    ingestFingerprint: "fp-1",
  });
}

describe("7a. naming the entity does not revive a stale absence", () => {
  it.each([
    "Don sent me a message today.",
    "I spoke with Don today.",
    "Don likes tea.",
    "I should message Don.",
  ])("withholds against %j in a later sitting", async (content) => {
    const store = absenceStore();
    const result = await offer(store, [{ role: "user", content, createdAt: at(0) }]);
    expect(result.outcome).toBe("none");
    // And it is still waiting, unspent — the rule is about WHEN, not about
    // throwing the evidence away.
    expect(store.opportunities[0].status).toBe("drafted");
    expect(store.opportunities[0].offeredAt).toBeNull();
  });

  it("gives the reason as the context, not as a missing name", () => {
    const verdict = mayPresentOpportunity(
      [{ role: "user", content: "Don sent me a message this morning.", createdAt: at(0) }],
      {
        kind: "user_stated_absence",
        entityName: "Don",
        raisedAtIso: ABSENCE_STATED_AT,
        offeredAtIso: null,
      },
    );
    expect(verdict.present).toBe(false);
    expect(verdict.reason).toBe("context_no_longer_supports_offer");
  });

  it("still presents on the turn the person actually says it", async () => {
    const store = absenceStore({ createdAt: at(1) });
    store.opportunities[0].proposal = {
      ...ABSENCE_PROPOSAL,
      observation: {
        ...ABSENCE_PROPOSAL.observation,
        window: { start: ABSENCE_WINDOW_START, end: at(1) },
        statedAt: at(1),
      },
    };
    const result = await offer(store, [
      { role: "user", content: "I haven't seen Don recently.", createdAt: at(1) },
    ]);
    expect(result.outcome).toBe("offered");
  });
});

describe("7b. newer positive contact supersedes the absence", () => {
  it("withholds once contact is recorded, even inside the same sitting", async () => {
    const store = absenceStore({ createdAt: at(4) });
    store.opportunities[0].proposal = {
      ...ABSENCE_PROPOSAL,
      observation: {
        ...ABSENCE_PROPOSAL.observation,
        window: { start: ABSENCE_WINDOW_START, end: at(4) },
        statedAt: at(4),
      },
    };
    // Said it four minutes ago; told us about the call one minute ago.
    contactWithDon(store, { occurredAt: at(1), reportedAt: at(1) });

    const result = await offer(store, [
      { role: "user", content: "I haven't seen Don recently.", createdAt: at(4) },
      { role: "user", content: "Don rang me this morning actually.", createdAt: at(1) },
    ]);
    expect(result.outcome).toBe("none");
    expect(store.opportunities[0].status).toBe("drafted");
  });

  it("is not fooled by contact about an OLDER period", () => {
    // "Don came round last month", mentioned today, contradicts nothing
    // about this week.
    expect(
      absenceIsSuperseded({
        statedAtIso: ABSENCE_STATED_AT,
        windowStartIso: ABSENCE_WINDOW_START,
        latestPositive: {
          occurredAtIso: new Date(NOW.getTime() - 40 * 24 * HOUR).toISOString(),
          reportedAtIso: NOW.toISOString(),
        },
      }),
    ).toBe(false);
  });

  it("is not fooled by contact we already knew about when they said it", () => {
    expect(
      absenceIsSuperseded({
        statedAtIso: ABSENCE_STATED_AT,
        windowStartIso: ABSENCE_WINDOW_START,
        latestPositive: {
          occurredAtIso: new Date(NOW.getTime() - 3 * 24 * HOUR).toISOString(),
          reportedAtIso: new Date(NOW.getTime() - 30 * HOUR).toISOString(),
        },
      }),
    ).toBe(false);
  });

  it("fails closed on an unreadable timestamp", () => {
    expect(
      absenceIsSuperseded({
        statedAtIso: "not-a-date",
        windowStartIso: ABSENCE_WINDOW_START,
        latestPositive: { occurredAtIso: NOW.toISOString(), reportedAtIso: NOW.toISOString() },
      }),
    ).toBe(true);
  });

  it("the DETECTOR refuses to mint it again, so it cannot keep coming back", () => {
    const base = {
      id: "abs-1",
      entityId: DON,
      eventType: "visit" as const,
      polarity: "absence" as const,
      windowStart: new Date(ABSENCE_WINDOW_START),
      windowEnd: new Date(ABSENCE_STATED_AT),
      reportedAt: new Date(ABSENCE_STATED_AT),
      certainty: 0.9,
    };
    const args = { baseline: null, now: NOW, conversationId: null };

    // Without newer contact it is a signal, exactly as before.
    expect(detectAssertedAbsence({ event: base, ...args })).not.toBeNull();

    // With it, there is no signal at all — not a weaker one.
    expect(
      detectAssertedAbsence({
        event: base,
        latestPositive: { occurredAtIso: at(60), reportedAtIso: at(30) },
        ...args,
      }),
    ).toBeNull();
  });
});

describe("7c. cadence keeps its own, separate logic", () => {
  it("a name mention still invites a cadence offer", async () => {
    const store = storeWith({ proposal: { ...CADENCE_PROPOSAL } });
    const result = await offer(store, [
      { role: "user", content: "I should message Don.", createdAt: at(0) },
    ]);
    expect(result.outcome).toBe("offered");
  });

  it("and a cadence offer is never superseded by contact evidence here", () => {
    // The cadence detector already re-reads the events; presentation does
    // not second-guess it, and asking would mean two places deciding the
    // same thing differently.
    const verdict = mayPresentOpportunity(
      [{ role: "user", content: "I should message Don.", createdAt: at(0) }],
      {
        kind: "no_mention_since",
        entityName: "Don",
        raisedAtIso: ABSENCE_STATED_AT,
        offeredAtIso: null,
        supersededByLaterContact: true,
      },
    );
    expect(verdict.present).toBe(true);
    expect(verdict.reason).toBe("person_named_it");
  });
});
