import { beforeEach, describe, expect, it } from "vitest";
import { fixedClock, type Clock } from "@/server/adapters/clock";
import {
  handleConsentReply,
  prepareOffer,
  replyForApproval,
  replyForDecline,
} from "@/server/services/consent";
import { buildOfferBlock, OFFER_CLOSING_QUESTION } from "@/core/share/offer";
import { sha256Hex } from "@/core/share/text-hash";
import { grantState } from "@/core/consent/validation";
import { createStore, resetIds, type StoredOpportunity } from "./detection-fakes";
import { m5Deps, resetM5Ids, withM5, type M5Store } from "./consent-fakes";

/**
 * The offer and the answer.
 *
 * Every test here is ultimately about one sentence: what was SHOWN is what was
 * APPROVED. The bytes are deliberately awkward - an em dash, an apostrophe and
 * a non-ASCII name - because "byte-for-byte" is a claim that only means
 * something when the bytes are not plain ASCII.
 */
const NOW = new Date("2026-09-16T12:00:00.000Z");
const HOUR = 3_600_000;
const USER = "user-1";
const JOHN = "entity-john";
const TEXT = "Hi John — are you and Simba visiting this weekend? Dad’s hoping so. ☕";
const HASH = sha256Hex(TEXT);
const PAYLOAD = {
  fromDisplayName: "Dad",
  aboutEntityName: "Simba",
  topic: "visit" as const,
  question: "ask_if_visiting" as const,
};

function storeWith(overrides: Partial<StoredOpportunity> = {}): M5Store {
  const store = withM5(
    createStore({
      entities: [
        {
          id: JOHN, type: "person", subtype: null, displayName: "John",
          aliases: [], status: "active", lastMentionedAt: null,
        },
      ],
    }),
  );
  store.opportunities.push({
    id: "opp-1",
    userId: USER,
    signalId: "sig-1",
    entityId: JOHN,
    proposal: { entityId: JOHN, entityName: "John" },
    sharePayload: { ...PAYLOAD },
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

const deps = (store: M5Store, clock: Clock = fixedClock(NOW)) => m5Deps({ store, clock });

beforeEach(() => {
  resetIds();
  resetM5Ids();
});

describe("1. the offer shows the stored bytes, exactly", () => {
  it("builds the frozen three-part block around the verbatim draft", async () => {
    const store = storeWith();
    const result = await prepareOffer(deps(store).consent, { userId: USER, conversationId: "conv-1", recentMessages: [] });

    expect(result.outcome).toBe("offered");
    if (result.outcome !== "offered") return;

    expect(result.block).toBe(
      `I can send John this message:\n\n${TEXT}\n\n${OFFER_CLOSING_QUESTION}`,
    );
    // The draft inside the block is the stored string, byte for byte.
    expect(result.block).toContain(TEXT);
    expect(sha256Hex(result.renderedText)).toBe(store.opportunities[0].renderedTextHash);
    expect(store.opportunities[0].status).toBe("offered");
    expect(store.opportunities[0].offeredAt).toBe(NOW.toISOString());
  });

  it("transitions only once, however many turns race", async () => {
    const store = storeWith();
    const d = deps(store).consent;
    const [a, b] = await Promise.all([
      prepareOffer(d, { userId: USER, conversationId: "conv-1", recentMessages: [] }),
      prepareOffer(d, { userId: USER, conversationId: "conv-1", recentMessages: [] }),
    ]);
    const outcomes = [a.outcome, b.outcome].sort();
    // The loser says nothing: nobody has finished presenting it yet, so a
    // second block would show the person the same message twice.
    expect(outcomes).toEqual(["none", "offered"]);
    expect(store.opportunities[0].offeredAt).toBe(NOW.toISOString());
  });

  it("stays quiet once the transcript already carries the draft", async () => {
    const store = storeWith({ status: "offered", offeredAt: NOW.toISOString() });
    const result = await prepareOffer(deps(store).consent, {
      userId: USER,
      conversationId: "conv-1",
      recentMessages: [
        {
          role: "assistant",
          content: buildOfferBlock({ entityName: "John", renderedText: TEXT }),
          createdAt: NOW.toISOString(),
        },
      ],
    });
    expect(result.outcome).toBe("none");
  });

  it("re-presents the SAME bytes when a stream died before the person saw them", async () => {
    const store = storeWith({ status: "offered", offeredAt: NOW.toISOString() });
    const result = await prepareOffer(deps(store).consent, {
      userId: USER,
      conversationId: "conv-1",
      recentMessages: [
        {
          role: "assistant",
          content: "Lovely weather today.",
          createdAt: new Date(NOW.getTime() + 1000).toISOString(),
        },
      ],
    });
    expect(result.outcome).toBe("represented");
    if (result.outcome !== "represented") return;
    expect(result.renderedText).toBe(TEXT);
    // Never a different message, and no second transition.
    expect(store.opportunities[0].offeredAt).toBe(NOW.toISOString());
  });

  it("expires rather than offering a stale draft", async () => {
    const store = storeWith({ expiresAt: NOW.toISOString() });
    const result = await prepareOffer(deps(store).consent, { userId: USER, conversationId: "conv-1", recentMessages: [] });
    expect(result.outcome).toBe("none");
    expect(store.opportunities[0].status).toBe("expired");
  });
});

describe("2. the answer", () => {
  async function offerThenReply(text: string, clock: Clock = fixedClock(NOW)) {
    const store = storeWith();
    const d = deps(store, clock).consent;
    await prepareOffer(d, { userId: USER, conversationId: "conv-1", recentMessages: [] });
    const outcome = await handleConsentReply(d, {
      userId: USER,
      text,
      grantingMessageId: "msg-yes",
    });
    return { store, outcome };
  }

  it("a clear yes approves, and pins a grant to the exact bytes", async () => {
    const { store, outcome } = await offerThenReply("yes please");

    expect(outcome.outcome).toBe("approved");
    if (outcome.outcome !== "approved") return;
    expect(outcome.reply).toBe(replyForApproval("John"));
    expect(store.opportunities[0].status).toBe("approved");

    const grant = store.grants[0];
    expect(grant.renderedTextSnapshot).toBe(TEXT);
    expect(grant.renderedTextHash).toBe(HASH);
    expect(sha256Hex(grant.renderedTextSnapshot)).toBe(grant.renderedTextHash);
    expect(grant.payloadSnapshot).toEqual(PAYLOAD);
    expect(grant.grantingMessageId).toBe("msg-yes");
    expect(grantState(grant, NOW)).toBe("active");
    // 72 hours, from approval, never extended.
    expect(Date.parse(grant.expiresAt) - NOW.getTime()).toBe(72 * HOUR);
    expect(grant.scope).toEqual({
      recipientEntityId: JOHN,
      purpose: "reconnect_request",
      fields: ["fromDisplayName", "aboutEntityName", "topic", "question"],
    });
  });

  it("a clear no declines, and creates nothing", async () => {
    const { store, outcome } = await offerThenReply("no thanks");
    expect(outcome.outcome).toBe("declined");
    if (outcome.outcome !== "declined") return;
    expect(outcome.reply).toBe(replyForDecline());
    expect(store.opportunities[0].status).toBe("declined");
    expect(store.opportunities[0].resolvedAt).toBe(NOW.toISOString());
    expect(store.grants).toHaveLength(0);
    expect(store.requests).toHaveLength(0);
    // The row survives: M4's cooldowns are built on it.
    expect(store.opportunities).toHaveLength(1);
  });

  it("hesitation asks once more and changes nothing", async () => {
    const { store, outcome } = await offerThenReply("maybe later");
    expect(outcome.outcome).toBe("unclear");
    expect(store.opportunities[0].status).toBe("offered");
    expect(store.grants).toHaveLength(0);
  });

  it("changing the subject is not an answer and lets the chat continue", async () => {
    const { store, outcome } = await offerThenReply("The roses came out beautifully.");
    expect(outcome.outcome).toBe("not_an_answer");
    expect(store.opportunities[0].status).toBe("offered");
  });

  it("refuses to approve a stale offer", async () => {
    const store = storeWith();
    const d = deps(store).consent;
    await prepareOffer(d, { userId: USER, conversationId: "conv-1", recentMessages: [] });

    const later = fixedClock(new Date(NOW.getTime() + 25 * HOUR));
    const outcome = await handleConsentReply(deps(store, later).consent, {
      userId: USER,
      text: "yes",
      grantingMessageId: "msg-yes",
    });

    expect(outcome.outcome).toBe("expired");
    expect(store.opportunities[0].status).toBe("expired");
    expect(store.grants).toHaveLength(0);
  });

  it("says nothing when there is no offer on the table", async () => {
    const store = storeWith();
    const outcome = await handleConsentReply(deps(store).consent, {
      userId: USER, text: "yes", grantingMessageId: null,
    });
    expect(outcome.outcome).toBe("no_offer");
  });
});

describe("3. a duplicated yes produces one grant, not two", () => {
  it("is idempotent under a race", async () => {
    const store = storeWith();
    const d = deps(store).consent;
    await prepareOffer(d, { userId: USER, conversationId: "conv-1", recentMessages: [] });

    const [a, b] = await Promise.all([
      handleConsentReply(d, { userId: USER, text: "yes", grantingMessageId: "m1" }),
      handleConsentReply(d, { userId: USER, text: "yes", grantingMessageId: "m2" }),
    ]);

    expect(store.grants).toHaveLength(1);
    expect(store.opportunities[0].status).toBe("approved");
    // Both callers are told the truth: consent exists.
    const approved = [a, b].filter((o) => o.outcome === "approved");
    expect(approved.length).toBeGreaterThanOrEqual(1);
  });

  it("a second yes after approval finds no offer to answer", async () => {
    const store = storeWith();
    const d = deps(store).consent;
    await prepareOffer(d, { userId: USER, conversationId: "conv-1", recentMessages: [] });
    await handleConsentReply(d, { userId: USER, text: "yes", grantingMessageId: "m1" });

    const again = await handleConsentReply(d, {
      userId: USER, text: "yes", grantingMessageId: "m2",
    });
    expect(again.outcome).toBe("no_offer");
    expect(store.grants).toHaveLength(1);
  });
});

describe("4. approval requires an offer that was actually made", () => {
  it("a drafted-but-never-offered opportunity cannot be approved", async () => {
    const store = storeWith();
    const outcome = await handleConsentReply(deps(store).consent, {
      userId: USER, text: "yes", grantingMessageId: null,
    });
    // `offered` is the only state a yes can act on: the person has to have
    // been shown the bytes.
    expect(outcome.outcome).toBe("no_offer");
    expect(store.opportunities[0].status).toBe("drafted");
  });
});
