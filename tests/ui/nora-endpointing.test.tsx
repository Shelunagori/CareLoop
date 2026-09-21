import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
    // A FRESH OBJECT, like the real one (M12g). Returning the same
    // reference made `setNoraStatus` a no-op re-render and hid a live
    // defect — see tests/ui/nora-endpointing.test.tsx §17.
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
  endpointingSupported: () => watcher.supported,
  startEndpointing: (input: { onDecision: (outcome: string) => void }) => {
    if (!watcher.supported) return null;
    watcher.starts += 1;
    watcher.decide = (outcome) => {
      // The real watcher releases itself before reporting, exactly here.
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
  /**
   * These tests arm Nora BY HAND, so they start from off (M12h).
   *
   * Nora is on by default now. The sections below are about what the
   * engine does once it is armed, and they say so by clicking the toggle
   * — which only means anything if it starts off. The DEFAULT itself is
   * tested in §1, which clears this key.
   */
  window.localStorage.setItem("careloop.nora", "off");
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

/**
 * 14. WHERE THE WORDS CAME FROM (M12e).
 *
 * The pipeline was already right; it was only invisible. On a recording the
 * transcript appears in the same box a typed message appears in, so a
 * reviewer cannot tell whether anybody spoke. One line fixes that, and
 * these tests pin what it must NOT do as hard as what it must.
 */
describe("14. the voice-origin indicator", () => {
  const originLabel = () => screen.queryByText(/voice transcript/i);

  it("appears for a transcript the microphone produced", async () => {
    await wake();
    watcher.decide("speech_ended");
    await waitFor(() => expect(composer().value).toBe("good morning"));
    expect(originLabel()).toBeTruthy();
  });

  it("appears for a PRESSED recording too — origin, not wake word", async () => {
    render(<Chat initialConversationId="c" initialMessages={[]} />);
    await waitFor(() => expect(toggle()).toBeTruthy());
    stubMicrophone();
    fireEvent.click(screen.getByRole("button", { name: /start voice input/i }));
    fireEvent.click(await screen.findByRole("button", { name: /stop recording/i }));
    await waitFor(() => expect(composer().value).toBe("good morning"));
    expect(originLabel()).toBeTruthy();
  });

  it("never appears for a typed message", async () => {
    render(<Chat initialConversationId="c" initialMessages={[]} />);
    await waitFor(() => expect(toggle()).toBeTruthy());
    fireEvent.change(composer(), { target: { value: "I typed this myself." } });
    expect(originLabel()).toBeNull();
  });

  it("survives editing — correcting a misheard word is still speech", async () => {
    await wake();
    watcher.decide("speech_ended");
    await waitFor(() => expect(composer().value).toBe("good morning"));
    fireEvent.change(composer(), { target: { value: "good morning John" } });
    expect(originLabel()).toBeTruthy();
  });

  it("goes when the composer is emptied, whoever emptied it", async () => {
    await wake();
    watcher.decide("speech_ended");
    await waitFor(() => expect(composer().value).toBe("good morning"));
    fireEvent.change(composer(), { target: { value: "" } });
    await waitFor(() => expect(originLabel()).toBeNull());
  });

  it("does not imply auto-send: Send is still the only way out", async () => {
    await wake();
    watcher.decide("speech_ended");
    await waitFor(() => expect(composer().value).toBe("good morning"));

    const label = originLabel()!;
    expect(label.textContent?.toLowerCase()).toContain("send");
    expect(label.textContent?.toLowerCase()).not.toMatch(/sending|will send|sent/);
    expect(screen.getByRole("button", { name: /^send$/i })).toBeTruthy();
    // Nothing has been posted.
    const calls = (globalThis.fetch as unknown as { mock: { calls: string[][] } }).mock.calls;
    expect(calls.some((c) => c[0] === "/api/chat")).toBe(false);
  });

  it("adds no second composer", async () => {
    await wake();
    watcher.decide("speech_ended");
    await waitFor(() => expect(composer().value).toBe("good morning"));
    expect(screen.getAllByRole("textbox")).toHaveLength(1);
  });
});

/**
 * 15. THE CONVERSATION BURST (M12f).
 *
 * "Hey Nora" once, then answer the reply without saying it again. One
 * bounded window per reply, the same endpointing contract as a wake turn,
 * and silence ends the burst rather than extending it.
 */
describe("15. one wake per burst, not one per turn", () => {
  async function sendAWakeTurn() {
    await wake();
    watcher.decide("speech_ended");
    await waitFor(() => expect(composer().value).toBe("good morning"));
    fireEvent.click(screen.getByRole("button", { name: /^send$/i }));
    await waitFor(() => expect(composer().value).toBe(""));
  }

  it("opens a follow-up window after the reply, with no second wake", async () => {
    const wakes = engine.starts;
    await sendAWakeTurn();

    await waitFor(() => expect(screen.getByText(/listening for your reply/i)).toBeTruthy());
    expect(await screen.findByRole("button", { name: /stop recording/i })).toBeTruthy();
    // A fresh bounded window — a recording, not a re-armed wake engine.
    expect(watcher.starts).toBe(2);
    expect(engine.starts).toBe(wakes + 1); // only the original start
  });

  it("the follow-up transcript is still shown and still needs Send", async () => {
    await sendAWakeTurn();
    await waitFor(() => expect(screen.getByText(/listening for your reply/i)).toBeTruthy());

    watcher.decide("speech_ended");
    await waitFor(() => expect(composer().value).toBe("good morning"));

    expect(screen.getByRole("button", { name: /^send$/i })).toBeTruthy();
    const calls = (globalThis.fetch as unknown as { mock: { calls: string[][] } }).mock.calls;
    expect(calls.filter((c) => c[0] === "/api/chat")).toHaveLength(1);
  });

  it("a spoken yes is a transcript, never an authorization", async () => {
    // The consent invariant, stated where the follow-up could most easily
    // have broken it. Nothing leaves without a press, in a burst or out
    // of one.
    await sendAWakeTurn();
    await waitFor(() => expect(screen.getByText(/listening for your reply/i)).toBeTruthy());
    watcher.decide("speech_ended");
    await waitFor(() => expect(composer().value).toBe("good morning"));
    const calls = (globalThis.fetch as unknown as { mock: { calls: string[][] } }).mock.calls;
    expect(calls.filter((c) => c[0] === "/api/chat")).toHaveLength(1);
  });

  it("silence in the follow-up ends the burst and waits for the wake word again", async () => {
    await sendAWakeTurn();
    await waitFor(() => expect(screen.getByText(/listening for your reply/i)).toBeTruthy());

    watcher.decide("no_speech");

    await waitFor(() => expect(screen.getByText(/waiting for .Hey Nora./i)).toBeTruthy());
    expect(screen.queryByText(/listening for your reply/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /end voice session/i })).toBeNull();
  });

  it("exactly ONE window per reply — clearing the composer opens no second one", async () => {
    await sendAWakeTurn();
    await waitFor(() => expect(screen.getByText(/listening for your reply/i)).toBeTruthy());
    watcher.decide("speech_ended");
    await waitFor(() => expect(composer().value).toBe("good morning"));
    const windows = watcher.starts;

    // Clear resolves the draft. That must not be read as "ready for another".
    fireEvent.change(composer(), { target: { value: "" } });
    await waitFor(() => expect(composer().value).toBe(""));
    expect(watcher.starts).toBe(windows);
  });

  it("turning Nora off mid-burst ends it", async () => {
    await sendAWakeTurn();
    await waitFor(() => expect(screen.getByText(/listening for your reply/i)).toBeTruthy());

    fireEvent.click(toggle());

    await waitFor(() => expect(toggle().getAttribute("aria-checked")).toBe("false"));
    expect(screen.queryByText(/listening for your reply/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /end voice session/i })).toBeNull();
  });
});

/**
 * 16. ENDING A BURST RELEASES ITS MICROPHONE (M12f).
 *
 * Found by a flaky test rather than by reading the code, which is the
 * honest way to find a race. `startRecording` awaits a permission prompt
 * and a MediaRecorder; a person can press "End voice session" inside that
 * gap. Before the fix the recorder then opened into a burst that no longer
 * existed — the interface said "Listening", nothing would ever stop it,
 * and the microphone stayed live.
 */
describe("16. a burst that ends takes its microphone with it", () => {
  async function sendAWakeTurn() {
    await wake();
    watcher.decide("speech_ended");
    await waitFor(() => expect(composer().value).toBe("good morning"));
    fireEvent.click(screen.getByRole("button", { name: /^send$/i }));
    await waitFor(() => expect(composer().value).toBe(""));
  }

  it("End voice session closes an open follow-up window", async () => {
    await sendAWakeTurn();
    await waitFor(() => expect(screen.getByText(/listening for your reply/i)).toBeTruthy());
    expect(await screen.findByRole("button", { name: /stop recording/i })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /end voice session/i }));

    await waitFor(() => expect(screen.getByText(/waiting for .Hey Nora./i)).toBeTruthy());
    // No recorder left behind, and the watcher was released with it.
    expect(screen.queryByRole("button", { name: /stop recording/i })).toBeNull();
    expect(watcher.stops).toBeGreaterThanOrEqual(watcher.starts);
  });

  it("ending it WHILE the microphone is opening leaves nothing running", async () => {
    /**
     * The race, forced rather than hoped for.
     *
     * `startRecording` awaits `getUserMedia`. Here that await is held open
     * until the test releases it, so "End voice session" is pressed with
     * the recorder genuinely mid-flight — which is what a person does
     * while a permission prompt or a slow device is still resolving.
     *
     * Without the abort check inside `beginRecording`, the recorder opens
     * afterwards into a burst that no longer exists: the interface says
     * "Listening", nothing will ever stop it, and the microphone stays
     * live. Removing that check turns this red.
     */
    let release!: () => void;
    const opening = new Promise<void>((resolve) => {
      release = resolve;
    });
    await sendAWakeTurn();

    vi.stubGlobal("navigator", {
      mediaDevices: {
        async getUserMedia() {
          await opening;
          return { getTracks: () => [{ stop: () => {} }] };
        },
      },
    });

    await waitFor(() => expect(screen.getByText(/listening for your reply/i)).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /end voice session/i }));

    // NOW let the microphone finish opening.
    await act(async () => {
      release();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(screen.queryByRole("button", { name: /stop recording/i })).toBeNull();
    expect(screen.queryByText(/listening for your reply/i)).toBeNull();
    expect(screen.getByText(/waiting for .Hey Nora./i)).toBeTruthy();
  });

  it("typing instead of answering also closes it", async () => {
    await sendAWakeTurn();
    await waitFor(() => expect(screen.getByText(/listening for your reply/i)).toBeTruthy());

    fireEvent.change(composer(), { target: { value: "I'll type instead" } });

    await waitFor(() =>
      expect(screen.getByText(/paused while you have a message/i)).toBeTruthy(),
    );
    expect(screen.queryByRole("button", { name: /end voice session/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /stop recording/i })).toBeNull();
  });
});

/**
 * 17. THE FOLLOW-UP WINDOW MUST NOT CANCEL ITSELF (M12g).
 *
 * Reported from a live browser: "Listening for your reply" on screen,
 * nothing listening, and "Hey Nora" ignored — until End voice session,
 * after which the wake word worked again.
 *
 * The cause was a self-cancelling effect. The window's own revalidation
 * calls `setNoraStatus` with the object `fetchNoraStatus` returned; that
 * object was in the effect's dependency list, so storing it re-ran the
 * effect, whose cleanup cancelled the open the first run had just started.
 * `followUpOpenedRef` then stopped the second run from opening another, so
 * the burst sat there with no microphone and a paused wake engine.
 *
 * It needed BOTH real-world properties to show up, which is why the suite
 * missed it: a status object with a fresh identity (the fake returned the
 * same reference) and a `getUserMedia` slower than React's render flush
 * (the fake resolved in a microtask). Both are forced here.
 */
describe("17. a follow-up window survives its own revalidation", () => {
  it("opens even when the status object is new and the microphone is slow", async () => {
    let release!: () => void;
    const opening = new Promise<void>((resolve) => {
      release = resolve;
    });

    await wake();
    watcher.decide("speech_ended");
    await waitFor(() => expect(composer().value).toBe("good morning"));

    // A microphone that takes a moment, like every real one.
    vi.stubGlobal("navigator", {
      mediaDevices: {
        async getUserMedia() {
          await opening;
          return { getTracks: () => [{ stop: () => {} }] };
        },
      },
    });

    fireEvent.click(screen.getByRole("button", { name: /^send$/i }));
    await waitFor(() => expect(screen.getByText(/listening for your reply/i)).toBeTruthy());

    // Let the revalidation land and React re-render before the microphone
    // finishes opening — the exact ordering that killed it.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      release();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // The window is genuinely open.
    expect(await screen.findByRole("button", { name: /stop recording/i })).toBeTruthy();
    expect(screen.getByText(/listening for your reply/i)).toBeTruthy();
  });
});
