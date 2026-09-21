import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Chat, type ChatMessage, type PendingOffer } from "@/app/_components/chat";

/**
 * The chat surface.
 *
 * What these tests are really defending is the boundary in section 18 of the
 * milestone: the browser renders state the server decided and sends the user's
 * actions back. It does not decide whether an offer may be shown, what the
 * outbound sentence says, or whether a "yes" counts. Several of the assertions
 * below look like UI checks and are actually that boundary, written down.
 */
const DRAFT = "Dad was wondering — are you and Simba able to visit soon?";

const OFFER: PendingOffer = {
  opportunityId: "opp-1",
  entityName: "John",
  state: "offered",
  renderedText: DRAFT,
  block: `I can send John this message:\n\n${DRAFT}\n\nWould you like me to send it?`,
};

/** A chat route that replies with newline-delimited turn events. */
function stubChat(events: unknown[], options: { conversationId?: string } = {}) {
  const calls: Array<{ text: string; conversationId?: string }> = [];
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    calls.push(JSON.parse(String(init?.body)));
    const body = events.map((event) => `${JSON.stringify(event)}\n`).join("");
    return new Response(body, {
      status: 200,
      headers: { "X-Conversation-Id": options.conversationId ?? "conv-1" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls, fetchMock };
}

const type = (text: string) => {
  fireEvent.change(screen.getByLabelText(/write a message/i), { target: { value: text } });
};

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe("1. the transcript", () => {
  const history: ChatMessage[] = [
    { id: "m1", role: "user", content: "Morning." },
    { id: "m2", role: "assistant", content: "Good morning. How did you sleep?" },
  ];

  it("renders the messages it was given", () => {
    render(<Chat initialConversationId="conv-1" initialMessages={history} />);
    expect(screen.getByText("Morning.")).toBeTruthy();
    expect(screen.getByText("Good morning. How did you sleep?")).toBeTruthy();
  });

  it("greets by name only when the server supplied one", () => {
    const { unmount } = render(
      <Chat initialConversationId={null} initialMessages={[]} displayName="George" />,
    );
    expect(screen.getByText("Hello, George")).toBeTruthy();
    unmount();

    render(<Chat initialConversationId={null} initialMessages={[]} displayName={null} />);
    expect(screen.queryByText(/^Hello,/)).toBeNull();
  });

  it("renders a historical message that still carries the old plain-text offer", () => {
    // Messages persisted before the card existed keep their appended block.
    // Nothing migrates them, so they must simply render as the text they are.
    const legacy: ChatMessage[] = [
      { id: "m9", role: "assistant", content: `Of course.\n\n${OFFER.block}` },
    ];
    render(<Chat initialConversationId="conv-1" initialMessages={legacy} />);
    expect(screen.getByText(/I can send John this message:/)).toBeTruthy();
    expect(screen.getByText(new RegExp(DRAFT.slice(0, 30)))).toBeTruthy();
  });
});

describe("2. sending a message", () => {
  it("shows the person's words, then the streamed reply", async () => {
    stubChat([
      { type: "delta", text: "That sounds " },
      { type: "delta", text: "lovely." },
    ]);
    render(<Chat initialConversationId="conv-1" initialMessages={[]} />);

    type("We had tea in the garden.");
    fireEvent.click(screen.getByRole("button", { name: /send/i }));

    expect(screen.getByText("We had tea in the garden.")).toBeTruthy();
    await waitFor(() => expect(screen.getByText("That sounds lovely.")).toBeTruthy());
  });

  it("disables the composer while the turn is in flight", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        await gate;
        return new Response(`${JSON.stringify({ type: "delta", text: "ok" })}\n`, {
          status: 200,
          headers: { "X-Conversation-Id": "conv-1" },
        });
      }),
    );

    render(<Chat initialConversationId="conv-1" initialMessages={[]} />);
    type("hello");
    fireEvent.click(screen.getByRole("button", { name: /send/i }));

    await waitFor(() =>
      expect((screen.getByLabelText(/write a message/i) as HTMLTextAreaElement).disabled).toBe(true),
    );
    release();
    await waitFor(() =>
      expect((screen.getByLabelText(/write a message/i) as HTMLTextAreaElement).disabled).toBe(false),
    );
  });

  it("refuses to send an empty message", () => {
    const { fetchMock } = stubChat([{ type: "delta", text: "hi" }]);
    render(<Chat initialConversationId="conv-1" initialMessages={[]} />);
    const button = screen.getByRole("button", { name: /send/i }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows a friendly error and drops the partial bubble when the turn fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 502 })));
    render(<Chat initialConversationId="conv-1" initialMessages={[]} />);

    type("hello");
    fireEvent.click(screen.getByRole("button", { name: /send/i }));

    const alert = await screen.findByRole("alert");
    // Sharpened in M12d: "couldn't send that just now" left it ambiguous
    // whether the family message had gone. The application KNOWS it did
    // not — nothing was persisted — so it says so, and says the words are
    // still there to try again with.
    expect(alert.textContent).toContain("hasn't been sent");
    expect(alert.textContent).toContain("try again");
    // Nothing technical reaches the person.
    expect(alert.textContent).not.toMatch(/502|Error|fetch|stack/i);
  });
});

describe("3. the reconnect card", () => {
  it("renders the exact stored draft from the offer event", async () => {
    stubChat([
      { type: "delta", text: "Of course." },
      { type: "offer", ...OFFER, state: undefined },
    ]);
    render(<Chat initialConversationId="conv-1" initialMessages={[]} />);

    type("I haven't seen John this week.");
    fireEvent.click(screen.getByRole("button", { name: /^send$/i }));

    const card = await screen.findByText(/Reconnect with John/i);
    const region = card.closest("div")!.parentElement!;
    // Byte-for-byte the server's text. Not a paraphrase, not a reflow.
    expect(within(region).getByText(DRAFT)).toBeTruthy();
  });

  it("renders from server-supplied state on a reload, not from the transcript", () => {
    render(
      <Chat
        initialConversationId="conv-1"
        initialMessages={[{ id: "m1", role: "assistant", content: `Of course.\n\n${OFFER.block}` }]}
        initialPendingOffer={OFFER}
      />,
    );
    expect(screen.getByText(/Reconnect with John/i)).toBeTruthy();
    expect(screen.getByText(DRAFT)).toBeTruthy();
    // And the draft is not ALSO printed as a paragraph inside the bubble.
    expect(screen.queryByText(/I can send John this message:/)).toBeNull();
    expect(screen.getByText("Of course.")).toBeTruthy();
  });

  it("never reconstructs the draft — the card shows only what it was handed", async () => {
    // The payload fields the fallback would be built from are deliberately
    // absent from the client's world. If the card could compose a sentence,
    // this test would be the place it showed up.
    stubChat([{ type: "delta", text: "Of course." }, { type: "offer", ...OFFER, state: undefined }]);
    render(<Chat initialConversationId="conv-1" initialMessages={[]} />);
    type("I haven't seen John this week.");
    fireEvent.click(screen.getByRole("button", { name: /^send$/i }));

    await screen.findByText(/Reconnect with John/i);
    const source = (await import("node:fs")).readFileSync("app/_components/chat.tsx", "utf8");
    for (const forbidden of ["was wondering", "able to visit", "ask_if_visiting", "fromDisplayName"]) {
      expect(source, forbidden).not.toContain(forbidden);
    }
  });
});

describe("4. consent buttons are the typed answer, by another route", () => {
  async function offered() {
    stubChat([{ type: "delta", text: "Of course." }, { type: "offer", ...OFFER, state: undefined }]);
    render(<Chat initialConversationId="conv-1" initialMessages={[]} />);
    type("I haven't seen John this week.");
    fireEvent.click(screen.getByRole("button", { name: /^send$/i }));
    await screen.findByText(/Reconnect with John/i);
  }

  it("Send message submits the explicit approval phrase, once", async () => {
    await offered();
    const { calls, fetchMock } = stubChat([{ type: "delta", text: "Thank you — I'll send that to John now." }]);

    fireEvent.click(screen.getByRole("button", { name: /send message/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    // The same words a person would type, down the same endpoint, into the
    // same deterministic parser. No button-only consent path.
    expect(calls[0].text).toBe("yes");
  });

  it("Not now submits the explicit refusal phrase, once", async () => {
    await offered();
    const { calls, fetchMock } = stubChat([{ type: "delta", text: "No problem. I won't send it." }]);

    fireEvent.click(screen.getByRole("button", { name: /not now/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(calls[0].text).toBe("no");
  });

  it("a double click cannot produce a second request", async () => {
    await offered();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchMock = vi.fn(async () => {
      await gate;
      return new Response(`${JSON.stringify({ type: "delta", text: "ok" })}\n`, {
        status: 200,
        headers: { "X-Conversation-Id": "conv-1" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const button = screen.getByRole("button", { name: /send message/i });
    fireEvent.click(button);
    fireEvent.click(button);
    fireEvent.click(button);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(true));
    release();
  });

  it("both controls disable while either is pending", async () => {
    await offered();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        await gate;
        return new Response(`${JSON.stringify({ type: "delta", text: "ok" })}\n`, {
          status: 200,
          headers: { "X-Conversation-Id": "conv-1" },
        });
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: /send message/i }));
    await waitFor(() =>
      expect((screen.getByRole("button", { name: /not now/i }) as HTMLButtonElement).disabled).toBe(
        true,
      ),
    );
    release();
  });

  it("after approval the card is in flight, with no actions and no delivery claim", async () => {
    await offered();
    // The server's closing word on the turn: still open, now `sending`.
    stubChat([
      { type: "delta", text: "Thank you — I'll send that to John now." },
      {
        type: "state",
        pendingOffer: { ...OFFER, state: "sending" },
      },
    ]);

    fireEvent.click(screen.getByRole("button", { name: /send message/i }));

    const inFlight = await screen.findByText(/sending to John now/i);
    expect(inFlight).toBeTruthy();
    // Delivery happens after the reply is flushed (M5), so no claim that it
    // has already arrived.
    expect(screen.queryByText(/message sent to john/i)).toBeNull();
    expect(screen.queryByText(/on its way/i)).toBeNull();
    // And nothing left to press.
    expect(screen.queryByRole("button", { name: /send message/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /not now/i })).toBeNull();
  });

  it("declining retires the card, because the server says there is none", async () => {
    await offered();
    stubChat([
      { type: "delta", text: "No problem. I won't send it." },
      { type: "state", pendingOffer: null },
    ]);

    fireEvent.click(screen.getByRole("button", { name: /not now/i }));

    await waitFor(() => expect(screen.queryByText(/Reconnect with John/i)).toBeNull());
    expect(screen.queryByRole("button", { name: /send message/i })).toBeNull();
  });
});

describe("4b. the card never outlives the state it describes", () => {
  /**
   * The lifecycle bug live acceptance found.
   *
   * After the family member replied and the closure was surfaced, the card was
   * still on screen saying "Approved — on its way to John" — about a message
   * John had already received and answered. The terminal state lived in the
   * CLIENT, where nothing could correct it.
   *
   * It is the server's to say now: every turn ends with a `state` event, and
   * the browser replaces whatever it was showing with exactly that. These
   * tests are that contract.
   */
  async function offeredCard() {
    stubChat([{ type: "delta", text: "Of course." }, { type: "offer", ...OFFER, state: undefined }]);
    render(<Chat initialConversationId="conv-1" initialMessages={[]} />);
    type("I haven't seen John this week.");
    fireEvent.click(screen.getByRole("button", { name: /^send$/i }));
    await screen.findByText(/Reconnect with John/i);
  }

  it("a closure turn retires the card in the same breath as the news", async () => {
    await offeredCard();
    stubChat([
      { type: "closure", sentence: "John replied that they are planning to visit this weekend." },
      { type: "delta", text: "That's good news." },
      { type: "state", pendingOffer: null },
    ]);

    type("Any news?");
    fireEvent.click(screen.getByRole("button", { name: /^send$/i }));

    await waitFor(() => expect(screen.getByText("Update")).toBeTruthy());
    // The reply arrived AND the stale card went, in one turn.
    expect(screen.queryByText(/Reconnect with John/i)).toBeNull();
    expect(screen.queryByText(/on its way/i)).toBeNull();
  });

  it("ordinary later turns do not resurrect a completed reconnect", async () => {
    await offeredCard();
    for (const [message, reply] of [
      ["thanks", "Any time."],
      ["Do you remember Simba?", "Yes — Simba is John's dog."],
    ] as const) {
      stubChat([{ type: "delta", text: reply }, { type: "state", pendingOffer: null }]);
      type(message);
      fireEvent.click(screen.getByRole("button", { name: /^send$/i }));
      await waitFor(() => expect(screen.getByText(reply)).toBeTruthy());
      expect(screen.queryByText(/Reconnect with John/i), message).toBeNull();
    }
  });

  it("a reload after the loop closed shows no card, because the server sends none", () => {
    // The transcript still holds the offer block — history is never rewritten
    // — and that alone must not put a card back on screen.
    render(
      <Chat
        initialConversationId="conv-1"
        initialMessages={[
          { id: "m1", role: "assistant", content: `Of course.\n\n${OFFER.block}` },
          { id: "m2", role: "user", content: "yes" },
          { id: "m3", role: "assistant", content: "Thank you — I'll send that to John now." },
        ]}
        initialPendingOffer={null}
      />,
    );
    expect(screen.queryByText(/Reconnect with John/i)).toBeNull();
    // And the history still renders, unchanged.
    expect(screen.getByText(/I can send John this message:/)).toBeTruthy();
  });

  it("declined and expired arrive as no card at all", () => {
    // Neither status is open, so the read model returns null and there is
    // nothing for the client to decide.
    render(
      <Chat initialConversationId="conv-1" initialMessages={[]} initialPendingOffer={null} />,
    );
    expect(screen.queryByText(/Reconnect with/i)).toBeNull();
  });

  it("an in-flight card served on reload has no actions", () => {
    render(
      <Chat
        initialConversationId="conv-1"
        initialMessages={[]}
        initialPendingOffer={{ ...OFFER, state: "sending" }}
      />,
    );
    expect(screen.getByText(/Reconnect with John/i)).toBeTruthy();
    expect(screen.getByText(/sending to John now/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /send message/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /not now/i })).toBeNull();
  });

  it("the client decides nothing about lifecycle — it has no vocabulary for it", async () => {
    const raw = (await import("node:fs")).readFileSync("app/_components/chat.tsx", "utf8");
    // Comments explain; they do not execute. Only executable text is policy.
    const source = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    // No client-held terminal state, and no vocabulary for inferring one.
    expect(source).not.toContain("offerResolved");
    for (const inferred of ["replied", "already sent", "delivered", "answered"]) {
      expect(source, inferred).not.toContain(inferred);
    }
    // The card's only lifecycle input is the server's own field.
    expect(source).toContain('offer.state === "offered"');
  });
});

describe("5. a family reply, shown as an update", () => {
  it("renders the closure sentence as its own surface, above the reply", async () => {
    stubChat([
      { type: "closure", sentence: "John replied that they are planning to visit this weekend." },
      { type: "delta", text: "That's good news." },
    ]);
    render(<Chat initialConversationId="conv-1" initialMessages={[]} />);

    type("Any news?");
    fireEvent.click(screen.getByRole("button", { name: /^send$/i }));

    await waitFor(() => expect(screen.getByText("Update")).toBeTruthy());
    expect(
      screen.getByText("John replied that they are planning to visit this weekend."),
    ).toBeTruthy();
    expect(screen.getByText("That's good news.")).toBeTruthy();
    // Calm, not an alarm: no alert role on ordinary good news.
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("6. development-only controls", () => {
  it("are rendered only when the server decided this is development", async () => {
    const page = (await import("node:fs")).readFileSync("app/page.tsx", "utf8");
    // The decision is made on the server, in the page, and passed down as a
    // node. The client component has no say and no env check of its own.
    expect(page).toContain("const isDev = isDebugSurfaceEnabled(process.env);");
    expect(page).toMatch(/devTools=\{\s*isDev \?/);
    expect(page).toContain("<DemoResetButton");
    // The family-inbox link is gated by the same single decision.
    expect(page).toContain("<FamilyInboxLink />");
    expect(page).toMatch(/demoHint=\{isDev \? <DemoHint/);

    const chat = (await import("node:fs")).readFileSync("app/_components/chat.tsx", "utf8");
    expect(chat).not.toContain("NODE_ENV");
    expect(chat).not.toContain("isDebugSurfaceEnabled");
  });

  it("no secret can reach the browser through them", async () => {
    const fs = await import("node:fs");
    for (const file of ["app/_components/dev-tools.tsx", "app/_components/chat.tsx", "app/page.tsx"]) {
      const source = fs.readFileSync(file, "utf8");
      expect(source, file).not.toContain("CARELOOP_DEV_SEED_SECRET");
      expect(source, file).not.toContain("x-careloop-dev-secret");
      // And no NEXT_PUBLIC_ escape hatch invented for convenience.
      expect(source, file).not.toContain("NEXT_PUBLIC_CARELOOP");
    }
    // The action holds the secret, and runs on the server.
    const action = fs.readFileSync("app/_actions/demo.ts", "utf8");
    expect(action.startsWith('"use server";')).toBe(true);
    expect(action).toContain("CARELOOP_DEV_SEED_SECRET");
  });

  it("the reset control does not render when the page passes nothing", () => {
    render(<Chat initialConversationId={null} initialMessages={[]} />);
    expect(screen.queryByRole("button", { name: /reset demo/i })).toBeNull();
    expect(screen.queryByText(/try saying/i)).toBeNull();
  });

  it("the hint appears above an empty chat when development passes it", () => {
    render(
      <Chat
        initialConversationId={null}
        initialMessages={[]}
        demoHint={<p>Try saying: something.</p>}
      />,
    );
    expect(screen.getByText(/try saying/i)).toBeTruthy();
  });
});

describe("7. accessibility basics", () => {
  it("the composer is labelled and the controls are real buttons", () => {
    render(<Chat initialConversationId={null} initialMessages={[]} />);
    expect(screen.getByLabelText(/write a message/i).tagName).toBe("TEXTAREA");
    expect(screen.getByRole("button", { name: /send/i }).getAttribute("type")).toBe("submit");
  });

  it("the transcript is a polite live region, not an assertive one", () => {
    const { container } = render(
      <Chat initialConversationId="c" initialMessages={[{ id: "m", role: "assistant", content: "hi" }]} />,
    );
    const live = container.querySelector("[aria-live]")!;
    // Assertive would interrupt a screen reader mid-sentence on every delta.
    expect(live.getAttribute("aria-live")).toBe("polite");
  });

  it("a pending button reports itself as busy, not merely greyed", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        await gate;
        return new Response(`${JSON.stringify({ type: "delta", text: "ok" })}\n`, {
          status: 200,
          headers: { "X-Conversation-Id": "c" },
        });
      }),
    );
    render(<Chat initialConversationId="c" initialMessages={[]} />);
    type("hello");
    fireEvent.click(screen.getByRole("button", { name: /send/i }));

    await waitFor(() => {
      const button = screen.getByRole("button", { name: /sending/i });
      expect(button.getAttribute("aria-busy")).toBe("true");
    });
    release();
  });

  it("the typing indicator is decorative and hidden from assistive tech", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        await gate;
        return new Response(`${JSON.stringify({ type: "delta", text: "ok" })}\n`, {
          status: 200,
          headers: { "X-Conversation-Id": "c" },
        });
      }),
    );
    const { container } = render(<Chat initialConversationId="c" initialMessages={[]} />);
    type("hello");
    fireEvent.click(screen.getByRole("button", { name: /send/i }));

    await waitFor(() => expect(container.querySelector('[aria-hidden="true"]')).toBeTruthy());
    release();
  });

  it("Enter sends and Shift+Enter does not", async () => {
    const { fetchMock } = stubChat([{ type: "delta", text: "ok" }]);
    render(<Chat initialConversationId="c" initialMessages={[]} />);
    const box = screen.getByLabelText(/write a message/i);

    type("hello");
    fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.keyDown(box, { key: "Enter" });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  });
});
