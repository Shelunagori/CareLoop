import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Chat, type ChatMessage } from "@/app/_components/chat";

/**
 * The opening a person sees, and the one line telling them what is going on.
 *
 * Two small surfaces with the same job: an older adult should be able to
 * tell, without reading carefully, whether CareLoop is listening and
 * whether it has said something to them.
 */
const OPENING = "How did the visit with Margaret go yesterday?";

function stubBrowser() {
  class FakeRecorder {
    static isTypeSupported = (t: string) => t === "audio/webm;codecs=opus";
    state: "inactive" | "recording" = "inactive";
    mimeType = "audio/webm;codecs=opus";
    ondataavailable: ((e: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;
    start() { this.state = "recording"; }
    stop() {
      this.state = "inactive";
      this.ondataavailable?.({ data: new Blob([new Uint8Array(4096)]) });
      this.onstop?.();
    }
  }
  vi.stubGlobal("MediaRecorder", FakeRecorder);
  vi.stubGlobal("navigator", {
    mediaDevices: { async getUserMedia() { return { getTracks: () => [{ stop: () => {} }] }; } },
  });
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url === "/api/voice/transcribe") {
      return new Response(JSON.stringify({ text: "it went well" }), { status: 200 });
    }
    const events = [
      { type: "delta", text: "I'm glad." },
      { type: "state", pendingOffer: null, messageId: null },
    ];
    return new Response(events.map((e) => `${JSON.stringify(e)}\n`).join(""), {
      status: 200,
      headers: { "X-Conversation-Id": "conv-1" },
    });
  }));
}

beforeEach(() => {
  window.sessionStorage.clear();
  stubBrowser();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("1. the proactive opening", () => {
  it("is shown when the server supplied one", () => {
    render(<Chat initialConversationId="c" initialMessages={[]} openingLine={OPENING} />);
    expect(screen.getByText(OPENING)).toBeTruthy();
  });

  it("is absent when the server supplied none — a normal start", () => {
    render(<Chat initialConversationId="c" initialMessages={[]} openingLine={null} />);
    expect(screen.queryByText(/how did the visit/i)).toBeNull();
    // And nothing generic takes its place.
    expect(document.body.textContent).not.toMatch(/good morning|how are you today/i);
  });

  it("is absent when the conversation already has messages", () => {
    const history: ChatMessage[] = [{ id: "m1", role: "user", content: "hello" }];
    render(<Chat initialConversationId="c" initialMessages={history} openingLine={OPENING} />);
    expect(screen.queryByText(OPENING)).toBeNull();
  });

  it("disappears the moment they say anything", async () => {
    render(<Chat initialConversationId="c" initialMessages={[]} openingLine={OPENING} />);
    fireEvent.change(screen.getByLabelText(/write a message/i), { target: { value: "it was lovely" } });
    fireEvent.click(screen.getByRole("button", { name: /^send$/i }));
    await waitFor(() => expect(screen.queryByText(OPENING)).toBeNull());
  });

  it("is not shown twice in one browser session", () => {
    const { unmount } = render(
      <Chat initialConversationId="c" initialMessages={[]} openingLine={OPENING} />,
    );
    expect(screen.getByText(OPENING)).toBeTruthy();
    unmount();

    render(<Chat initialConversationId="c" initialMessages={[]} openingLine={OPENING} />);
    expect(screen.queryByText(OPENING)).toBeNull();
  });

  it("a different opening in a later session is shown again", () => {
    const { unmount } = render(
      <Chat initialConversationId="c" initialMessages={[]} openingLine={OPENING} />,
    );
    unmount();
    const other = "How was your call with Alan yesterday?";
    render(<Chat initialConversationId="c" initialMessages={[]} openingLine={other} />);
    expect(screen.getByText(other)).toBeTruthy();
  });
});

describe("2. one dominant voice state, in plain words", () => {
  const headline = (text: RegExp) => screen.getByText(text, { selector: "p" });

  it("says nothing at all when nothing is happening", () => {
    render(<Chat initialConversationId="c" initialMessages={[]} />);
    // No panel: an empty state announced loudly is still noise.
    expect(screen.queryByText(/^Listening$/)).toBeNull();
    expect(screen.queryByText(/Working out what you said/)).toBeNull();
  });

  it("says Listening, once, while the microphone is open", async () => {
    render(<Chat initialConversationId="c" initialMessages={[]} />);
    fireEvent.click(screen.getByRole("button", { name: /start voice input/i }));

    await waitFor(() => expect(headline(/^Listening$/)).toBeTruthy());
    expect(screen.getAllByText(/^Listening$/).length).toBe(1);
  });

  it("says Working out what you said, then Message ready", async () => {
    render(<Chat initialConversationId="c" initialMessages={[]} />);
    fireEvent.click(screen.getByRole("button", { name: /start voice input/i }));
    fireEvent.click(await screen.findByRole("button", { name: /stop recording/i }));

    await waitFor(() =>
      expect((screen.getByLabelText(/write a message/i) as HTMLTextAreaElement).value).toBe(
        "it went well",
      ),
    );
    await waitFor(() => expect(headline(/^Message ready$/)).toBeTruthy());
  });

  it("says Thinking while the turn is in flight", async () => {
    render(<Chat initialConversationId="c" initialMessages={[]} />);
    fireEvent.change(screen.getByLabelText(/write a message/i), { target: { value: "hello" } });
    fireEvent.click(screen.getByRole("button", { name: /^send$/i }));
    await waitFor(() => expect(headline(/^Thinking$/)).toBeTruthy());
  });

  it("never claims to be listening when it is not", async () => {
    render(<Chat initialConversationId="c" initialMessages={[]} />);
    // Idle, then sending: at no point does the panel say Listening.
    expect(screen.queryByText(/^Listening$/)).toBeNull();
    fireEvent.change(screen.getByLabelText(/write a message/i), { target: { value: "hello" } });
    fireEvent.click(screen.getByRole("button", { name: /^send$/i }));
    await waitFor(() => expect(headline(/^Thinking$/)).toBeTruthy());
    expect(screen.queryByText(/^Listening$/)).toBeNull();
  });

  it("hides the technical words", async () => {
    render(<Chat initialConversationId="c" initialMessages={[]} />);
    fireEvent.click(screen.getByRole("button", { name: /start voice input/i }));
    fireEvent.click(await screen.findByRole("button", { name: /stop recording/i }));
    await waitFor(() => expect(screen.getByText(/Working out what you said/)).toBeTruthy());

    for (const jargon of [/transcrib/i, /wake word engine/i, /endpoint/i, /stream/i, /buffer/i]) {
      expect(document.body.textContent, String(jargon)).not.toMatch(jargon);
    }
  });

  it("the microphone button keeps an accessible label in every state", async () => {
    render(<Chat initialConversationId="c" initialMessages={[]} />);
    expect(screen.getByRole("button", { name: /start voice input/i })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /start voice input/i }));
    expect(await screen.findByRole("button", { name: /stop recording/i })).toBeTruthy();
  });
});
