import { beforeEach, describe, expect, it } from "vitest";
import { fixedClock } from "@/server/adapters/clock";
import { readWellbeing } from "@/core/wellbeing/self-report";
import { buildWellbeingProposal } from "@/core/wellbeing/offer";
import { buildFallbackText } from "@/core/share/fallback";
import { replyChoicesFor } from "@/core/family/response";
import { renderClosureSentence } from "@/core/family/closure";
import { ReconnectProposalSchema } from "@/core/detection/proposal";
import { noteWellbeingSelfReport, type WellbeingDeps } from "@/server/services/wellbeing";
import { handleConsentReply, prepareOffer } from "@/server/services/consent";
import { createStore, fakeReconnectDeps, fakeFamilyRender, resetIds } from "./detection-fakes";
import {
  afterOfferShown,
  fakeFamilyContacts,
  m5Deps,
  resetM5Ids,
  withM5,
} from "./consent-fakes";

/**
 * The consented wellbeing share (M12e).
 *
 * The property every test here defends is the same one: CareLoop may
 * REPEAT what the person said about themselves, to one person, once, after
 * they say yes — and may do nothing else with it.
 */
const NOW = new Date("2026-09-21T12:00:00.000Z");
const USER = "user-1";
const DON = "entity-don";
const MSG = "msg-1";

function setup(options: { contacts?: number; origin?: "user" | "demo" | "dev" } = {}) {
  const store = withM5(
    createStore({
      entities: [
        {
          id: DON, type: "person", subtype: null, displayName: "Don",
          aliases: [], status: "active", origin: options.origin ?? "user", lastMentionedAt: null,
        },
        {
          id: "entity-mary", type: "person", subtype: null, displayName: "Mary",
          aliases: [], status: "active", origin: "user" as const, lastMentionedAt: null,
        },
      ],
      profile: {
        id: USER,
        displayName: "George",
        familyDisplayName: "Dad",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    }),
  );
  const count = options.contacts ?? 1;
  if (count >= 1) {
    store.contacts.push({
      id: "contact-1", userId: USER, entityId: DON,
      channel: "dev", address: "don@example.test", displayName: "Don",
    });
  }
  if (count >= 2) {
    store.contacts.push({
      id: "contact-2", userId: USER, entityId: "entity-mary",
      channel: "dev", address: "mary@example.test", displayName: "Mary",
    });
  }

  const render = fakeFamilyRender({ text: "MODEL WROTE THIS" });
  const deps: WellbeingDeps = {
    ...fakeReconnectDeps({ store, clock: fixedClock(NOW), familyRender: render }),
    familyContacts: fakeFamilyContacts(store),
  };
  return { store, deps, render };
}

const note = (deps: WellbeingDeps, text: string, messageId = MSG) =>
  noteWellbeingSelfReport(deps, {
    userId: USER,
    conversationId: "conv-1",
    userMessageId: messageId,
    text,
  });

beforeEach(() => {
  resetIds();
  resetM5Ids();
});

describe("9/10. the detector reads their words and nothing else", () => {
  it.each([
    "I was not feeling good today.",
    "I wasn't feeling well today.",
    "I didn't feel well this morning.",
    "I've been a bit unwell.",
    "I was in pain last night.",
    "My back was really hurting.",
  ])("reads %j as an explicit self-report", (text) => {
    expect(readWellbeing(text).kind).toBe("self_report");
  });

  it.each([
    // Somebody else is the subject.
    "John wasn't feeling well.",
    "I hope you're not feeling unwell.",
    // A preference, not a symptom.
    "I'm not feeling like cooking tonight.",
    "I didn't feel up to the shops.",
    // Hypothetical.
    "If I feel unwell I'll call the surgery.",
    // Ordinary conversation.
    "It was good, what about you?",
    "The garden was hard work today.",
  ])("does NOT read %j as a self-report", (text) => {
    expect(readWellbeing(text).kind).toBe("none");
  });

  it("carries no severity, symptom or duration anywhere in its output", () => {
    const reading = readWellbeing("I was in a lot of pain last night.");
    expect(reading.kind).toBe("self_report");
    // The whole type is a kind and the matched fragment. There is no field
    // a clinical claim could be written into, which is the guarantee.
    expect(Object.keys(reading).sort()).toEqual(["kind", "matchedPhrase"]);
  });
});

describe("11/12/13. sharing it requires an explicit yes", () => {
  it("prepares an offer, sends nothing, and never calls a model to write it", async () => {
    const { store, deps, render } = setup();
    const outcome = await note(deps, "I was not feeling good today.");

    expect(outcome.outcome).toBe("offer_prepared");
    // Nothing has left. No grant, no request, no delivery.
    expect(store.grants).toHaveLength(0);
    expect(store.requests).toHaveLength(0);
    expect(store.delivered).toHaveLength(0);
    // And no model wrote a sentence about this person's health.
    expect(render.calls).toHaveLength(0);
    expect(store.opportunities[0].renderedText).toBe(
      "Dad said they were not feeling well. Would you be able to check in with them soon?",
    );
  });

  it("shows the exact stored bytes when the offer surfaces", async () => {
    const { store, deps } = setup();
    await note(deps, "I was not feeling good today.");

    const result = await prepareOffer(m5Deps({ store, clock: fixedClock(NOW) }).consent, {
      userId: USER,
      conversationId: "conv-1",
      recentMessages: [
        { role: "user", content: "I was not feeling good today.", createdAt: NOW.toISOString() },
      ],
    });
    expect(result.outcome).toBe("offered");
    if (result.outcome !== "offered") return;
    expect(result.renderedText).toBe(store.opportunities[0].renderedText);
    expect(result.block).toContain(result.renderedText);
    // It says whose words these are; it does not explain the person to
    // themselves with a statistic.
    expect(result.preamble).toBe("You mentioned you weren't feeling well.");
  });

  it("a decline sends nothing and creates no grant", async () => {
    const { store, deps } = setup();
    await note(deps, "I was not feeling good today.");
    const consent = m5Deps({ store, clock: fixedClock(NOW) }).consent;
    await prepareOffer(consent, {
      userId: USER,
      conversationId: "conv-1",
      recentMessages: [
        { role: "user", content: "I was not feeling good today.", createdAt: NOW.toISOString() },
      ],
    });

    const answer = await handleConsentReply(consent, {
      userId: USER,
      text: "No thanks.",
      grantingMessageId: "msg-2",
      recentMessages: afterOfferShown(store.opportunities[0].renderedText!, NOW),
    });
    expect(answer.outcome).toBe("declined");
    expect(store.grants).toHaveLength(0);
    expect(store.requests).toHaveLength(0);
    expect(store.delivered).toHaveLength(0);
  });

  it("an approval pins a grant to the exact bytes that were shown", async () => {
    const { store, deps } = setup();
    await note(deps, "I was not feeling good today.");
    const consent = m5Deps({ store, clock: fixedClock(NOW) }).consent;
    const shown = await prepareOffer(consent, {
      userId: USER,
      conversationId: "conv-1",
      recentMessages: [
        { role: "user", content: "I was not feeling good today.", createdAt: NOW.toISOString() },
      ],
    });
    expect(shown.outcome).toBe("offered");
    if (shown.outcome !== "offered") return;

    const answer = await handleConsentReply(consent, {
      userId: USER,
      text: "Yes please.",
      grantingMessageId: "msg-2",
      recentMessages: afterOfferShown(shown.renderedText, NOW),
    });
    expect(answer.outcome).toBe("approved");
    if (answer.outcome !== "approved") return;

    const grant = store.grants[0];
    // The snapshot is a COPY of what was shown, not a rebuild of it.
    expect(grant.renderedTextSnapshot).toBe(shown.renderedText);
    expect((grant.scope as { recipientEntityId: string }).recipientEntityId).toBe(DON);
  });
});

describe("the payload cannot carry anything clinical", () => {
  it("minimizes to a topic, a label and a closed question", async () => {
    const { store, deps } = setup();
    await note(deps, "I was in pain last night.");
    expect(store.opportunities[0].sharePayload).toEqual({
      fromDisplayName: "Dad",
      topic: "wellbeing",
      question: "ask_if_checking_in",
    });
  });

  it("the outbound sentence names no symptom, severity, day or cause", () => {
    const text = buildFallbackText({
      fromDisplayName: "Dad",
      topic: "wellbeing",
      question: "ask_if_checking_in",
    });
    for (const word of ["pain", "ill", "sick", "today", "very", "serious", "worried", "because"]) {
      expect(text.toLowerCase()).not.toContain(word);
    }
    expect(text).toContain("?");
  });

  it("the family member can only answer about what THEY will do", () => {
    const labels = replyChoicesFor("wellbeing").map((choice) => choice.label);
    expect(labels).toEqual([
      "Yes, I'll check in today.",
      "Yes, I'll check in soon.",
      "Not sure yet.",
      "Not just now.",
    ]);
    // No free text, and nothing that reports on the older adult's health.
    for (const label of labels) {
      expect(label.toLowerCase()).not.toMatch(/how are|better|worse|unwell|pain/);
    }
  });

  it("the verified closure reports the promise, never the health", () => {
    expect(
      renderClosureSentence({
        opportunityId: "o", familyRequestId: "r", responseId: "resp",
        entityName: "Don", topic: "wellbeing", responseIntent: "yes",
        timeframe: "today", createdAt: NOW.toISOString(),
      }),
    ).toBe("Don replied that they are planning to check in today.");
  });

  it("refuses a stored proposal that mixes the two shapes", () => {
    expect(
      ReconnectProposalSchema.safeParse({
        entityId: DON, entityName: "Don", topic: "wellbeing", eventType: "visit",
        observation: { kind: "self_reported_wellbeing", reportedOn: "2026-09-21" },
        question: "ask_if_checking_in",
      }).success,
    ).toBe(false);
    expect(
      ReconnectProposalSchema.safeParse({
        entityId: DON, entityName: "Don", topic: "wellbeing", eventType: "visit",
        observation: { kind: "no_mention_since", days: 13 },
        question: "ask_if_visiting",
      }).success,
    ).toBe(false);
    expect(
      ReconnectProposalSchema.safeParse(
        buildWellbeingProposal({ entityId: DON, entityName: "Don", reportedOn: "2026-09-21" }),
      ).success,
    ).toBe(true);
  });
});

describe("no recipient is ever guessed", () => {
  it("says nothing when no family contact is configured", async () => {
    const { store, deps } = setup({ contacts: 0 });
    expect((await note(deps, "I was not feeling good today.")).outcome).toBe("no_recipient");
    expect(store.opportunities).toHaveLength(0);
    expect(store.signals).toHaveLength(0);
  });

  it("says nothing when TWO contacts could receive it", async () => {
    const { store, deps } = setup({ contacts: 2 });
    expect((await note(deps, "I was not feeling good today.")).outcome).toBe("no_recipient");
    expect(store.opportunities).toHaveLength(0);
  });

  it("17. refuses a development-seeded entity as a recipient", async () => {
    const { store, deps } = setup({ origin: "dev" });
    const outcome = await note(deps, "I was not feeling good today.");
    // From the presentation read a `dev` row does not exist at all, which
    // is the point of filtering it in SQL rather than after (M12e.3).
    expect(outcome).toEqual({ outcome: "blocked", reason: "entity_not_presentable" });
    expect(store.opportunities).toHaveLength(0);
    expect(store.signals).toHaveLength(0);
    expect(store.delivered).toHaveLength(0);
  });
});

describe("urgent language stands every proactive path down", () => {
  it.each([
    "I have chest pain and I can't breathe.",
    "I fell and I can't get up.",
    "I think I'm having a heart attack.",
  ])("writes nothing at all for %j", async (text) => {
    const { store, deps } = setup();
    expect((await note(deps, text)).outcome).toBe("urgent_stood_down");
    expect(store.signals).toHaveLength(0);
    expect(store.opportunities).toHaveLength(0);
    expect(store.delivered).toHaveLength(0);
  });

  it("is a routing decision, not a score: nothing is ranked or escalated", () => {
    const reading = readWellbeing("I have chest pain.");
    expect(reading.kind).toBe("urgent");
    expect(Object.keys(reading).sort()).toEqual(["kind", "matchedPhrase"]);
  });
});

describe("it fires once per message, whatever retries the runtime does", () => {
  it("a repeated sweep over the same message writes nothing new", async () => {
    const { store, deps } = setup();
    const first = await note(deps, "I was not feeling good today.");
    const second = await note(deps, "I was not feeling good today.");
    expect(first.outcome).toBe("offer_prepared");
    expect(second.outcome).toBe("already_recorded");
    expect(store.signals).toHaveLength(1);
    expect(store.opportunities).toHaveLength(1);
  });
});
