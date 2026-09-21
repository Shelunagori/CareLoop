import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * CareLoop's own voice must not wake CareLoop.
 *
 * Observed in the browser: "Stop reading" and "Nora is listening for
 * 'Hey Nora'" on screen at the same time. There is no barge-in here — no
 * echo cancellation tuned for it, no duplex path, nothing tested — so an
 * armed wake detector during playback is a microphone pointed at a
 * loudspeaker that is about to say the wake word out loud.
 *
 * The fix is one input to the state machine, not a resume() hung off the
 * audio element's `onended`. That matters: re-arming through the ordinary
 * path means playback finishing cannot revive a Nora that was switched off,
 * expired, or is holding an unresolved draft — the same rules apply as to
 * every other arm, because it IS every other arm.
 */
const status = vi.hoisted(() => ({
  asked: 0,
  value: { available: true, reason: null as string | null, availableUntil: "2026-09-25T23:59:59.999Z" },
}));
const engine = vi.hoisted(() => ({
  starts: 0, stops: 0, pauses: 0, resumes: 0, onWake: (() => {}) as () => void,
}));
const audio = vi.hoisted(() => ({
  plays: 0,
  stops: 0,
  end: (() => {}) as () => void,
}));

vi.mock("@/app/_components/nora", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/app/_components/nora")>();
  return {
    ...actual,
    fetchNoraStatus: async () => {
      status.asked += 1;
      return status.value;
    },
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

vi.mock("@/app/_components/speech", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/app/_components/speech")>();
  return {
    ...actual,
    stopSpeaking: () => { audio.end(); },
    speak: async (_r: unknown, options?: { onEnded?: () => void }) => {
      audio.plays += 1;
      audio.end = () => {
        audio.stops += 1;
        options?.onEnded?.();
        audio.end = () => {};
      };
    },
  };
});

// The end-of-turn watcher is not what is under test; jsdom has no Web Audio
// anyway, so the Stop button ends the wake turn here.
vi.mock("@/app/_components/endpoint", () => ({
  endpointingSupported: () => false,
  startEndpointing: () => null,
}));

const { Chat } = await import("@/app/_components/chat");

const toggle = () => screen.getByRole("switch", { name: /nora hands-free/i });
const composer = () => screen.getByLabelText(/write a message/i) as HTMLTextAreaElement;

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
      return new Response(JSON.stringify({ text: "good morning" }), { status: 200 });
    }
    if (url === "/api/chat") {
      const events = [
        { type: "delta", text: "Good morning to you." },
        { type: "state", pendingOffer: null, messageId: "11111111-2222-4333-8444-555555555555" },
      ];
      return new Response(events.map((e) => `${JSON.stringify(e)}\n`).join(""), {
        status: 200,
        headers: { "X-Conversation-Id": "conv-1" },
      });
    }
    return new Response("", { status: 200 });
  }));
}

/** Wake, dictate, and send — the state in which playback begins. */
async function speakAReply() {
  render(<Chat initialConversationId="conv-1" initialMessages={[]} />);
  await waitFor(() => expect(toggle()).toBeTruthy());
  fireEvent.click(toggle());
  await waitFor(() => expect(engine.starts).toBe(1));
  stubBrowser();
  engine.onWake();
  fireEvent.click(await screen.findByRole("button", { name: /stop recording/i }));
  await waitFor(() => expect(composer().value).toBe("good morning"));
  fireEvent.click(screen.getByRole("button", { name: /^send/i }));
  await waitFor(() => expect(audio.plays).toBe(1));
}

beforeEach(() => {
  window.localStorage.clear();
  vi.stubEnv("NEXT_PUBLIC_PICOVOICE_ACCESS_KEY", "pv-key");
  vi.stubEnv("NEXT_PUBLIC_NORA_KEYWORD_PATH", "/nora/Nora.ppn");
  status.value = { available: true, reason: null, availableUntil: "2026-09-25T23:59:59.999Z" };
  Object.assign(engine, { starts: 0, stops: 0, pauses: 0, resumes: 0 });
  status.asked = 0;
  Object.assign(audio, { plays: 0, stops: 0, end: () => {} });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("1. while the assistant is talking", () => {
  it("does not claim to be listening", async () => {
    await speakAReply();
    await waitFor(() => expect(screen.getByRole("button", { name: /stop reading/i })).toBeTruthy());
    expect(screen.getByText(/paused while I.m reading that out/i)).toBeTruthy();
    // The exact pair seen in the browser must never co-exist again.
    expect(screen.queryByText(/listening for .Hey Nora./i)).toBeNull();
  });

  it("the detector is not armed", async () => {
    await speakAReply();
    await waitFor(() => expect(screen.getByRole("button", { name: /stop reading/i })).toBeTruthy());
    const resumesDuringPlayback = engine.resumes;

    // Porcupine fires anyway — the assistant just said the wake word aloud.
    engine.onWake();
    await waitFor(() => expect(screen.getByText(/paused while I.m reading/i)).toBeTruthy());

    expect(screen.queryByRole("button", { name: /stop recording/i })).toBeNull();
    expect(composer().value).toBe("");
    expect(engine.resumes).toBe(resumesDuringPlayback);
  });
});

describe("2. when the audio finishes", () => {
  it("natural completion re-arms, exactly once", async () => {
    await speakAReply();
    await waitFor(() => expect(screen.getByRole("button", { name: /stop reading/i })).toBeTruthy());
    const before = engine.resumes;

    audio.end();

    await waitFor(() => expect(screen.getByText(/listening for .Hey Nora./i)).toBeTruthy());
    expect(engine.resumes).toBe(before + 1);
  });

  it("pressing Stop reading re-arms too", async () => {
    await speakAReply();
    const stopReading = await screen.findByRole("button", { name: /stop reading/i });
    const before = engine.resumes;

    fireEvent.click(stopReading);

    await waitFor(() => expect(screen.getByText(/listening for .Hey Nora./i)).toBeTruthy());
    expect(engine.resumes).toBe(before + 1);
  });

  it("re-arming revalidates against the server, like every other arm", async () => {
    // Not a resume() hung off `onended`: the arm goes through the same gate,
    // which is why the three cases in section 3 below hold for free.
    await speakAReply();
    const before = status.asked;

    audio.end();
    await waitFor(() => expect(status.asked).toBeGreaterThan(before));
  });
});

describe("3. finishing playback cannot revive a Nora that should be off", () => {
  it("switched off during playback stays off", async () => {
    await speakAReply();
    await waitFor(() => expect(screen.getByRole("button", { name: /stop reading/i })).toBeTruthy());

    fireEvent.click(toggle());
    await waitFor(() => expect(engine.stops).toBe(1));
    const before = engine.resumes;

    audio.end();
    await waitFor(() => expect(toggle().getAttribute("aria-checked")).toBe("false"));
    expect(engine.resumes).toBe(before);
  });

  it("expired during playback stays down", async () => {
    await speakAReply();
    await waitFor(() => expect(screen.getByRole("button", { name: /stop reading/i })).toBeTruthy());
    status.value = { available: false, reason: "expired", availableUntil: "2026-09-25T23:59:59.999Z" };
    const before = engine.resumes;

    audio.end();

    await waitFor(() => expect(screen.getByText(/no longer available/i)).toBeTruthy());
    expect(engine.resumes).toBe(before);
    await waitFor(() => expect(engine.stops).toBe(1));
  });

  it("a draft typed during playback still prevents re-arm", async () => {
    await speakAReply();
    await waitFor(() => expect(screen.getByRole("button", { name: /stop reading/i })).toBeTruthy());
    fireEvent.change(composer(), { target: { value: "something I typed" } });
    const before = engine.resumes;

    audio.end();

    await waitFor(() => expect(screen.getByText(/Nora is paused while you have a message/i)).toBeTruthy());
    expect(engine.resumes).toBe(before);
  });
});
