import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The turn that ends itself.
 *
 * The browser test found the wake word working and the turn still needing a
 * click, which makes a wake word a button with extra steps. These tests are
 * about what happens when the watcher reports, and — the part that matters —
 * what happens when it reports twice, reports nothing, or never gets the
 * chance because somebody turned Nora off first.
 *
 * Both the wake engine and the watcher are mocked. Their own internals are
 * tested elsewhere (`nora-engine.test.tsx`, `endpoint-tracker.test.ts`);
 * what is under test here is the wiring between them and the recorder, which
 * is where a microphone gets left open.
 */
const status = vi.hoisted(() => ({
  value: { available: true, reason: null as string | null, availableUntil: "2026-09-25T23:59:59.999Z" },
}));
const engine = vi.hoisted(() => ({
  starts: 0, stops: 0, pauses: 0, resumes: 0,
  onWake: (() => {}) as () => void,
}));
const watcher = vi.hoisted(() => ({
  starts: 0,
  stops: 0,
  supported: true,
  decide: (() => {}) as (outcome: string) => void,
}));

vi.mock("@/app/_components/nora", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/app/_components/nora")>();
  return {
    ...actual,
    fetchNoraStatus: async () => status.value,
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
  endpointingSupported: () => watcher.supported,
  startEndpointing: (input: { onDecision: (outcome: string) => void }) => {
    if (!watcher.supported) return null;
    watcher.starts += 1;
    watcher.decide = (outcome) => {
      // The real watcher releases itself before reporting, exactly here.
      watcher.stops += 1;
      input.onDecision(outcome);
    };
    return { stop: () => { watcher.stops += 1; } };
  },
}));

const { Chat } = await import("@/app/_components/chat");

let transcribeCalls = 0;
let transcribeFails = false;
let transcribeEmpty = false;

function stubMicrophone() {
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
      transcribeCalls += 1;
      if (transcribeFails) return new Response(JSON.stringify({ error: "x" }), { status: 500 });
      if (transcribeEmpty) return new Response(JSON.stringify({ error: "no_speech" }), { status: 422 });
      return new Response(JSON.stringify({ text: "good morning" }), { status: 200 });
    }
    return new Response("", { status: 200 });
  }));
}

const toggle = () => screen.getByRole("switch", { name: /nora hands-free/i });
const composer = () => screen.getByLabelText(/write a message/i) as HTMLTextAreaElement;

async function wake() {
  render(<Chat initialConversationId="c" initialMessages={[]} />);
  await waitFor(() => expect(toggle()).toBeTruthy());
  fireEvent.click(toggle());
  await waitFor(() => expect(engine.starts).toBe(1));
  stubMicrophone();
  engine.onWake();
  await waitFor(() => expect(watcher.starts).toBe(1));
}

beforeEach(() => {
  window.localStorage.clear();
  vi.stubEnv("NEXT_PUBLIC_PICOVOICE_ACCESS_KEY", "pv-key");
  vi.stubEnv("NEXT_PUBLIC_NORA_KEYWORD_PATH", "/nora/Nora.ppn");
  status.value = { available: true, reason: null, availableUntil: "2026-09-25T23:59:59.999Z" };
  Object.assign(engine, { starts: 0, stops: 0, pauses: 0, resumes: 0 });
  Object.assign(watcher, { starts: 0, stops: 0, supported: true });
  transcribeCalls = 0;
  transcribeFails = false;
  transcribeEmpty = false;
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("1. the watcher exists only for a wake turn", () => {
  it("a wake starts one", async () => {
    await wake();
    expect(watcher.starts).toBe(1);
    expect(await screen.findByRole("button", { name: /stop recording/i })).toBeTruthy();
  });

  it("a PRESSED microphone starts none — push-to-talk is untouched", async () => {
    render(<Chat initialConversationId="c" initialMessages={[]} />);
    await waitFor(() => expect(toggle()).toBeTruthy());
    stubMicrophone();
    fireEvent.click(screen.getByRole("button", { name: /start voice input/i }));
    expect(await screen.findByRole("button", { name: /stop recording/i })).toBeTruthy();
    expect(watcher.starts).toBe(0);
  });
});

describe("2. speech then silence finalises the turn, exactly once", () => {
  it("transcribes without anyone pressing anything", async () => {
    await wake();
    watcher.decide("speech_ended");
    await waitFor(() => expect(composer().value).toBe("good morning"));
    expect(transcribeCalls).toBe(1);
    // And nothing was sent.
    const calls = (globalThis.fetch as unknown as { mock: { calls: string[][] } }).mock.calls;
    expect(calls.some((c) => c[0] === "/api/chat")).toBe(false);
  });

  it("a second decision cannot transcribe a second time", async () => {
    await wake();
    watcher.decide("speech_ended");
    await waitFor(() => expect(composer().value).toBe("good morning"));
    watcher.decide("speech_ended");
    watcher.decide("speech_ended");
    await waitFor(() => expect(composer().value).toBe("good morning"));
    // The recorder handle is taken once; later decisions find nothing.
    expect(transcribeCalls).toBe(1);
  });

  it("releases the watcher when the turn ends", async () => {
    await wake();
    watcher.decide("speech_ended");
    await waitFor(() => expect(composer().value).toBe("good morning"));
    expect(watcher.stops).toBeGreaterThanOrEqual(1);
  });

  it("and leaves the detector down, because a draft is waiting", async () => {
    await wake();
    const resumesBefore = engine.resumes;
    watcher.decide("speech_ended");
    await waitFor(() => expect(composer().value).toBe("good morning"));
    await waitFor(() => expect(screen.getByText(/Nora is paused/i)).toBeTruthy());
    expect(engine.resumes).toBe(resumesBefore);
  });
});

describe("3. nobody spoke", () => {
  it("transcribes nothing and says so plainly", async () => {
    await wake();
    watcher.decide("no_speech");

    await waitFor(() => expect(screen.getByText(/didn.t hear anything after that/i)).toBeTruthy());
    expect(transcribeCalls).toBe(0);
    expect(composer().value).toBe("");
  });

  it("returns cleanly to the wake state", async () => {
    await wake();
    const resumesBefore = engine.resumes;
    watcher.decide("no_speech");
    await waitFor(() => expect(engine.resumes).toBe(resumesBefore + 1));
    expect(screen.queryByRole("button", { name: /stop recording/i })).toBeNull();
  });

  it("does not touch text the person had already written", async () => {
    render(<Chat initialConversationId="c" initialMessages={[]} />);
    await waitFor(() => expect(toggle()).toBeTruthy());
    fireEvent.click(toggle());
    await waitFor(() => expect(engine.starts).toBe(1));
    stubMicrophone();
    fireEvent.change(composer(), { target: { value: "something I typed" } });

    // A wake cannot fire here at all, but if a stray frame did, the words
    // must survive it.
    engine.onWake();
    await waitFor(() => expect(composer().value).toBe("something I typed"));
    expect(watcher.starts).toBe(0);
  });
});

describe("4. the ceiling", () => {
  it("transcribes what there is rather than throwing it away", async () => {
    await wake();
    watcher.decide("max_duration");
    await waitFor(() => expect(composer().value).toBe("good morning"));
    expect(screen.getByText(/as long as I can listen at once/i)).toBeTruthy();
  });
});

describe("5. things that go wrong mid-turn", () => {
  it("a transcription failure is recoverable and re-arms", async () => {
    transcribeFails = true;
    await wake();
    const resumesBefore = engine.resumes;
    watcher.decide("speech_ended");

    await waitFor(() => expect(screen.getByText(/that recording didn.t work/i)).toBeTruthy());
    expect(composer().value).toBe("");
    // No draft, so nothing is unresolved, so the detector comes back.
    await waitFor(() => expect(engine.resumes).toBe(resumesBefore + 1));
  });

  it("an empty transcript is never submitted, and re-arms", async () => {
    transcribeEmpty = true;
    await wake();
    const resumesBefore = engine.resumes;
    watcher.decide("speech_ended");

    await waitFor(() => expect(screen.getByText(/didn.t catch that/i)).toBeTruthy());
    expect(composer().value).toBe("");
    await waitFor(() => expect(engine.resumes).toBe(resumesBefore + 1));
  });
});

describe("6. teardown reaches the watcher on every path", () => {
  it("Nora OFF mid-listening releases the watcher AND the engine", async () => {
    await wake();
    const stopsBefore = watcher.stops;
    fireEvent.click(toggle());

    await waitFor(() => expect(engine.stops).toBe(1));
    expect(watcher.stops).toBeGreaterThan(stopsBefore);
    // The abandoned recording is not transcribed.
    expect(transcribeCalls).toBe(0);
    expect(screen.queryByRole("button", { name: /stop recording/i })).toBeNull();
  });

  it("expiry mid-listening releases both", async () => {
    await wake();
    const stopsBefore = watcher.stops;
    // The turn ends, and the server has moved past the cutoff meanwhile.
    status.value = { available: false, reason: "expired", availableUntil: "2026-09-25T23:59:59.999Z" };
    watcher.decide("no_speech");

    await waitFor(() => expect(engine.stops).toBe(1));
    expect(watcher.stops).toBeGreaterThan(stopsBefore);
    await waitFor(() => expect(screen.getByText(/no longer available/i)).toBeTruthy());
    expect(engine.resumes).toBe(0);
  });

  it("unmount mid-listening releases both", async () => {
    const { unmount } = render(<Chat initialConversationId="c" initialMessages={[]} />);
    await waitFor(() => expect(toggle()).toBeTruthy());
    fireEvent.click(toggle());
    await waitFor(() => expect(engine.starts).toBe(1));
    stubMicrophone();
    engine.onWake();
    await waitFor(() => expect(watcher.starts).toBe(1));

    const stopsBefore = watcher.stops;
    unmount();

    // The cleanup runs when no callback can, which is exactly why it is a
    // separate path and exactly why it is asserted separately.
    await waitFor(() => expect(engine.stops).toBe(1));
    expect(watcher.stops).toBeGreaterThan(stopsBefore);
  });

  it("the manual Stop button still ends a wake turn, as a fallback", async () => {
    await wake();
    fireEvent.click(screen.getByRole("button", { name: /stop recording/i }));
    await waitFor(() => expect(composer().value).toBe("good morning"));
    expect(watcher.stops).toBeGreaterThanOrEqual(1);
  });
});

describe("7. a browser without Web Audio degrades, it does not break", () => {
  it("the wake turn still works — it just needs the Stop button", async () => {
    watcher.supported = false;
    render(<Chat initialConversationId="c" initialMessages={[]} />);
    await waitFor(() => expect(toggle()).toBeTruthy());
    fireEvent.click(toggle());
    await waitFor(() => expect(engine.starts).toBe(1));
    stubMicrophone();
    engine.onWake();

    const stop = await screen.findByRole("button", { name: /stop recording/i });
    expect(watcher.starts).toBe(0);
    fireEvent.click(stop);
    await waitFor(() => expect(composer().value).toBe("good morning"));
  });
});
