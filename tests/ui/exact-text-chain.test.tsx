import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fixedClock } from "@/server/adapters/clock";
import { handleConsentReply, prepareOffer } from "@/server/services/consent";
import { sendApprovedOpportunity } from "@/server/services/family-send";
import { loadFamilyView } from "@/server/services/family-response";
// The adapter directly, not `server/services/dev-tools`: that module is
// `server-only` and cannot be imported into a jsdom run. The service is a
// one-line pass-through over exactly these functions, and the boundary itself
// is asserted in tests/unit/dev-family-inbox.test.ts.
import { clearDevInbox, createDevNotifier, readDevInbox } from "@/server/adapters/notifier";
import { sha256Hex } from "@/core/share/text-hash";
import { renderFamilyEmail } from "@/core/family/email";
import { Chat, type PendingOffer } from "@/app/_components/chat";
import { createStore, resetIds } from "../unit/detection-fakes";
import { m5Deps, resetM5Ids, withM5, type M5Store , conversationUnderway} from "../unit/consent-fakes";

/**
 * THE CHAIN. The strongest claim this project makes.
 *
 * A sentence about somebody's family is written once, shown to the person it
 * belongs to, approved by them, and delivered. Between the approval and the
 * family member's screen there is no model, no template, no normalisation and
 * no trim - so what John reads is what George read, to the byte.
 *
 * Six places now hold that sentence, and this test walks all six in one run:
 * the stored opportunity, the reconnect card George actually sees rendered,
 * the consent snapshot taken at approval, the family_request body, the demo
 * inbox, and the family response page. Each link was tested somewhere before;
 * the two ends were not, and a chain is only as good as the link nobody
 * checked.
 *
 * The text is deliberately awkward - em dash, curly apostrophe, a trailing
 * space, an emoji - because every one of those is something a well-meaning
 * "tidy up the string" would change.
 */
const NOW = new Date("2026-09-16T12:00:00.000Z");
const USER = "user-1";
const JOHN = "entity-john";
/** Every character a well-meaning "tidy up" would change, plus HTML's four. */
const TEXT = 'Dad was wondering — are you & Simba able to "visit" soon? <3 ☕ ';
const HASH = sha256Hex(TEXT);

function seed(): M5Store {
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
    proposal: {
      entityId: JOHN, entityName: "John", eventType: "visit",
      observation: { kind: "no_mention_since", days: 13 },
      pattern: { medianGapDays: 7 }, question: "ask_if_visiting",
      transcriptNote: "private",
    },
    sharePayload: { fromDisplayName: "Dad", topic: "visit", question: "ask_if_visiting" },
    renderedText: TEXT,
    renderedTextHash: HASH,
    status: "drafted",
    offeredAt: null,
    resolvedAt: null,
    expiresAt: new Date(NOW.getTime() + 86_400_000).toISOString(),
    createdAt: NOW.toISOString(),
  });
  return store;
}

beforeEach(() => {
  resetIds();
  resetM5Ids();
  clearDevInbox();
  vi.stubEnv("NODE_ENV", "development");
});

afterEach(() => {
  vi.unstubAllEnvs();
  clearDevInbox();
});

describe("one sentence, six surfaces, zero edits", () => {
  it("carries the same bytes from the draft to the family member's screen", async () => {
    const store = seed();
    // The REAL development notifier, not a fake: the demo inbox is the surface
    // under test, so a stand-in for it would test nothing.
    const d = m5Deps({
      store,
      clock: fixedClock(NOW),
      notifier: createDevNotifier({ NODE_ENV: "development" }),
    });

    // 1. stored -> offered
    const offer = await prepareOffer(d.consent, { userId: USER, conversationId: "conv-1", recentMessages: conversationUnderway(NOW) });
    if (offer.outcome !== "offered") throw new Error("expected an offer");
    const stored = store.opportunities[0].renderedText!;

    // 2. the reconnect card George sees - rendered, not described.
    const pending: PendingOffer = {
      opportunityId: offer.opportunityId,
      entityName: offer.entityName,
      state: "offered",
      renderedText: offer.renderedText,
      block: offer.block,
    };
    vi.stubGlobal("MediaRecorder", class {});
    vi.stubGlobal("navigator", {
      mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }) },
    });
    const card = render(
      <Chat initialConversationId="c" initialMessages={[]} initialPendingOffer={pending} />,
    );
    // The default matcher collapses whitespace, which would hide exactly the
    // kind of edit this test exists to catch. Identity normalizer: the bytes
    // in the DOM or nothing.
    const cardText = screen.getByText(TEXT, { normalizer: (value) => value }).textContent!;
    card.unmount();

    // 3. approval snapshot
    await handleConsentReply(d.consent, {
      userId: USER, text: "yes", grantingMessageId: "msg-1",
    });
    const snapshot = store.grants[0].renderedTextSnapshot;

    // 4. the family_request body
    const sent = await sendApprovedOpportunity(d.send, { userId: USER, opportunityId: "opp-1" });
    expect(sent.outcome).toBe("sent");
    const requestBody = store.requests[0].renderedBody;

    // 5. the demo inbox
    const inbox = readDevInbox();
    expect(inbox).toHaveLength(1);
    const inboxBody = inbox[0].body;

    // 6. the family response page
    const url = inbox[0].responseUrl;
    const view = await loadFamilyView(d.family, url.slice(url.lastIndexOf("/") + 1));
    if (view.outcome !== "ok") throw new Error(`expected ok, got ${view.outcome}`);
    const familyMessage = view.message;

    // 7. the email the transport would send
    const email = renderFamilyEmail({
      body: inboxBody,
      responseUrl: url,
      fromDisplayName: "Dad",
    });
    // The text part carries the bytes as they are. The HTML part escapes, and
    // is compared by what a mail client would DISPLAY - escaping is the one
    // transformation permitted, and only at this boundary.
    const emailText = email.textContent;
    const emailDisplayed = email.htmlContent
      .replace(/<[^>]*>/g, "")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'");

    expect(emailText, "the email's text part altered the approved bytes").toContain(TEXT);
    expect(emailDisplayed, "the email's HTML would display altered text").toContain(TEXT);
    // Escaped in the markup, so the body cannot inject anything.
    expect(email.htmlContent).toContain("&lt;3");
    expect(email.htmlContent).not.toContain("<3");

    // Identity, not similarity. `toBe` on strings is byte equality.
    for (const [name, value] of [
      ["stored", stored],
      ["reconnect card", cardText],
      ["consent snapshot", snapshot],
      ["family_request body", requestBody],
      ["dev inbox", inboxBody],
      ["family page", familyMessage],
    ] as const) {
      expect(value, `${name} differs from the approved text`).toBe(TEXT);
      expect(sha256Hex(value), `${name} hash`).toBe(HASH);
    }

    // The specific edits a helpful hand makes, each one checked for.
    expect(inboxBody.endsWith(" "), "a trailing space was trimmed").toBe(true);
    expect(familyMessage).toContain("—");
    expect(familyMessage).toContain("☕");
    expect(familyMessage.normalize("NFC")).toBe(familyMessage);
  });

  it("no model is consulted anywhere after the approval", async () => {
    const store = seed();
    const llm = vi.fn();
    const d = m5Deps({
      store,
      clock: fixedClock(NOW),
      notifier: createDevNotifier({ NODE_ENV: "development" }),
    });
    // Any provider reachable from the send path would show up here.
    (d.send as unknown as { familyRender?: unknown }).familyRender = { render: llm };

    await prepareOffer(d.consent, { userId: USER, conversationId: "conv-1", recentMessages: conversationUnderway(NOW) });
    await handleConsentReply(d.consent, {
      userId: USER, text: "yes", grantingMessageId: "msg-1",
    });
    await sendApprovedOpportunity(d.send, { userId: USER, opportunityId: "opp-1" });

    expect(llm).not.toHaveBeenCalled();
    expect(readDevInbox()[0].body).toBe(TEXT);
  });

  it("two requests stay separate, and neither borrows the other's link", async () => {
    const store = seed();
    store.opportunities.push({
      ...store.opportunities[0],
      id: "opp-2",
      entityId: JOHN,
      renderedText: "A different sentence entirely?",
      renderedTextHash: sha256Hex("A different sentence entirely?"),
    });
    const d = m5Deps({
      store,
      clock: fixedClock(NOW),
      notifier: createDevNotifier({ NODE_ENV: "development" }),
    });

    for (const id of ["opp-1", "opp-2"]) {
      await prepareOffer(d.consent, { userId: USER, conversationId: "conv-1", recentMessages: conversationUnderway(NOW) });
      await handleConsentReply(d.consent, {
        userId: USER, text: "yes", grantingMessageId: `msg-${id}`,
      });
      await sendApprovedOpportunity(d.send, { userId: USER, opportunityId: id });
    }

    const inbox = readDevInbox();
    expect(inbox).toHaveLength(2);
    // Distinct bodies, distinct capability URLs, distinct requests.
    expect(new Set(inbox.map((m) => m.body)).size).toBe(2);
    expect(new Set(inbox.map((m) => m.responseUrl)).size).toBe(2);
    expect(new Set(inbox.map((m) => m.requestId)).size).toBe(2);
  });
});
