import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Chat, type ChatMessage } from "@/app/_components/chat";

/**
 * The person is told WHY a reconnect offer appeared.
 *
 * The reason is a sentence the server decided, streamed as a field, and
 * rendered in the bubble above the card. It is deliberately not part of the
 * offer block: the block is the byte-exact draft the card draws and the
 * transcript strips, and folding an explanation into it would make the reason
 * invisible and change the string consent attaches to.
 */
const DRAFT = "Dad was wondering — are you and Simba able to visit soon?";
const BLOCK = `I can send John this message:\n\n${DRAFT}\n\nWould you like me to send it?`;
const REASON = "You usually see John about once a week, and it's been 13 days.";

const offerEvent = (preamble: string | null) => ({
  type: "offer",
  opportunityId: "opp-1",
  entityName: "John",
  renderedText: DRAFT,
  block: BLOCK,
  preamble,
});

function stubChat(events: unknown[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(events.map((e) => `${JSON.stringify(e)}\n`).join(""), {
          status: 200,
          headers: { "X-Conversation-Id": "conv-1" },
        }),
    ),
  );
}

/** Byte-exact: the newlines between the reply and the reason are the point. */
const exactly = (text: string) => screen.getByText(text, { normalizer: (value) => value });

const send = async (text: string) => {
  fireEvent.change(screen.getByLabelText(/write a message/i), { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: /^send/i }));
};

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe("1. a cadence offer arrives with its reason", () => {
  it("shows the reason in the bubble, above the card", async () => {
    stubChat([{ type: "delta", text: "That's good to hear." }, offerEvent(REASON)]);
    render(<Chat initialConversationId="conv-1" initialMessages={[]} />);
    await send("good and u");

    await waitFor(() => expect(screen.getByText(new RegExp(REASON.slice(0, 30)))).toBeTruthy());
    // The model's words and the reason are one bubble; the draft is the card.
    expect(exactly(`That's good to hear.\n\n${REASON}`)).toBeTruthy();
  });

  it("still prints the draft exactly once, in the card", async () => {
    stubChat([{ type: "delta", text: "That's good to hear." }, offerEvent(REASON)]);
    render(<Chat initialConversationId="conv-1" initialMessages={[]} />);
    await send("good and u");

    await waitFor(() => expect(screen.getAllByText(DRAFT).length).toBe(1));
    // "I can send John this message:" belongs to the card's own label, not to
    // a second copy of the block sitting in the bubble.
    expect(screen.queryByText(new RegExp(`I can send John this message`))).toBeNull();
  });

  it("does not claim a rhythm the server did not send", async () => {
    stubChat([{ type: "delta", text: "That's good to hear." }, offerEvent(null)]);
    render(<Chat initialConversationId="conv-1" initialMessages={[]} />);
    await send("I haven't seen John this week");

    await waitFor(() => expect(screen.getByText("That's good to hear.")).toBeTruthy());
    expect(document.body.textContent).not.toMatch(/usually/i);
  });
});

describe("2. a reloaded transcript reads identically to the live turn", () => {
  /**
   * The persisted assistant message is `model \n\n reason \n\n block`. On
   * reload the client strips the block it is drawing as a card, which must
   * leave exactly the string the live turn built by appending the reason.
   * If these two ever diverge, refreshing the page changes what CareLoop
   * appears to have said.
   */
  it("strips only the block and keeps the reason", () => {
    const persisted: ChatMessage[] = [
      { id: "m1", role: "user", content: "good and u" },
      {
        id: "m2",
        role: "assistant",
        content: `That's good to hear.\n\n${REASON}\n\n${BLOCK}`,
      },
    ];
    render(
      <Chat
        initialConversationId="conv-1"
        initialMessages={persisted}
        initialPendingOffer={{
          opportunityId: "opp-1",
          entityName: "John",
          state: "offered",
          renderedText: DRAFT,
          block: BLOCK,
        }}
      />,
    );
    expect(exactly(`That's good to hear.\n\n${REASON}`)).toBeTruthy();
    expect(screen.getAllByText(DRAFT).length).toBe(1);
  });
});
