import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Chat, type PendingOffer } from "@/app/_components/chat";

/**
 * Voice, from the browser's side.
 *
 * The claim these defend is section 1 of the milestone: audio is an input and
 * an output, and everything between them is the pipeline that already existed.
 * The most important test in this file is the last one — a spoken "yes"
 * reaching the same endpoint, with the same body, as a typed one.
 */
const DRAFT = "Dad was wondering — are you and Simba able to visit soon?";
const OFFER: PendingOffer = {
  opportunityId: "opp-1",
  entityName: "John",
  state: "offered",
  renderedText: DRAFT,
  block: `I can send John this message:\n\n${DRAFT}\n\nWould you like me to send it?`,
};

type Call = { url: string; init?: RequestInit };

/** The assistant message the server persisted for the turn under test. */
const MESSAGE_ID = "11111111-2222-4333-8444-555555555555";

/** One fetch stub for every endpoint the page can reach. */
function stubFetch(options: {
  transcript?: string | number;
  chat?: unknown[];
  speak?: "ok" | number;
  /** Simulates a turn that never reached its terminal state event. */
  omitState?: boolean;
} = {}) {
  const calls: Call[] = [];
  const chatBodies: Array<{ text: string }> = [];

  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });

    if (url === "/api/voice/transcribe") {
      if (typeof options.transcript === "number") {
        return new Response(JSON.stringify({ error: "transcription_failed" }), {
          status: options.transcript,
        });
      }
      return new Response(JSON.stringify({ text: options.transcript ?? "hello" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url === "/api/voice/speak") {
      if (options.speak === undefined || typeof options.speak === "number") {
        return new Response(JSON.stringify({ error: "speech_failed" }), {
          status: typeof options.speak === "number" ? options.speak : 502,
        });
      }
      return new Response(new Blob([new Uint8Array([1, 2, 3])]), {
        status: 200,
        headers: { "Content-Type": "audio/mpeg" },
      });
    }

    chatBodies.push(JSON.parse(String(init?.body)));
    // Every turn ends with the server's closing state, which is what carries
    // the persisted assistant message id that speech refers to.
    const events = [
      ...(options.chat ?? [{ type: "delta", text: "Of course." }]),
      ...(options.omitState ? [] : [{ type: "state", pendingOffer: null, messageId: MESSAGE_ID }]),
    ];
    return new Response(events.map((e) => `${JSON.stringify(e)}\n`).join(""), {
      status: 200,
      headers: { "X-Conversation-Id": "conv-1" },
    });
  });

  vi.stubGlobal("fetch", fetchMock);
  return { calls, chatBodies, fetchMock };
}

/** A MediaRecorder good enough to record nothing, convincingly. */
function stubMicrophone(options: { deny?: boolean; missing?: boolean } = {}) {
  const stopped: string[] = [];

  class FakeRecorder {
    static isTypeSupported = (type: string) => type === "audio/webm;codecs=opus";
    state: "inactive" | "recording" = "inactive";
    mimeType = "audio/webm;codecs=opus";
    ondataavailable: ((event: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;
    constructor() {}
    start() {
      this.state = "recording";
    }
    stop() {
      this.state = "inactive";
      this.ondataavailable?.({ data: new Blob([new Uint8Array(4096)]) });
      this.onstop?.();
    }
  }

  vi.stubGlobal("MediaRecorder", options.missing ? undefined : FakeRecorder);
  vi.stubGlobal("navigator", {
    mediaDevices: options.missing
      ? undefined
      : {
          async getUserMedia() {
            if (options.deny) {
              const error = new Error("denied");
              error.name = "NotAllowedError";
              throw error;
            }
            return { getTracks: () => [{ stop: () => stopped.push("track") }] };
          },
        },
  });
  return { stopped };
}

/** Audio that never actually plays, but records that it was asked to. */
function stubAudio(options: { blocked?: boolean } = {}) {
  const played: number[] = [];
  class FakeAudio {
    src = "";
    onended: (() => void) | null = null;
    constructor() {}
    async play() {
      if (options.blocked) throw new Error("NotAllowedError");
      played.push(1);
    }
    pause() {}
  }
  vi.stubGlobal("Audio", FakeAudio);
  vi.stubGlobal("URL", {
    createObjectURL: () => "blob:fake",
    revokeObjectURL: () => {},
  });
  return { played };
}

const speakButton = () => screen.getByRole("button", { name: /speak your message/i });

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe("1. the microphone control", () => {
  it("is offered beside the composer", () => {
    stubMicrophone();
    render(<Chat initialConversationId="c" initialMessages={[]} />);
    expect(speakButton()).toBeTruthy();
    // A real button, with a label a screen reader can use.
    expect(speakButton().tagName).toBe("BUTTON");
  });

  it("records, and offers a visible way to stop", async () => {
    stubMicrophone();
    stubFetch();
    render(<Chat initialConversationId="c" initialMessages={[]} />);

    fireEvent.click(speakButton());
    const stop = await screen.findByRole("button", { name: /stop recording/i });
    expect(stop).toBeTruthy();
    // And the state is words, not only a colour.
    expect(screen.getByText("Listening…")).toBeTruthy();
  });

  it("announces the recording state politely", async () => {
    stubMicrophone();
    stubFetch();
    const { container } = render(<Chat initialConversationId="c" initialMessages={[]} />);

    fireEvent.click(speakButton());
    await waitFor(() => {
      const live = [...container.querySelectorAll('[aria-live="polite"]')]
        .map((node) => node.textContent)
        .join(" ");
      expect(live).toContain("Recording");
    });
  });
});

describe("2. what CareLoop heard is shown before it is sent", () => {
  it("puts the transcript in the composer rather than sending it", async () => {
    stubMicrophone();
    const { chatBodies } = stubFetch({ transcript: "I haven't seen John this week." });
    render(<Chat initialConversationId="c" initialMessages={[]} />);

    fireEvent.click(speakButton());
    fireEvent.click(await screen.findByRole("button", { name: /stop recording/i }));

    await waitFor(() =>
      expect((screen.getByLabelText(/write a message/i) as HTMLTextAreaElement).value).toBe(
        "I haven't seen John this week.",
      ),
    );
    // Nothing has been said to CareLoop yet. The microphone can mishear a
    // name, and a mishearing that sends itself is the failure this prevents.
    expect(chatBodies).toHaveLength(0);
  });

  it("shows a transcribing state while it waits", async () => {
    stubMicrophone();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/api/voice/transcribe") {
          await gate;
          return new Response(JSON.stringify({ text: "hello" }), { status: 200 });
        }
        return new Response("{}", { status: 200 });
      }),
    );

    render(<Chat initialConversationId="c" initialMessages={[]} />);
    fireEvent.click(speakButton());
    fireEvent.click(await screen.findByRole("button", { name: /stop recording/i }));

    await screen.findByRole("button", { name: /speak your message/i });
    expect(screen.getByText("Transcribing…")).toBeTruthy();
    release();
  });

  it("does not correct what it heard towards a name it knows", async () => {
    stubMicrophone();
    stubFetch({ transcript: "I haven't seen Johnny this week." });
    render(<Chat initialConversationId="c" initialMessages={[]} />);

    fireEvent.click(speakButton());
    fireEvent.click(await screen.findByRole("button", { name: /stop recording/i }));

    // The transcript is evidence. Entity resolution decides what it refers to,
    // downstream, where a person can see the result.
    await waitFor(() =>
      expect((screen.getByLabelText(/write a message/i) as HTMLTextAreaElement).value).toContain(
        "Johnny",
      ),
    );
  });
});

describe("3. voice failing never costs the person their chat", () => {
  it("explains a denied microphone without exposing the browser error", async () => {
    stubMicrophone({ deny: true });
    stubFetch();
    render(<Chat initialConversationId="c" initialMessages={[]} />);

    fireEvent.click(speakButton());
    const note = await screen.findByRole("status");
    expect(note.textContent).toContain("Microphone access is needed");
    expect(note.textContent).not.toMatch(/NotAllowedError|DOMException/);
  });

  it("explains a failed transcription plainly", async () => {
    stubMicrophone();
    stubFetch({ transcript: 502 });
    render(<Chat initialConversationId="c" initialMessages={[]} />);

    fireEvent.click(speakButton());
    fireEvent.click(await screen.findByRole("button", { name: /stop recording/i }));

    const note = await screen.findByRole("status");
    expect(note.textContent).toContain("couldn't understand that recording");
    expect(note.textContent).not.toMatch(/502|fetch|provider/i);
  });

  it("typing still works after voice has failed", async () => {
    stubMicrophone({ deny: true });
    const { chatBodies } = stubFetch();
    render(<Chat initialConversationId="c" initialMessages={[]} />);

    fireEvent.click(speakButton());
    await screen.findByRole("status");

    fireEvent.change(screen.getByLabelText(/write a message/i), {
      target: { value: "typed instead" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^send$/i }));
    await waitFor(() => expect(chatBodies[0].text).toBe("typed instead"));
  });
});

describe("4. reading replies aloud", () => {
  async function speakThenSend(options: Parameters<typeof stubFetch>[0]) {
    stubMicrophone();
    const audio = stubAudio();
    const stubs = stubFetch(options);
    render(<Chat initialConversationId="c" initialMessages={[]} />);

    fireEvent.click(speakButton());
    fireEvent.click(await screen.findByRole("button", { name: /stop recording/i }));
    await waitFor(() =>
      expect((screen.getByLabelText(/write a message/i) as HTMLTextAreaElement).value.length)
        .toBeGreaterThan(0),
    );
    fireEvent.click(screen.getByRole("button", { name: /^send$/i }));
    return { ...stubs, audio };
  }

  it("never plays anything to someone who has not used the microphone", async () => {
    stubMicrophone();
    stubAudio();
    const { calls, chatBodies } = stubFetch({ speak: "ok" });
    render(<Chat initialConversationId="c" initialMessages={[]} />);

    fireEvent.change(screen.getByLabelText(/write a message/i), { target: { value: "hello" } });
    fireEvent.click(screen.getByRole("button", { name: /^send$/i }));
    await waitFor(() => expect(chatBodies).toHaveLength(1));

    // A typed-chat user must never suddenly hear a voice.
    expect(calls.some((call) => call.url === "/api/voice/speak")).toBe(false);
  });

  it("names the turn the server persisted, and supplies no words of its own", async () => {
    const { calls, audio } = await speakThenSend({
      transcript: "hello",
      speak: "ok",
      chat: [{ type: "delta", text: "That sounds lovely." }],
    });

    await waitFor(() => expect(audio.played).toHaveLength(1));
    const spoken = calls.find((call) => call.url === "/api/voice/speak");
    // A reference, not a sentence. The browser is not authoritative about what
    // CareLoop said, so it does not get to say it.
    const body = JSON.parse(String(spoken!.init!.body));
    expect(body).toEqual({
      conversationId: "conv-1",
      source: { type: "assistant_message", id: MESSAGE_ID },
    });
    expect(String(spoken!.init!.body)).not.toContain("That sounds lovely.");
  });

  it("says nothing at all when the server named no message", async () => {
    // No terminal state, no id, no speech — rather than falling back to
    // whatever prose the browser happens to be holding.
    const { calls } = await speakThenSend({
      transcript: "hello",
      speak: "ok",
      chat: [{ type: "delta", text: "That sounds lovely." }],
      omitState: true,
    });
    await waitFor(() => expect(screen.getByText("That sounds lovely.")).toBeTruthy());
    expect(calls.some((call) => call.url === "/api/voice/speak")).toBe(false);
  });

  it("a turn carrying a closure is still spoken by reference", async () => {
    const sentence = "John replied that they are planning to visit this weekend.";
    const { calls } = await speakThenSend({
      transcript: "any news?",
      speak: "ok",
      chat: [
        { type: "closure", sentence },
        { type: "delta", text: "That's good news." },
      ],
    });

    await waitFor(() => expect(calls.some((c) => c.url === "/api/voice/speak")).toBe(true));
    const raw = String(calls.find((c) => c.url === "/api/voice/speak")!.init!.body);
    // The closure sentence is on screen and in the persisted message. It does
    // NOT travel back up to be spoken: the server re-derives it. Which is what
    // keeps M7's grounding rules in force whether a line is read or displayed.
    expect(JSON.parse(raw)).toEqual({
      conversationId: "conv-1",
      source: { type: "assistant_message", id: MESSAGE_ID },
    });
    expect(raw).not.toContain(sentence);
    expect(raw).not.toContain("That's good news.");
  });

  it("a blocked or failed playback leaves the text and the chat untouched", async () => {
    stubMicrophone();
    stubAudio({ blocked: true });
    const { chatBodies } = stubFetch({ transcript: "hello", speak: "ok", chat: [{ type: "delta", text: "Hello there." }] });
    render(<Chat initialConversationId="c" initialMessages={[]} />);

    fireEvent.click(speakButton());
    fireEvent.click(await screen.findByRole("button", { name: /stop recording/i }));
    await waitFor(() =>
      expect((screen.getByLabelText(/write a message/i) as HTMLTextAreaElement).value).toBe("hello"),
    );
    fireEvent.click(screen.getByRole("button", { name: /^send$/i }));

    // The reply is readable whatever the speaker did.
    await waitFor(() => expect(screen.getByText("Hello there.")).toBeTruthy());
    expect(chatBodies).toHaveLength(1);
    const note = await screen.findByRole("status");
    expect(note.textContent).toContain("couldn't play that aloud");
  });

  it("the reconnect card survives the turn that spoke it", async () => {
    // M8 regression 1. The turn presents an offer, the browser draws the card,
    // TTS runs - and the card is still there, with the exact stored draft, and
    // still actionable. The terminal `state` event is what nearly took it
    // away: it is the server's closing word on the reconnect, so a turn that
    // could not READ the pending offer was ending every turn by saying there
    // was none.
    const { calls, audio, chatBodies } = await speakThenSend({
      transcript: "I haven't seen John in a while.",
      speak: "ok",
      chat: [
        { type: "delta", text: "I have a message ready for John." },
        {
          type: "offer",
          opportunityId: OFFER.opportunityId,
          entityName: OFFER.entityName,
          renderedText: OFFER.renderedText,
          block: OFFER.block,
        },
        { type: "state", pendingOffer: OFFER, messageId: MESSAGE_ID },
      ],
      omitState: true,
    });

    // Drawn from the offer event's FIELDS, never parsed out of the prose.
    const card = await screen.findByText(/Reconnect with John/i);
    expect(card).toBeTruthy();
    expect(screen.getByText(OFFER.renderedText)).toBeTruthy();

    // The turn is read aloud...
    await waitFor(() => expect(audio.played).toHaveLength(1));
    expect(calls.some((call) => call.url === "/api/voice/speak")).toBe(true);

    // ...and the card is still standing afterwards, still with the exact bytes.
    expect(screen.getByText(/Reconnect with John/i)).toBeTruthy();
    expect(screen.getByText(OFFER.renderedText)).toBeTruthy();

    // And a spoken "yes" still goes down the ordinary chat endpoint.
    const before = chatBodies.length;
    fireEvent.click(screen.getByRole("button", { name: /send message/i }));
    await waitFor(() => expect(chatBodies).toHaveLength(before + 1));
    expect(chatBodies.at(-1)).toEqual({ conversationId: "conv-1", text: "yes" });
    expect(calls.filter((c) => c.url === "/api/chat").length).toBe(before + 1);
  });

  it("only one reply can be speaking at a time", async () => {
    // The player is module-wide and stops whatever is running before it
    // starts, so two answers can never talk over each other.
    const source = (await import("node:fs")).readFileSync("app/_components/speech.ts", "utf8");
    const body = source.slice(source.indexOf("export async function speak("));
    expect(body.indexOf("stopSpeaking()")).toBeLessThan(body.indexOf("fetch("));
  });
});

describe("5. a spoken answer is the typed answer", () => {
  it("a spoken 'yes' reaches the chat endpoint exactly as a typed one does", async () => {
    // THE test for this milestone. There is no voice consent endpoint, no
    // voice-specific approval, and no shortcut to a grant: the transcript is
    // put in the composer, the person sends it, and the deterministic parser
    // on the other side sees the same body it would have seen from a keyboard.
    stubMicrophone();
    stubAudio();
    const { chatBodies, calls } = stubFetch({
      transcript: "yes",
      speak: "ok",
      chat: [{ type: "delta", text: "Thank you — I'll send that to John now." }],
    });

    render(
      <Chat initialConversationId="c" initialMessages={[]} initialPendingOffer={OFFER} />,
    );
    expect(screen.getByText(/Reconnect with John/i)).toBeTruthy();

    fireEvent.click(speakButton());
    fireEvent.click(await screen.findByRole("button", { name: /stop recording/i }));
    await waitFor(() =>
      expect((screen.getByLabelText(/write a message/i) as HTMLTextAreaElement).value).toBe("yes"),
    );

    fireEvent.click(screen.getByRole("button", { name: /^send$/i }));
    await waitFor(() => expect(chatBodies).toHaveLength(1));

    expect(chatBodies[0]).toEqual({ conversationId: "c", text: "yes" });
    // One chat call, to the ordinary endpoint. Nothing voice-specific.
    const chatCalls = calls.filter((call) => call.url === "/api/chat");
    expect(chatCalls).toHaveLength(1);
    expect(calls.some((call) => call.url.includes("consent"))).toBe(false);
    expect(calls.some((call) => call.url.includes("approve"))).toBe(false);
  });

  it("the client has no voice-specific consent path at all", async () => {
    const source = (await import("node:fs")).readFileSync("app/_components/chat.tsx", "utf8");
    // Every consent action goes through the one `send` function.
    expect(source).not.toMatch(/voice.*(approve|consent|grant)/i);
    expect(source).toContain('const APPROVE_PHRASE = "yes"');
    expect(source).toContain('const DECLINE_PHRASE = "no"');
  });
});
