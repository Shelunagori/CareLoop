import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PendingOffer } from "@/app/_components/chat";

/**
 * THE TRANSCRIPT THAT SENDS ITSELF (M12h).
 *
 * `core/nora/autosend.ts` decides WHETHER. This file is about the three
 * seconds in between, which is where the person is: the number on screen,
 * the way out of it, and — the part that has bitten this codebase twice
 * now — everything that has to cancel it.
 *
 * Both the wake engine and the endpoint watcher are mocked, as in
 * `nora-endpointing.test.tsx`. What is under test is the wiring: a timer,
 * a send, and five different ways of stopping one.
 */
const status = vi.hoisted(() => ({
  value: {
    available: true,
    reason: null as string | null,
    availableUntil: "2026-09-25T23:59:59.999Z",
  },
}));
const engine = vi.hoisted(() => ({
  starts: 0, stops: 0, pauses: 0, resumes: 0,
  onWake: (() => {}) as () => void,
}));
const watcher = vi.hoisted(() => ({
  starts: 0, stops: 0,
  decide: (() => {}) as (outcome: string) => void,
}));

vi.mock("@/app/_components/nora", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/app/_components/nora")>();
  return {
    ...actual,
    // A fresh object every call, like the real one (M12g).
    fetchNoraStatus: async () => ({ ...status.value }),
    noraBrowserSupported: () => true,
    startNora: async (options: { onWake: () => void }) => {
      engine.starts += 1;
      engine.onWake = options.onWake;
      return {
        stop: async () => { engine.stops += 1; },
        pause: async () => { engine.pauses += 1; },
        resume: async () => { engine.resumes += 1; },
      };
    },
  };
});

vi.mock("@/app/_components/endpoint", () => ({
  endpointingSupported: () => true,
  startEndpointing: (input: { onDecision: (outcome: string) => void }) => {
    watcher.starts += 1;
    watcher.decide = (outcome) => {
      watcher.stops += 1;
      input.onDecision(outcome);
    };
    return {
      stop: () => { watcher.stops += 1; },
      /**
       * A FAKE THAT HONOURS THE WHOLE CONTRACT (M12i).
       *
       * The application's backstop asks a live watcher whether it has
       * heard anything before deciding a window is silent. A fake missing
       * this method does not fail a type check — `vi.mock` factories are
       * untyped — it throws at the deadline, seconds into a test.
       */
      inspect: () => ({ decided: null, speechStarted: false }),
    };
  },
}));

const { Chat } = await import("@/app/_components/chat");

/** Five words: comfortably over the bound, and plainly a real sentence. */
const HEARD = "tell me about the weather";
const OFFER: PendingOffer = {
  opportunityId: "opp-1",
  entityName: "John",
  state: "offered",
  renderedText: "Dad was wondering — are you visiting soon?",
  block: "I can send John this message:\n\nDad was wondering — are you visiting soon?\n\nWould you like me to send it?",
};

let transcript = HEARD;
/** Every message posted to the chat route, in order. */
let sent: string[] = [];

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
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/voice/transcribe") {
        return new Response(JSON.stringify({ text: transcript }), { status: 200 });
      }
      if (url === "/api/chat") {
        sent.push(JSON.parse(String(init?.body)).text);
        const body = [
          { type: "delta", text: "Lovely." },
          { type: "state", pendingOffer: null },
        ]
          .map((event) => `${JSON.stringify(event)}\n`)
          .join("");
        return new Response(body, { status: 200, headers: { "X-Conversation-Id": "c" } });
      }
      return new Response("", { status: 200 });
    }),
  );
}

const toggle = () => screen.getByRole("switch", { name: /nora hands-free/i });
const composer = () => screen.getByLabelText(/write a message/i) as HTMLTextAreaElement;
const cancelButton = () => screen.getByRole("button", { name: /^cancel/i });

/** Turn Nora on, wake it, and let the recording finish with a transcript. */
async function speak(options: { offer?: PendingOffer | null; press?: boolean } = {}) {
  const view = render(
    <Chat initialConversationId="c" initialMessages={[]} initialPendingOffer={options.offer ?? null} />,
  );
  // No click: Nora is on by default (M12h), which is the journey these
  // tests are about — somebody who opened the page and spoke.
  await waitFor(() => expect(engine.starts).toBe(1));
  stubBrowser();

  if (options.press) {
    fireEvent.click(screen.getByRole("button", { name: /start voice input/i }));
    await waitFor(() => expect(screen.getByRole("button", { name: /stop recording/i })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /stop recording/i }));
  } else {
    engine.onWake();
    await waitFor(() => expect(watcher.starts).toBe(1));
    act(() => watcher.decide("silence"));
  }
  await waitFor(() => expect(composer().value).toBe(transcript));
  return view;
}

const tick = async (ms: number) => {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
};

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  window.localStorage.clear();
  window.sessionStorage.clear();
  vi.stubEnv("NEXT_PUBLIC_PICOVOICE_ACCESS_KEY", "pv-key");
  vi.stubEnv("NEXT_PUBLIC_NORA_KEYWORD_PATH", "/nora/Nora.ppn");
  status.value = { available: true, reason: null, availableUntil: "2026-09-25T23:59:59.999Z" };
  Object.assign(engine, { starts: 0, stops: 0, pauses: 0, resumes: 0 });
  Object.assign(watcher, { starts: 0, stops: 0 });
  transcript = HEARD;
  sent = [];
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("1. a spoken sentence sends itself", () => {
  it("counts down out loud, then sends exactly what was heard", async () => {
    await speak();

    expect(screen.getByText("Sending in 3…")).toBeTruthy();
    await tick(1000);
    expect(screen.getByText("Sending in 2…")).toBeTruthy();
    await tick(1000);
    expect(screen.getByText("Sending in 1…")).toBeTruthy();
    expect(sent).toEqual([]);

    await tick(1000);
    await waitFor(() => expect(sent).toEqual([HEARD]));
  });

  it("sends once, however long the clock runs on", async () => {
    await speak();
    await tick(30_000);
    await waitFor(() => expect(sent).toEqual([HEARD]));
  });

  it("is not armed while it counts down", async () => {
    // A second wake in the last three seconds would overwrite words already
    // on their way. This is the M12 draft bug with a timer attached.
    await speak();
    const resumesBefore = engine.resumes;
    await tick(2000);
    expect(engine.resumes).toBe(resumesBefore);
  });
});

describe("2. the ways out of it", () => {
  it("Cancel stops it and leaves the words where they are", async () => {
    await speak();
    fireEvent.click(cancelButton());

    expect(composer().value).toBe(HEARD);
    await tick(10_000);
    expect(sent).toEqual([]);
    // And the panel goes back to the resting state for an unsent draft.
    expect(screen.getByText("Message ready")).toBeTruthy();
  });

  it("editing a word stops it", async () => {
    // The commonest correction there is: the transcriber misheard, and the
    // person starts fixing it. A countdown that carried on would send the
    // half-corrected sentence.
    await speak();
    fireEvent.change(composer(), { target: { value: `${HEARD} tomorrow` } });

    await tick(10_000);
    expect(sent).toEqual([]);
  });

  it("ending the voice session stops it", async () => {
    await speak();
    const end = screen.queryByRole("button", { name: /end voice session/i });
    if (end) fireEvent.click(end);
    fireEvent.click(toggle());

    await tick(10_000);
    expect(sent).toEqual([]);
  });

  it("closing the page sends nothing", async () => {
    const view = await speak();
    view.unmount();
    await tick(10_000);
    expect(sent).toEqual([]);
  });

  it("pressing Send during the countdown sends once, not twice", async () => {
    await speak();
    fireEvent.click(screen.getByRole("button", { name: /^send$/i }));
    await waitFor(() => expect(sent).toEqual([HEARD]));
    await tick(10_000);
    expect(sent).toEqual([HEARD]);
  });
});

describe("3. what never counts down at all", () => {
  it("an offer on the table", async () => {
    // The card asks a yes-or-no question about messaging somebody's family.
    // Whatever is said next stays the person's to send.
    await speak({ offer: OFFER });

    expect(screen.queryByText(/sending in/i)).toBeNull();
    await tick(10_000);
    expect(sent).toEqual([]);
    expect(composer().value).toBe(HEARD);
  });

  it("one or two words", async () => {
    transcript = "yes please";
    await speak();

    expect(screen.queryByText(/sending in/i)).toBeNull();
    await tick(10_000);
    expect(sent).toEqual([]);
  });

  it("a recording the person pressed for themselves", async () => {
    await speak({ press: true });

    expect(screen.queryByText(/sending in/i)).toBeNull();
    await tick(10_000);
    expect(sent).toEqual([]);
  });
});
