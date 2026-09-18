import { beforeEach, describe, expect, it } from "vitest";
import { fixedClock, type Clock } from "@/server/adapters/clock";
import { handleConsentReply, prepareOffer } from "@/server/services/consent";
import {
  createAuthorizedRequest,
  expireOverdueFamilyRequests,
  retryPendingDelivery,
  sendApprovedOpportunity,
} from "@/server/services/family-send";
import { loadFamilyView, recordFamilyReply } from "@/server/services/family-response";
import { acknowledgeClosure, loadPendingClosure } from "@/server/services/closure";
import { sha256Hex } from "@/core/share/text-hash";
import { hashFamilyToken } from "@/core/family/token";
import { grantState } from "@/core/consent/validation";
import { createStore, resetIds } from "./detection-fakes";
import {
  fakeFamilyRequests,
  fakeNotifier,
  m5Deps,
  resetM5Ids,
  withM5,
  type M5Store,
} from "./consent-fakes";

const NOW = new Date("2026-09-16T12:00:00.000Z");
const HOUR = 3_600_000;
const DAY = 86_400_000;
const USER = "user-1";
const JOHN = "entity-john";
const SENTINEL = "PRIVATE_TRANSCRIPT_SENTINEL_92817";
/** Awkward on purpose: em dash, curly apostrophe, non-ASCII. */
const TEXT = "Hi John — are you visiting this weekend? Dad’s hoping so. ☕";
const HASH = sha256Hex(TEXT);
const PAYLOAD = {
  fromDisplayName: "Dad",
  topic: "visit" as const,
  question: "ask_if_visiting" as const,
};

function seed(): M5Store {
  const store = withM5(
    createStore({
      entities: [
        {
          id: JOHN, type: "person", subtype: null, displayName: "John",
          // Private content planted where the outbound path might reach it.
          aliases: [SENTINEL], status: "active", lastMentionedAt: null,
        },
      ],
    }),
  );
  store.opportunities.push({
    id: "opp-1",
    userId: USER,
    signalId: "sig-1",
    entityId: JOHN,
    proposal: {
      entityId: JOHN, entityName: "John", eventType: "visit",
      observation: { kind: "no_mention_since", days: 13 },
      pattern: { medianGapDays: 7 }, question: "ask_if_visiting",
      transcriptNote: SENTINEL,
    },
    sharePayload: { ...PAYLOAD },
    renderedText: TEXT,
    renderedTextHash: HASH,
    status: "drafted",
    offeredAt: null,
    resolvedAt: null,
    expiresAt: new Date(NOW.getTime() + 24 * HOUR).toISOString(),
    createdAt: NOW.toISOString(),
  });
  return store;
}

async function approve(store: M5Store, clock: Clock = fixedClock(NOW)) {
  const d = m5Deps({ store, clock });
  await prepareOffer(d.consent, { userId: USER, recentMessages: [] });
  const outcome = await handleConsentReply(d.consent, {
    userId: USER, text: "yes please", grantingMessageId: "msg-1",
  });
  if (outcome.outcome !== "approved") throw new Error(`expected approval, got ${outcome.outcome}`);
  return outcome;
}

beforeEach(() => {
  resetIds();
  resetM5Ids();
});

describe("1. the exact-byte chain", () => {
  it("shown == approved == stored == sent, with one hash throughout", async () => {
    const store = seed();
    const d = m5Deps({ store, clock: fixedClock(NOW) });

    const offer = await prepareOffer(d.consent, { userId: USER, recentMessages: [] });
    if (offer.outcome !== "offered") throw new Error("expected an offer");
    await handleConsentReply(d.consent, {
      userId: USER, text: "yes", grantingMessageId: "msg-1",
    });
    const sent = await sendApprovedOpportunity(d.send, { userId: USER, opportunityId: "opp-1" });

    expect(sent.outcome).toBe("sent");

    const stored = store.opportunities[0].renderedText!;
    const shown = offer.block;
    const approvedSnapshot = store.grants[0].renderedTextSnapshot;
    const requestBody = store.requests[0].renderedBody;
    const notifierBody = store.delivered[0].body;

    // Every stage carries the same bytes, and the hash proves it.
    expect(shown).toContain(stored);
    expect(approvedSnapshot).toBe(stored);
    expect(requestBody).toBe(approvedSnapshot);
    expect(notifierBody).toBe(approvedSnapshot);
    for (const value of [stored, approvedSnapshot, requestBody, notifierBody]) {
      expect(sha256Hex(value)).toBe(HASH);
    }
    // Nothing trimmed, normalised or re-encoded on the way through.
    expect(notifierBody).toBe(TEXT);
    expect(notifierBody.normalize("NFC")).toBe(notifierBody);
  });

  it("finalises exactly once: consent spent, opportunity consumed, request delivered", async () => {
    const store = seed();
    const d = m5Deps({ store, clock: fixedClock(NOW) });
    await approve(store);
    await sendApprovedOpportunity(d.send, { userId: USER, opportunityId: "opp-1" });

    expect(store.grants[0].usedAt).toBe(NOW.toISOString());
    expect(grantState(store.grants[0], NOW)).toBe("used");
    expect(store.opportunities[0].status).toBe("consumed");
    expect(store.requests[0].status).toBe("delivered");
    expect(store.requests).toHaveLength(1);
  });

  it("a second send is a no-op, not a second message", async () => {
    const store = seed();
    const d = m5Deps({ store, clock: fixedClock(NOW) });
    await approve(store);
    await sendApprovedOpportunity(d.send, { userId: USER, opportunityId: "opp-1" });
    const again = await sendApprovedOpportunity(d.send, { userId: USER, opportunityId: "opp-1" });

    expect(again.outcome).toBe("already_sent");
    expect(store.delivered).toHaveLength(1);
    expect(store.requests).toHaveLength(1);
  });
});

describe("2. integrity: any mismatch aborts the send", () => {
  const mutations: Array<[string, (store: M5Store) => void]> = [
    ["the opportunity's text was edited", (s) => { s.opportunities[0].renderedText = `${TEXT}!`; }],
    ["the opportunity's hash was changed", (s) => { s.opportunities[0].renderedTextHash = sha256Hex("other"); }],
    ["the grant's snapshot was edited", (s) => { s.grants[0].renderedTextSnapshot = `${TEXT} `; }],
    ["the grant's hash was changed", (s) => { s.grants[0].renderedTextHash = sha256Hex("other"); }],
    ["the payload was changed", (s) => { s.opportunities[0].sharePayload = { ...PAYLOAD, timeframe: "tonight" }; }],
    ["the grant was revoked", (s) => { s.grants[0].revokedAt = NOW.toISOString(); }],
  ];

  for (const [label, mutate] of mutations) {
    it(`refuses when ${label}`, async () => {
      const store = seed();
      const d = m5Deps({ store, clock: fixedClock(NOW) });
      await approve(store);
      mutate(store);

      const result = await sendApprovedOpportunity(d.send, {
        userId: USER, opportunityId: "opp-1",
      });

      expect(result.outcome).toBe("integrity_failure");
      // No notifier call, no consumed consent, no consumed opportunity.
      expect(store.delivered).toHaveLength(0);
      expect(store.requests).toHaveLength(0);
      expect(store.grants[0].usedAt).toBeNull();
      expect(store.opportunities[0].status).toBe("approved");
    });
  }

  it("refuses once the 72-hour consent window has passed", async () => {
    const store = seed();
    await approve(store);
    const tooLate = fixedClock(new Date(NOW.getTime() + 72 * HOUR));
    const d = m5Deps({ store, clock: tooLate });

    const result = await sendApprovedOpportunity(d.send, { userId: USER, opportunityId: "opp-1" });

    expect(result.outcome).toBe("integrity_failure");
    if (result.outcome === "integrity_failure") expect(result.failure).toBe("grant_expired");
    expect(store.delivered).toHaveLength(0);
    expect(store.grants[0].usedAt).toBeNull();
  });

  it("never re-renders or repairs — it simply does not send", async () => {
    const store = seed();
    const d = m5Deps({ store, clock: fixedClock(NOW) });
    await approve(store);
    store.opportunities[0].renderedText = "A completely different sentence?";

    await sendApprovedOpportunity(d.send, { userId: USER, opportunityId: "opp-1" });

    // The stored draft is left exactly as it was found. Nothing tried to fix it.
    expect(store.opportunities[0].renderedText).toBe("A completely different sentence?");
    expect(store.grants[0].renderedTextSnapshot).toBe(TEXT);
  });
});

describe("3. delivery failure is unfinished transport, never lost consent", () => {
  it("keeps the obligation, keeps consent spent, and retries the same bytes", async () => {
    const store = seed();
    await approve(store);

    const failing = m5Deps({
      store,
      clock: fixedClock(NOW),
      notifier: fakeNotifier(store, { failWith: new Error("smtp down") }),
    });
    const failed = await sendApprovedOpportunity(failing.send, {
      userId: USER, opportunityId: "opp-1",
    });

    expect(failed.outcome).toBe("delivery_failed");
    // Frozen E3: the authorization became a durable obligation the moment the
    // request row was created. It is not un-made by a transport failure.
    expect(store.requests[0].status).toBe("pending");
    expect(store.requests[0].deliveryAttempts).toBe(1);
    expect(store.grants[0].usedAt).toBe(NOW.toISOString());
    expect(grantState(store.grants[0], NOW)).toBe("used");
    expect(store.opportunities[0].status).toBe("consumed");

    // The retry. Same request, same bytes, same consent - a new token only,
    // because the first plaintext died with that process.
    const firstTokenHash = store.requests[0].accessTokenHash;
    const working = m5Deps({ store, clock: fixedClock(NOW) });
    const retried = await sendApprovedOpportunity(working.send, {
      userId: USER, opportunityId: "opp-1",
    });

    expect(retried.outcome).toBe("sent");
    expect(store.requests).toHaveLength(1);
    expect(store.requests[0].status).toBe("delivered");
    expect(store.requests[0].renderedBody).toBe(TEXT);
    expect(store.requests[0].accessTokenHash).not.toBe(firstTokenHash);
    // The 7-day window runs from CREATION and is not reset by a retry.
    expect(store.requests[0].tokenExpiresAt).toBe(
      new Date(NOW.getTime() + 7 * DAY).toISOString(),
    );
    // Still exactly one grant, still spent once.
    expect(store.grants).toHaveLength(1);
    expect(store.grants[0].usedAt).toBe(NOW.toISOString());
  });

  it("a retry does NOT re-run the consent preconditions", async () => {
    // The trap this pins: `usedAt is null` is a precondition of CREATING the
    // obligation. Re-applying it to transport would make every retry fail
    // forever with "consent already used" - on exactly the state that proves
    // consent was properly given.
    const store = seed();
    await approve(store);
    const failing = m5Deps({
      store, clock: fixedClock(NOW),
      notifier: fakeNotifier(store, { failWith: new Error("smtp down") }),
    });
    await sendApprovedOpportunity(failing.send, { userId: USER, opportunityId: "opp-1" });
    expect(store.grants[0].usedAt).not.toBeNull();

    const working = m5Deps({ store, clock: fixedClock(NOW) });
    const retried = await sendApprovedOpportunity(working.send, {
      userId: USER, opportunityId: "opp-1",
    });
    expect(retried.outcome).toBe("sent");
  });

  it("survives repeated failures and still delivers once", async () => {
    const store = seed();
    await approve(store);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const failing = m5Deps({
        store, clock: fixedClock(NOW),
        notifier: fakeNotifier(store, { failWith: new Error(`attempt ${attempt}`) }),
      });
      const result = await sendApprovedOpportunity(failing.send, {
        userId: USER, opportunityId: "opp-1",
      });
      expect(result.outcome).toBe("delivery_failed");
    }
    expect(store.requests).toHaveLength(1);
    expect(store.requests[0].deliveryAttempts).toBe(3);

    const working = m5Deps({ store, clock: fixedClock(NOW) });
    expect(
      (await sendApprovedOpportunity(working.send, { userId: USER, opportunityId: "opp-1" })).outcome,
    ).toBe("sent");
    expect(store.requests).toHaveLength(1);
    // Four notifier calls, one logical delivery, one set of bytes throughout.
    expect(store.delivered).toHaveLength(4);
    expect(new Set(store.delivered.map((m) => m.body))).toEqual(new Set([TEXT]));
    expect(new Set(store.delivered.map((m) => m.requestId))).toEqual(
      new Set([store.requests[0].id]),
    );
  });

  it("the person is never asked to approve the same message twice", async () => {
    const store = seed();
    await approve(store);
    const failing = m5Deps({
      store, clock: fixedClock(NOW),
      notifier: fakeNotifier(store, { failWith: new Error("smtp down") }),
    });
    await sendApprovedOpportunity(failing.send, { userId: USER, opportunityId: "opp-1" });

    // `consumed` is terminal. Nothing re-opens the opportunity, nothing
    // re-offers it, and no second grant is ever created.
    expect(store.opportunities[0].status).toBe("consumed");
    expect(store.grants).toHaveLength(1);
    const offer = await prepareOffer(m5Deps({ store, clock: fixedClock(NOW) }).consent, {
      userId: USER, recentMessages: [],
    });
    expect(offer.outcome).toBe("none");
  });

  it("a crash between creation and the notifier is retried, not re-consented", async () => {
    // The exact persisted state a reclaimed runtime leaves: obligation pending,
    // grant used, opportunity consumed, nothing delivered. Built directly so
    // the test does not depend on HOW the crash happened.
    const store = seed();
    await approve(store);
    const deps = m5Deps({ store, clock: fixedClock(NOW) });
    const created = await createAuthorizedRequest(deps.send, {
      userId: USER, opportunityId: "opp-1",
    });
    expect(created.outcome).toBe("authorized");
    expect(store.delivered).toHaveLength(0);
    expect(store.requests[0].status).toBe("pending");
    expect(store.grants[0].usedAt).toBe(NOW.toISOString());
    expect(store.opportunities[0].status).toBe("consumed");

    const requestId = store.requests[0].id;
    const drained = await sendApprovedOpportunity(deps.send, {
      userId: USER, opportunityId: "opp-1",
    });

    expect(drained).toMatchObject({ outcome: "sent", requestId });
    expect(store.requests).toHaveLength(1);
    expect(store.requests[0].id).toBe(requestId);
    expect(store.grants).toHaveLength(1);
    expect(store.delivered).toHaveLength(1);
    expect(store.delivered[0].body).toBe(TEXT);
  });

  it("retryPendingDelivery works from the request alone, with no opportunity in hand", async () => {
    // The service boundary the drain would call. It is transport: it takes an
    // obligation and moves bytes. It asks no consent question at all.
    const store = seed();
    await approve(store);
    const deps = m5Deps({ store, clock: fixedClock(NOW) });
    await createAuthorizedRequest(deps.send, { userId: USER, opportunityId: "opp-1" });

    const result = await retryPendingDelivery(deps.send, { request: store.requests[0] });
    expect(result).toMatchObject({ outcome: "sent" });
    expect(store.requests[0].status).toBe("delivered");

    // And it is idempotent: a second drain finds nothing left to transport.
    const again = await retryPendingDelivery(deps.send, { request: store.requests[0] });
    expect(again).toMatchObject({ outcome: "already_sent" });
    expect(store.delivered).toHaveLength(1);
  });

  it("a crash after the provider succeeded is bounded by the request id", async () => {
    // The residual risk that CANNOT be closed on this side of the network: the
    // provider delivered and the process died before `delivered` was written.
    // The retry carries the SAME request id, which is the natural idempotency
    // key for a provider that supports one. For a provider that does not,
    // exactly-once is not achievable and is documented, not pretended away.
    const store = seed();
    await approve(store);
    const deps = m5Deps({ store, clock: fixedClock(NOW) });
    await createAuthorizedRequest(deps.send, { userId: USER, opportunityId: "opp-1" });
    const requestId = store.requests[0].id;

    await retryPendingDelivery(deps.send, { request: { ...store.requests[0] } });
    // Simulate the lost write: the row never reached `delivered`.
    store.requests[0].status = "pending";
    store.requests[0].deliveredAt = null;
    await retryPendingDelivery(deps.send, { request: store.requests[0] });

    expect(store.delivered).toHaveLength(2);
    expect(store.delivered.every((m) => m.requestId === requestId)).toBe(true);
    expect(new Set(store.delivered.map((m) => m.body))).toEqual(new Set([TEXT]));
    // One obligation, one consent, whatever the transport did.
    expect(store.requests).toHaveLength(1);
    expect(store.grants).toHaveLength(1);
  });

  it("a delivered request is never re-sent", async () => {
    const store = seed();
    await approve(store);
    const d = m5Deps({ store, clock: fixedClock(NOW) });
    await sendApprovedOpportunity(d.send, { userId: USER, opportunityId: "opp-1" });

    const again = await sendApprovedOpportunity(d.send, { userId: USER, opportunityId: "opp-1" });
    expect(again.outcome).toBe("already_sent");
    expect(store.requests).toHaveLength(1);
    expect(store.delivered).toHaveLength(1);
    expect(store.grants[0].usedAt).toBe(NOW.toISOString());
  });
});

describe("4. the family surface", () => {
  async function delivered() {
    const store = seed();
    const d = m5Deps({ store, clock: fixedClock(NOW) });
    await approve(store);
    await sendApprovedOpportunity(d.send, { userId: USER, opportunityId: "opp-1" });
    const url = store.delivered[0].responseUrl;
    const token = url.slice(url.lastIndexOf("/") + 1);
    return { store, d, token };
  }

  it("serves the approved bytes and the topic's own choices", async () => {
    const { store, d, token } = await delivered();
    const view = await loadFamilyView(d.family, token);

    expect(view.outcome).toBe("ok");
    if (view.outcome !== "ok") return;
    expect(view.message).toBe(TEXT);
    expect(view.fromDisplayName).toBe("Dad");
    expect(view.choices.length).toBeGreaterThan(1);
    expect(store.requests[0].openedAt).toBe(NOW.toISOString());
  });

  it("refuses an unknown token, and says nothing about why", async () => {
    const { d } = await delivered();
    expect((await loadFamilyView(d.family, "not-a-real-token-value-1234")).outcome).toBe("not_found");
    expect((await loadFamilyView(d.family, "")).outcome).toBe("not_found");
  });

  it("refuses exactly AT the seven-day boundary", async () => {
    const { store, token } = await delivered();
    const expiresAt = Date.parse(store.requests[0].tokenExpiresAt);

    const justBefore = m5Deps({ store, clock: fixedClock(new Date(expiresAt - 1)) });
    expect((await loadFamilyView(justBefore.family, token)).outcome).toBe("ok");

    const atBoundary = m5Deps({ store, clock: fixedClock(new Date(expiresAt)) });
    expect((await loadFamilyView(atBoundary.family, token)).outcome).toBe("expired");
  });

  it("the token is stored only as a hash", async () => {
    const { store, token } = await delivered();
    expect(store.requests[0].accessTokenHash).toBe(hashFamilyToken(token));
    expect(JSON.stringify(store.requests[0])).not.toContain(token);
  });
});

describe("5. the reply and the closure", () => {
  async function replied(choiceId = "yes_weekend") {
    const store = seed();
    const d = m5Deps({ store, clock: fixedClock(NOW) });
    await approve(store);
    await sendApprovedOpportunity(d.send, { userId: USER, opportunityId: "opp-1" });
    const url = store.delivered[0].responseUrl;
    const token = url.slice(url.lastIndexOf("/") + 1);
    const result = await recordFamilyReply(d.family, { token, choiceId });
    return { store, d, token, result };
  }

  it("records the reply, answers the request and creates one closure", async () => {
    const { store, result } = await replied();
    expect(result.outcome).toBe("recorded");
    expect(store.responses).toHaveLength(1);
    expect(store.responses[0].parsed).toEqual({ intent: "yes", timeframe: "this weekend" });
    expect(store.responses[0].rawBody).toBe("Yes, we're visiting this weekend.");
    expect(store.requests[0].status).toBe("answered");
    expect(store.familyClosures).toHaveLength(1);
  });

  it("a double tap produces one response and one closure", async () => {
    const { store, d, token } = await replied();
    const again = await recordFamilyReply(d.family, { token, choiceId: "yes_weekend" });
    expect(again.outcome).toBe("already_answered");
    expect(store.responses).toHaveLength(1);
    expect(store.familyClosures).toHaveLength(1);
  });

  it("refuses a choice this message never offered", async () => {
    const store = seed();
    const d = m5Deps({ store, clock: fixedClock(NOW) });
    await approve(store);
    await sendApprovedOpportunity(d.send, { userId: USER, opportunityId: "opp-1" });
    const url = store.delivered[0].responseUrl;
    const token = url.slice(url.lastIndexOf("/") + 1);

    // A `call` choice on a `visit` message.
    const result = await recordFamilyReply(d.family, { token, choiceId: "yes_soon_call" });
    expect(result.outcome).toBe("invalid_choice");
    expect(store.responses).toHaveLength(0);
  });

  it("surfaces a factual closure once, and never again", async () => {
    const { store, d } = await replied();

    const pending = await loadPendingClosure(d.closure, { userId: USER });
    expect(pending).not.toBeNull();
    expect(pending!.sentence).toBe(
      "John replied that they are planning to visit this weekend.",
    );
    expect(pending!.marker).toEqual({
      type: "family_response",
      entityName: "John",
      response: "yes",
      timeframe: "this weekend",
    });

    expect(await acknowledgeClosure(d.closure, { closureId: pending!.closureId, messageId: "m9" })).toBe(true);
    expect(await loadPendingClosure(d.closure, { userId: USER })).toBeNull();
    expect(store.familyClosures[0].surfacedAt).toBe(NOW.toISOString());
    expect(store.familyClosures[0].surfacedMessageId).toBe("m9");
  });

  it("a 'not sure' reply closes the loop just as honestly", async () => {
    const { d } = await replied("unsure");
    const pending = await loadPendingClosure(d.closure, { userId: USER });
    expect(pending!.sentence).toBe("John replied that they are not sure yet.");
  });
});

describe("6. privacy: the family side sees one sentence and nothing else", () => {
  it("no transcript sentinel reaches the payload, the request, the notifier or the page", async () => {
    const store = seed();
    const d = m5Deps({ store, clock: fixedClock(NOW) });
    await approve(store);
    await sendApprovedOpportunity(d.send, { userId: USER, opportunityId: "opp-1" });

    const url = store.delivered[0].responseUrl;
    const token = url.slice(url.lastIndexOf("/") + 1);
    const view = await loadFamilyView(d.family, token);

    const surfaces = {
      grantPayload: JSON.stringify(store.grants[0].payloadSnapshot),
      grantSnapshot: store.grants[0].renderedTextSnapshot,
      request: JSON.stringify(store.requests[0]),
      notifier: JSON.stringify(store.delivered[0]),
      familyView: JSON.stringify(view),
    };

    for (const [where, value] of Object.entries(surfaces)) {
      expect(value, where).not.toContain(SENTINEL);
    }

    // And none of the detection internals travel either.
    for (const leak of [
      "no_mention_since", "daysSinceLast", "medianGapDays", "pattern",
      "entityId", "signalId", "sig-1", JOHN,
    ]) {
      expect(surfaces.notifier, leak).not.toContain(leak);
      expect(surfaces.familyView, leak).not.toContain(leak);
    }
  });

  it("the outbound payload is only the whitelisted fields", async () => {
    const store = seed();
    const d = m5Deps({ store, clock: fixedClock(NOW) });
    await approve(store);
    await sendApprovedOpportunity(d.send, { userId: USER, opportunityId: "opp-1" });

    expect(store.grants[0].payloadSnapshot).toEqual(PAYLOAD);
    expect(store.requests[0].payload).toEqual(PAYLOAD);
  });

  it("the notifier is handed a body, a link and a name — no payload object", async () => {
    const store = seed();
    const d = m5Deps({ store, clock: fixedClock(NOW) });
    await approve(store);
    await sendApprovedOpportunity(d.send, { userId: USER, opportunityId: "opp-1" });

    expect(Object.keys(store.delivered[0]).sort()).toEqual([
      "address",
      "body",
      "channel",
      "recipientDisplayName",
      "requestId",
      "responseUrl",
      "senderDisplayName",
    ]);

    /**
     * The two names are DIFFERENT PEOPLE, and the delivered email said so
     * wrongly for as long as only one of them was carried: the Brevo adapter
     * had nothing but `recipientDisplayName`, so John received "A message
     * from John".
     */
    expect(store.delivered[0].senderDisplayName).toBe("Dad");
    expect(store.delivered[0].recipientDisplayName).toBe("John");
    expect(store.delivered[0].senderDisplayName).not.toBe(
      store.delivered[0].recipientDisplayName,
    );

    // And the sender is a NAME, not a route back into the payload: no topic,
    // no question, no transcript arrives with it.
    expect(typeof store.delivered[0].senderDisplayName).toBe("string");
  });
});

describe("6. the family request has a real expiry lifecycle", () => {
  const WINDOW_END = new Date(NOW.getTime() + 7 * DAY);

  async function pendingRequest(store: M5Store) {
    await approve(store);
    const deps = m5Deps({ store, clock: fixedClock(NOW) });
    await createAuthorizedRequest(deps.send, { userId: USER, opportunityId: "opp-1" });
    return store.requests[0];
  }

  it("delivery stops at the boundary rather than sending a dead link", async () => {
    // A link that arrives already expired is worse than no link: the family
    // member clicks it, is told it has expired, and nobody learns anything.
    const store = seed();
    const request = await pendingRequest(store);
    expect(store.delivered).toHaveLength(0);

    const deps = m5Deps({ store, clock: fixedClock(WINDOW_END) });
    const result = await retryPendingDelivery(deps.send, { request, now: WINDOW_END });

    expect(result).toEqual({ outcome: "nothing_to_send" });
    expect(store.delivered).toHaveLength(0);
    expect(store.requests[0].status).toBe("expired");
  });

  it("delivers one second inside the window", async () => {
    const store = seed();
    const request = await pendingRequest(store);
    const justInside = new Date(WINDOW_END.getTime() - 1000);
    const deps = m5Deps({ store, clock: fixedClock(justInside) });

    expect(
      await retryPendingDelivery(deps.send, { request, now: justInside }),
    ).toMatchObject({ outcome: "sent" });
    expect(store.delivered).toHaveLength(1);
    expect(store.requests[0].status).toBe("delivered");
  });

  it("the bounded sweep retires pending and delivered, and never an answer", async () => {
    const store = seed();
    await pendingRequest(store);
    const pending = store.requests[0];

    // A delivered-but-unanswered request alongside it.
    store.requests.push({ ...pending, id: "req-delivered", status: "delivered" });
    store.requests.push({ ...pending, id: "req-answered", status: "answered" });

    const deps = m5Deps({ store, clock: fixedClock(new Date(WINDOW_END.getTime() + DAY)) });
    const retired = await expireOverdueFamilyRequests(deps.send, { userId: USER });

    expect(retired).toBe(2);
    expect(store.requests.find((r) => r.id === pending.id)?.status).toBe("expired");
    expect(store.requests.find((r) => r.id === "req-delivered")?.status).toBe("expired");
    // Terminal. The sweep is conditional precisely so it cannot walk back over
    // an answer the older adult is waiting to hear.
    expect(store.requests.find((r) => r.id === "req-answered")?.status).toBe("answered");
  });

  it("the sweep is idempotent and bounded", async () => {
    const store = seed();
    await pendingRequest(store);
    const deps = m5Deps({ store, clock: fixedClock(new Date(WINDOW_END.getTime() + DAY)) });

    expect(await expireOverdueFamilyRequests(deps.send, { userId: USER })).toBe(1);
    expect(await expireOverdueFamilyRequests(deps.send, { userId: USER })).toBe(0);
  });

  it("an expired-by-time request stops suppressing reconnects IMMEDIATELY", async () => {
    // The failure this closes: the lazy transition may not have run yet, so a
    // stale row that kept counting would silence the companion about that
    // person forever. Expiry is a fact about the clock; the status column is
    // only its record, and the count must not wait for the record.
    const store = seed();
    await pendingRequest(store);
    const requests = fakeFamilyRequests(store);

    expect(store.requests[0].status).toBe("pending");
    expect(
      await requests.countOutstandingForUser(USER, NOW.toISOString()),
    ).toBe(1);
    expect(
      await requests.countOutstandingForUser(USER, WINDOW_END.toISOString()),
    ).toBe(0);
    // Still `pending` on the row - the count did not need it to be retired.
    expect(store.requests[0].status).toBe("pending");
  });

  it("counts a live request exactly up to the boundary", async () => {
    const store = seed();
    await pendingRequest(store);
    const requests = fakeFamilyRequests(store);
    const oneSecondBefore = new Date(WINDOW_END.getTime() - 1000).toISOString();

    expect(await requests.countOutstandingForUser(USER, oneSecondBefore)).toBe(1);
    expect(await requests.countOutstandingForUser(USER, WINDOW_END.toISOString())).toBe(0);
  });
});
