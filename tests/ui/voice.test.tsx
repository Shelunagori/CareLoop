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

const micButton = () => screen.getByRole("button", { name: /start voice input/i });

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe("1. the microphone control", () => {
  it("is offered beside the composer", () => {
    stubMicrophone();
    render(<Chat initialConversationId="c" initialMessages={[]} />);
    expect(micButton()).toBeTruthy();
    // A real button, with a label a screen reader can use.
    expect(micButton().tagName).toBe("BUTTON");
  });

  it("records, and offers a visible way to stop", async () => {
    stubMicrophone();
    stubFetch();
    render(<Chat initialConversationId="c" initialMessages={[]} />);

    fireEvent.click(micButton());
    const stop = await screen.findByRole("button", { name: /stop recording/i });
    expect(stop).toBeTruthy();
    // And the state is words, not only a colour.
    expect(screen.getByText("Listening…")).toBeTruthy();
  });

  it("announces the recording state politely", async () => {
    stubMicrophone();
    stubFetch();
    const { container } = render(<Chat initialConversationId="c" initialMessages={[]} />);

    fireEvent.click(micButton());
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

    fireEvent.click(micButton());
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
    fireEvent.click(micButton());
    fireEvent.click(await screen.findByRole("button", { name: /stop recording/i }));

    // The control returns to "start voice input" while the words are worked
    // out, and the state is said in words beside it.
    await screen.findByRole("button", { name: /start voice input/i });
    expect(screen.getByText("Transcribing…")).toBeTruthy();
    release();
  });

  it("does not correct what it heard towards a name it knows", async () => {
    stubMicrophone();
    stubFetch({ transcript: "I haven't seen Johnny this week." });
    render(<Chat initialConversationId="c" initialMessages={[]} />);

    fireEvent.click(micButton());
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

    fireEvent.click(micButton());
    const note = await screen.findByRole("status");
    expect(note.textContent).toContain("Microphone access is needed");
    expect(note.textContent).not.toMatch(/NotAllowedError|DOMException/);
  });

  it("explains a failed transcription plainly", async () => {
    stubMicrophone();
    stubFetch({ transcript: 502 });
    render(<Chat initialConversationId="c" initialMessages={[]} />);

    fireEvent.click(micButton());
    fireEvent.click(await screen.findByRole("button", { name: /stop recording/i }));

    const note = await screen.findByRole("status");
    expect(note.textContent).toContain("that recording didn't work");
    // A server fault is OUR problem. Saying "I didn't catch that" would tell
    // the person their speech was unclear when it never reached a recognizer.
    expect(note.textContent).not.toMatch(/didn't catch/i);
    expect(note.textContent).not.toMatch(/502|fetch|provider/i);
  });

  it("typing still works after voice has failed", async () => {
    stubMicrophone({ deny: true });
    const { chatBodies } = stubFetch();
    render(<Chat initialConversationId="c" initialMessages={[]} />);

    fireEvent.click(micButton());
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

    fireEvent.click(micButton());
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

    fireEvent.click(micButton());
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

    fireEvent.click(micButton());
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

/**
 * What a failed transcription means (M9 finding, kept).
 *
 * The hands-free experiment is gone; this distinction is not. A transcription
 * that succeeded and came back empty is somebody coughing, and the person
 * should be told so gently. A recording the server will not take is OUR
 * recorder producing something unusable, and telling them "I didn't catch
 * that" would blame their speech for our bug. Neither ever reaches /api/chat.
 */
describe("6. an unusable recording is not a mishearing", () => {
  it("only 'nothing heard' is nothing heard", async () => {
    const { transcribe, NothingHeardError } = await import("@/app/_components/voice");
    const audio = new Blob([new Uint8Array(4096)]);
    const stub = (response: Response) => vi.stubGlobal("fetch", vi.fn(async () => response.clone()));

    // A transcription that SUCCEEDED and came back empty. The route's 422 is
    // returned for exactly this outcome, and the 200 cases are the same thing
    // arriving without it.
    for (const [label, response] of [
      ["422 no_speech_detected", new Response(JSON.stringify({ error: "no_speech_detected" }), { status: 422 })],
      ["200 empty", new Response(JSON.stringify({ text: "" }), { status: 200 })],
      ["200 whitespace", new Response(JSON.stringify({ text: "   " }), { status: 200 })],
      ["200 no field", new Response(JSON.stringify({}), { status: 200 })],
    ] as const) {
      stub(response);
      await expect(transcribe(audio), label).rejects.toBeInstanceOf(NothingHeardError);
    }
  });

  it("a recording the server will not take is a fault, not a mishearing", async () => {
    const { transcribe, NothingHeardError } = await import("@/app/_components/voice");
    const audio = new Blob([new Uint8Array(4096)]);
    const stub = (response: Response) => vi.stubGlobal("fetch", vi.fn(async () => response.clone()));

    // 413 and 415 mean OUR recorder produced something unusable. Telling the
    // person "I didn't catch that" would blame their speech for our bug.
    for (const [label, response] of [
      ["413 too_large", new Response(JSON.stringify({ error: "too_large" }), { status: 413 })],
      ["415 unsupported_type", new Response(JSON.stringify({ error: "unsupported_type" }), { status: 415 })],
      ["500", new Response("boom", { status: 500 })],
      ["502", new Response(JSON.stringify({ error: "transcription_failed" }), { status: 502 })],
    ] as const) {
      stub(response);
      await expect(transcribe(audio), label).rejects.not.toBeInstanceOf(NothingHeardError);
    }

    // And a real transcript is still a transcript.
    stub(new Response(JSON.stringify({ text: " yes " }), { status: 200 }));
    await expect(transcribe(audio)).resolves.toBe("yes");
  });
});

describe("7. the transcript is a draft, and a draft is the person's", () => {
  it("a mishearing can be corrected before anyone else sees it", async () => {
    stubMicrophone();
    const { chatBodies } = stubFetch({ transcript: "Tell Jon I am well" });
    render(<Chat initialConversationId="c" initialMessages={[]} />);

    fireEvent.click(micButton());
    fireEvent.click(await screen.findByRole("button", { name: /stop recording/i }));

    const composer = (await screen.findByLabelText(/write a message/i)) as HTMLTextAreaElement;
    await waitFor(() => expect(composer.value).toBe("Tell Jon I am well"));

    // The whole reason the transcript is not auto-submitted: it is wrong, and
    // the person can see that it is wrong, and fix it.
    expect(composer.readOnly).toBe(false);
    expect(composer.disabled).toBe(false);
    fireEvent.change(composer, { target: { value: "Tell John I am well" } });
    fireEvent.click(screen.getByRole("button", { name: /^send$/i }));

    await waitFor(() => expect(chatBodies).toHaveLength(1));
    expect(chatBodies[0]?.text).toBe("Tell John I am well");
  });

  it("nothing heard reaches no endpoint and destroys no draft", async () => {
    stubMicrophone();
    const { calls, chatBodies } = stubFetch({ transcript: "" });
    render(<Chat initialConversationId="c" initialMessages={[]} />);

    const composer = screen.getByLabelText(/write a message/i) as HTMLTextAreaElement;
    fireEvent.change(composer, { target: { value: "half a thought" } });

    fireEvent.click(micButton());
    fireEvent.click(await screen.findByRole("button", { name: /stop recording/i }));
    await screen.findByText(/didn't catch/i);

    // An empty transcript is not a message. It is never sent, and it does not
    // wipe out what the person had already typed.
    expect(chatBodies).toHaveLength(0);
    expect(calls.filter((call) => call.url === "/api/chat")).toHaveLength(0);
    expect(composer.value).toBe("half a thought");
  });

  it("the microphone never submits the form by accident", () => {
    stubMicrophone();
    render(<Chat initialConversationId="c" initialMessages={[]} />);

    // A <button> inside a <form> submits by default. This one is a control,
    // not a send; pressing it with text in the composer must not send it.
    const mic = micButton() as HTMLButtonElement;
    expect(mic.type).toBe("button");
    expect(mic.tagName).toBe("BUTTON");
    // Reachable by keyboard: a real button, not a div with a click handler,
    // and never removed from the tab order.
    expect(mic.tabIndex).toBeGreaterThanOrEqual(0);
    expect(mic.getAttribute("aria-pressed")).toBe("false");
  });

  it("is big enough to hit without aiming", () => {
    stubMicrophone();
    render(<Chat initialConversationId="c" initialMessages={[]} />);

    // 44px is the accessibility floor, and this product's hands are older
    // than most. 2.75rem is 47px against this app's 17px root.
    const className = micButton().className;
    expect(className).toMatch(/h-\[2\.75rem\]/);
    expect(className).toMatch(/w-\[2\.75rem\]/);
  });
});

describe("8. the composer is one control, not three", () => {
  /** The shell: the element that draws the border around the whole composer. */
  const shell = () => {
    const box = screen.getByLabelText(/write a message/i);
    const found = box.closest("[data-composer]");
    if (!found) throw new Error("no composer shell wraps the textarea");
    return found as HTMLElement;
  };

  it("the microphone and Send live inside the same shell as the box", () => {
    stubMicrophone();
    render(<Chat initialConversationId="c" initialMessages={[]} />);

    // Not "somewhere on the page" — inside the bordered composer, which is
    // what makes them read as one control rather than three.
    const composer = shell();
    expect(composer.contains(micButton())).toBe(true);
    expect(composer.contains(screen.getByRole("button", { name: /^send/i }))).toBe(true);

    // And the shell is what carries the border, so the textarea inside it
    // cannot be drawing a second box of its own.
    expect(composer.className).toMatch(/border/);
    expect((screen.getByLabelText(/write a message/i) as HTMLTextAreaElement).className)
      .not.toMatch(/border-2/);
  });

  it("there is no standalone Speak button anywhere", () => {
    stubMicrophone();
    render(<Chat initialConversationId="c" initialMessages={[]} />);

    expect(screen.queryByRole("button", { name: /^speak$/i })).toBeNull();
    // The microphone is the only way into voice input.
    const voiceControls = screen
      .getAllByRole("button")
      .filter((b) => /voice|record|speak|listen|microphone/i.test(b.getAttribute("aria-label") ?? ""));
    expect(voiceControls.map((b) => b.getAttribute("aria-label"))).toEqual(["Start voice input"]);
  });

  it("none of the removed hands-free controls came back", () => {
    stubMicrophone();
    render(<Chat initialConversationId="c" initialMessages={[]} />);

    for (const gone of [
      /start conversation/i,
      /end conversation/i,
      /enable hands-free/i,
      /disable hands-free/i,
      /nora/i,
      /wake/i,
    ]) {
      expect(screen.queryByRole("button", { name: gone }), String(gone)).toBeNull();
    }
    expect(document.body.textContent).not.toMatch(/nora|hands-free|wake word/i);
  });

  it("Send is dead until there are words, whoever typed them", async () => {
    stubMicrophone();
    stubFetch({ transcript: "I saw John on Tuesday" });
    render(<Chat initialConversationId="c" initialMessages={[]} />);

    const send = () => screen.getByRole("button", { name: /^send/i }) as HTMLButtonElement;
    expect(send().disabled).toBe(true);

    // Whitespace is not words.
    fireEvent.change(screen.getByLabelText(/write a message/i), { target: { value: "   " } });
    expect(send().disabled).toBe(true);

    // A transcript enables it exactly as typing does — and still waits.
    fireEvent.change(screen.getByLabelText(/write a message/i), { target: { value: "" } });
    fireEvent.click(micButton());
    fireEvent.click(await screen.findByRole("button", { name: /stop recording/i }));
    await waitFor(() => expect(send().disabled).toBe(false));
  });

  it("while transcribing, the microphone says so and holds its place", async () => {
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

    fireEvent.click(micButton());
    fireEvent.click(await screen.findByRole("button", { name: /stop recording/i }));

    const mic = micButton() as HTMLButtonElement;
    expect(mic.disabled).toBe(true);
    expect(mic.getAttribute("aria-busy")).toBe("true");
    // Same control, same size: the composer must not twitch mid-thought.
    expect(mic.className).toMatch(/h-\[2\.75rem\]/);
    expect(shell().contains(mic)).toBe(true);
    release();
  });
});
