import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENDPOINT_BOUNDS } from "@/core/voice/endpoint";

/**
 * THE WHOLE BURST, END TO END (M12i / M12j).
 *
 * Reported twice from a real browser: say "Hey Nora", speak, Send, let the
 * reply be read out, let the follow-up window open, then say nothing. Nora
 * goes quiet — and "Hey Nora" no longer works. Pressing **End voice
 * session** and saying it again works immediately, so the engine is not
 * broken; something leaves the burst in a state nothing can get out of.
 *
 * WHY NO EXISTING TEST CAUGHT IT. The two halves of a turn were mocked in
 * two different files: `nora-endpointing` has the watcher and no playback,
 * `nora-tts` has playback and stubs the watcher out entirely (jsdom has no
 * Web Audio). The reported sequence needs BOTH — a reply read aloud AND a
 * follow-up window that has to end on its own — and that combination
 * existed nowhere. This file is that combination, plus the third thing no
 * mock had ever modelled: a `getUserMedia` that takes time to resolve.
 *
 * Every assertion here is on the ENGINE, never only on a label. "Waiting
 * for Hey Nora" on screen while the detector is unsubscribed is precisely
 * the divergence this product has now shipped twice.
 */
const status = vi.hoisted(() => ({
  asked: 0,
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
const audio = vi.hoisted(() => ({ plays: 0, stops: 0, end: (() => {}) as () => void }));
const watcher = vi.hoisted(() => ({
  starts: 0,
  stops: 0,
  /** false models a browser (or a moment) in which Web Audio will not start. */
  available: true,
  /** What the watcher would report if the backstop asks. */
  speaking: false,
  decide: (() => {}) as (outcome: string) => void,
}));

vi.mock("@/app/_components/nora", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/app/_components/nora")>();
  return {
    ...actual,
    fetchNoraStatus: async () => {
      status.asked += 1;
      // A FRESH OBJECT, like the real one (M12g).
      return { ...status.value };
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

vi.mock("@/app/_components/endpoint", () => ({
  endpointingSupported: () => watcher.available,
  startEndpointing: (input: { onDecision: (outcome: string) => void }) => {
    if (!watcher.available) return null;
    watcher.starts += 1;
    watcher.decide = (outcome) => {
      // The real watcher releases itself before reporting, exactly here.
      watcher.stops += 1;
      input.onDecision(outcome);
    };
    return {
      stop: () => { watcher.stops += 1; },
      inspect: () => ({ decided: null, speechStarted: watcher.speaking }),
    };
  },
}));

const { Chat } = await import("@/app/_components/chat");

/**
 * THE MICROPHONE'S OPENING GAP.
 *
 * `getUserMedia` resolves in a microtask in every other test in this
 * repository, and in no browser anywhere. The M12j bug lives entirely
 * inside that gap, which is why no test had ever seen it.
 */
const mic = { hold: false, release: (() => {}) as () => void };

/** What the transcriber returns. Two words by default, so the default
 *  journey through this file never triggers the auto-send countdown. */
let transcript = "good morning";

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
    mediaDevices: {
      async getUserMedia() {
        if (mic.hold) await new Promise<void>((resolve) => { mic.release = resolve; });
        return { getTracks: () => [{ stop: () => {} }] };
      },
    },
  });
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url === "/api/voice/transcribe") {
      return new Response(JSON.stringify({ text: transcript }), { status: 200 });
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

const toggle = () => screen.getByRole("switch", { name: /nora hands-free/i });
const composer = () => screen.getByLabelText(/write a message/i) as HTMLTextAreaElement;
const endButton = () => screen.queryByRole("button", { name: /end voice session/i });
const stopButton = () => screen.queryByRole("button", { name: /stop recording/i });

/** Let every pending microtask and timer callback run. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/** Advance the clock inside act, so timer-driven state lands. */
const tick = async (ms: number) => {
  await act(async () => {
    vi.advanceTimersByTime(ms);
  });
  await settle();
};

/**
 * Steps 1-6 of the report: wake, speak, Send, the reply is read to the end,
 * and the bounded follow-up window is opened.
 */
async function intoTheFollowUpWindow(options: { holdFollowUpMic?: boolean } = {}) {
  render(<Chat initialConversationId="conv-1" initialMessages={[]} />);
  await waitFor(() => expect(toggle()).toBeTruthy());
  fireEvent.click(toggle());
  await waitFor(() => expect(engine.starts).toBe(1));
  stubBrowser();

  engine.onWake();
  // The Stop button, not the watcher: this helper has to work on a browser
  // where no watcher can start, which is one of the cases under test.
  await screen.findByRole("button", { name: /stop recording/i });
  if (watcher.available) watcher.decide("speech_ended");
  else fireEvent.click(screen.getByRole("button", { name: /stop recording/i }));
  await waitFor(() => expect(composer().value).toBe(transcript));
  if (screen.queryByRole("button", { name: /^cancel$/i })) {
    // A long first utterance would count down; these tests drive Send.
    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));
  }
  fireEvent.click(screen.getByRole("button", { name: /^send$/i }));

  await waitFor(() => expect(audio.plays).toBe(1));
  // Held only from HERE, so the first wake turn opens normally and it is
  // the FOLLOW-UP window that catches the microphone mid-open.
  if (options.holdFollowUpMic) mic.hold = true;
  audio.end();
  await waitFor(() => expect(screen.getByText(/listening for your reply/i)).toBeTruthy());
  await settle();
}

/** Everything that must be true once a burst has closed. */
async function expectWakeReady(resumesBefore: number) {
  await waitFor(() => expect(screen.getByText(/waiting for .Hey Nora./i)).toBeTruthy());
  expect(screen.queryByText(/listening for your reply/i)).toBeNull();
  expect(endButton()).toBeNull();
  expect(stopButton()).toBeNull();
  expect(composer().value).toBe("");
  await waitFor(() => expect(engine.resumes).toBe(resumesBefore + 1));
  await settle();
  expect(engine.resumes).toBe(resumesBefore + 1);

  // And the engine really is subscribed — the label is not the test.
  engine.onWake();
  expect(await screen.findByRole("button", { name: /stop recording/i })).toBeTruthy();
}

beforeEach(() => {
  /**
   * Fake timers for the WHOLE file, installed before anything renders: the
   * application's bounds are armed inside `beginRecording`, so a test that
   * switched to fake timers afterwards would lose the very timer it wants
   * to advance. `shouldAdvanceTime` keeps `waitFor` working normally.
   */
  vi.useFakeTimers({ shouldAdvanceTime: true });
  window.localStorage.clear();
  window.sessionStorage.clear();
  window.localStorage.setItem("careloop.nora", "off");
  vi.stubEnv("NEXT_PUBLIC_PICOVOICE_ACCESS_KEY", "pv-key");
  vi.stubEnv("NEXT_PUBLIC_NORA_KEYWORD_PATH", "/nora/Nora.ppn");
  status.value = { available: true, reason: null, availableUntil: "2026-09-25T23:59:59.999Z" };
  status.asked = 0;
  Object.assign(engine, { starts: 0, stops: 0, pauses: 0, resumes: 0 });
  Object.assign(audio, { plays: 0, stops: 0, end: () => {} });
  Object.assign(watcher, { starts: 0, stops: 0, available: true, speaking: false });
  transcript = "good morning";
  mic.hold = false;
  mic.release = () => {};
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("1. the reported sequence", () => {
  it("opens a follow-up window once the reply has been read out", async () => {
    await intoTheFollowUpWindow();
    // A fresh bounded recording with its own watcher — not a re-armed engine.
    expect(watcher.starts).toBe(2);
    expect(endButton()).toBeTruthy();
    expect(stopButton()).toBeTruthy();
  });

  it("silence closes the window and puts the wake detector BACK", async () => {
    await intoTheFollowUpWindow();
    const resumesBefore = engine.resumes;

    watcher.decide("no_speech");

    await expectWakeReady(resumesBefore);
  });
});

describe("2. two consecutive bursts, with no stale refs", () => {
  it("the second silent burst closes exactly like the first", async () => {
    await intoTheFollowUpWindow();
    watcher.decide("no_speech");
    await waitFor(() => expect(screen.getByText(/waiting for .Hey Nora./i)).toBeTruthy());
    await settle();

    engine.onWake();
    await waitFor(() => expect(stopButton()).toBeTruthy());
    watcher.decide("speech_ended");
    await waitFor(() => expect(composer().value).toBe("good morning"));
    fireEvent.click(screen.getByRole("button", { name: /^send$/i }));
    await waitFor(() => expect(audio.plays).toBe(2));
    audio.end();
    await waitFor(() => expect(screen.getByText(/listening for your reply/i)).toBeTruthy());
    await settle();

    const resumesBefore = engine.resumes;
    watcher.decide("no_speech");
    await expectWakeReady(resumesBefore);
  });
});

describe("3. automatic silence and manual End reach the same place", () => {
  it("manual End", async () => {
    await intoTheFollowUpWindow();
    const resumesBefore = engine.resumes;
    fireEvent.click(endButton()!);
    await expectWakeReady(resumesBefore);
  });

  it("automatic no_speech", async () => {
    await intoTheFollowUpWindow();
    const resumesBefore = engine.resumes;
    watcher.decide("no_speech");
    await expectWakeReady(resumesBefore);
  });
});

describe("4. an OPEN window is bounded by the application, not by the watcher", () => {
  /**
   * M12i. `startEndpointing` can return null, and its exceptions are
   * swallowed by the recorder because an observer must never fail a
   * recording. Both are correct — but the interface promises a bounded
   * window either way, and only the watcher was keeping that promise.
   */
  it("closes a silent follow-up even when no watcher could start", async () => {
    watcher.available = false;
    await intoTheFollowUpWindow();
    expect(endButton()).toBeTruthy();
    const resumesBefore = engine.resumes;

    await tick(ENDPOINT_BOUNDS.speechStartTimeoutMs + ENDPOINT_BOUNDS.backstopGraceMs + 100);

    watcher.available = true; // so the re-check below can open a real turn
    await expectWakeReady(resumesBefore);
  }, 20_000);

  it("closes one whose watcher started and then never decided", async () => {
    await intoTheFollowUpWindow();
    expect(watcher.starts).toBe(2);
    const resumesBefore = engine.resumes;

    await tick(ENDPOINT_BOUNDS.speechStartTimeoutMs + ENDPOINT_BOUNDS.backstopGraceMs + 100);

    await expectWakeReady(resumesBefore);
  }, 20_000);

  it("does not cut a turn short when somebody IS speaking", async () => {
    await intoTheFollowUpWindow();
    watcher.speaking = true;

    await tick(ENDPOINT_BOUNDS.speechStartTimeoutMs + ENDPOINT_BOUNDS.backstopGraceMs + 100);
    expect(stopButton()).toBeTruthy();

    watcher.decide("speech_ended");
    await waitFor(() => expect(composer().value).toBe("good morning"));
  }, 20_000);

  it("but still bounds a turn whose watcher heard speech and then went quiet", async () => {
    await intoTheFollowUpWindow();
    watcher.speaking = true;
    const resumesBefore = engine.resumes;

    await tick(ENDPOINT_BOUNDS.maxTurnMs + ENDPOINT_BOUNDS.backstopGraceMs + 100);

    watcher.speaking = false;
    await waitFor(() => expect(composer().value).toBe("good morning"));
    // A turn that produced words ends as a draft, so the detector stays
    // down — that is the draft rule, not a failure to re-arm.
    expect(screen.getByText(/Message ready/i)).toBeTruthy();
    expect(engine.resumes).toBe(resumesBefore);
  }, 30_000);

  it("a closed window's timer cannot reach into a later push-to-talk", async () => {
    await intoTheFollowUpWindow();
    fireEvent.click(endButton()!);
    await waitFor(() => expect(screen.getByText(/waiting for .Hey Nora./i)).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: /start voice input/i }));
    await screen.findByRole("button", { name: /stop recording/i });

    await tick(ENDPOINT_BOUNDS.speechStartTimeoutMs + ENDPOINT_BOUNDS.backstopGraceMs + 500);
    expect(stopButton()).toBeTruthy();
  }, 20_000);
});

describe("5. a window cancelled while the microphone was opening (M12j)", () => {
  /**
   * THE BUG IN THE SCREEN RECORDING.
   *
   * "Listening for your reply" on screen, and the composer still showing
   * its plain microphone icon instead of the Stop control — for
   * twenty-four seconds, until End voice session was pressed.
   *
   * The recorder never opened. `beginRecording` awaits `getUserMedia`, and
   * if the follow-up effect re-runs in that gap its cleanup sets
   * `cancelled`, so the abort check releases the microphone and returns
   * silently: burst live, `followUpOpenedRef` true so nothing retries,
   * wake detector paused because a burst is never armed.
   *
   * M12g closed one dependency that could re-run that effect. The array
   * holds seven others, and a person typing one character while the window
   * opens is enough. So the fix is not another dependency: an aborted
   * window must not strand a burst, and the bound belongs to the BURST
   * rather than to a recording that may never exist.
   *
   * The M12i backstop cannot help here — it is armed after the microphone
   * opens, which is the thing that never happened.
   */
  it("never leaves the page claiming to listen with no microphone", async () => {
    await intoTheFollowUpWindow({ holdFollowUpMic: true });
    expect(stopButton()).toBeNull();

    // Any dependency of the follow-up effect will do; typing is the one a
    // person actually does.
    fireEvent.change(composer(), { target: { value: "x" } });
    fireEvent.change(composer(), { target: { value: "" } });
    mic.hold = false;
    await act(async () => {
      mic.release();
      await Promise.resolve();
    });
    await settle();

    // Whatever it does next, THIS is the state that must not persist.
    await waitFor(() => {
      expect(stopButton() ?? screen.queryByText(/waiting for .Hey Nora./i)).toBeTruthy();
    });
  }, 20_000);

  it("ends the burst if no microphone ever arrives, and re-arms the wake word", async () => {
    await intoTheFollowUpWindow({ holdFollowUpMic: true });
    const resumesBefore = engine.resumes;
    expect(endButton()).toBeTruthy();
    expect(stopButton()).toBeNull();

    await tick(ENDPOINT_BOUNDS.speechStartTimeoutMs + ENDPOINT_BOUNDS.backstopGraceMs + 500);
    mic.hold = false;
    mic.release();
    await settle();

    await expectWakeReady(resumesBefore);
  }, 20_000);

  it("a real recording releases the burst watchdog", async () => {
    // The watchdog is about a window that never opened. Once one has, the
    // turn belongs to the watcher and its own ceiling.
    await intoTheFollowUpWindow();
    expect(stopButton()).toBeTruthy();
    watcher.speaking = true;

    await tick(ENDPOINT_BOUNDS.speechStartTimeoutMs + ENDPOINT_BOUNDS.backstopGraceMs + 500);
    expect(stopButton()).toBeTruthy();
    expect(endButton()).toBeTruthy();
  }, 20_000);
});

describe("6. the burst still ends for every other reason", () => {
  it("Nora turned off during the follow-up does not re-arm", async () => {
    await intoTheFollowUpWindow();
    const resumesBefore = engine.resumes;
    fireEvent.click(toggle());
    await waitFor(() => expect(engine.stops).toBe(1));
    await tick(ENDPOINT_BOUNDS.maxTurnMs + ENDPOINT_BOUNDS.backstopGraceMs + 100);
    expect(engine.resumes).toBe(resumesBefore);
    expect(endButton()).toBeNull();
  }, 30_000);

  it("expiry during the follow-up does not re-arm", async () => {
    await intoTheFollowUpWindow();
    const resumesBefore = engine.resumes;
    status.value = { available: false, reason: "expired", availableUntil: "2026-09-25T23:59:59.999Z" };

    watcher.decide("no_speech");
    await waitFor(() => expect(screen.getByText(/no longer available/i)).toBeTruthy());
    await settle();
    expect(engine.resumes).toBe(resumesBefore);
    expect(endButton()).toBeNull();
  });

  it("an unresolved transcript keeps the detector down", async () => {
    await intoTheFollowUpWindow();
    const resumesBefore = engine.resumes;

    watcher.decide("speech_ended");
    await waitFor(() => expect(composer().value).toBe("good morning"));
    await settle();

    expect(engine.resumes).toBe(resumesBefore);
    expect(screen.getByText(/Message ready/i)).toBeTruthy();
    // Nothing was sent: a spoken answer is a draft until Send.
    const calls = (globalThis.fetch as unknown as { mock: { calls: string[][] } }).mock.calls;
    expect(calls.filter((c) => c[0] === "/api/chat")).toHaveLength(1);
  });

  it("speech in the follow-up still produces an editable transcript", async () => {
    await intoTheFollowUpWindow();
    watcher.decide("speech_ended");
    await waitFor(() => expect(composer().value).toBe("good morning"));
    expect(screen.getByRole("button", { name: /^send$/i })).toBeTruthy();
    expect(screen.getByText(/Voice transcript/i)).toBeTruthy();
  });
});
