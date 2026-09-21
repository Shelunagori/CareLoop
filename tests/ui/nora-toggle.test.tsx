import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Nora, as a person meets it.
 *
 * Everything here is about one promise: whatever Nora does or fails to do,
 * the microphone button still works and typing still works. That promise is
 * why the wake word is allowed to be an experiment at all — M9's was removed
 * because it became the interaction rather than an addition to one.
 *
 * The engine itself is mocked. What is under test is the CONTROL: when it is
 * offered, what it says, and — most of all — that every way out of the "on"
 * state releases the session exactly once.
 */
const status = vi.hoisted(() => ({
  value: {
    available: true,
    reason: null as string | null,
    availableUntil: "2026-09-25T23:59:59.999Z",
  },
}));
const engine = vi.hoisted(() => ({
  starts: 0,
  stops: 0,
  pauses: 0,
  resumes: 0,
  failWith: null as string | null,
  onWake: (() => {}) as () => void,
}));

vi.mock("@/app/_components/nora", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/app/_components/nora")>();
  return {
    ...actual,
    fetchNoraStatus: async () => status.value,
    noraBrowserSupported: () => true,
    startNora: async (options: { onWake: () => void }) => {
      if (engine.failWith) {
        throw new actual.NoraError(
          engine.failWith as "initialization_failed" | "microphone_denied",
        );
      }
      engine.starts += 1;
      engine.onWake = options.onWake;
      return {
        stop: async () => {
          engine.stops += 1;
        },
        pause: async () => {
          engine.pauses += 1;
        },
        resume: async () => {
          engine.resumes += 1;
        },
      };
    },
  };
});

const { Chat } = await import("@/app/_components/chat");


/** A microphone that records and stops, so a wake can become a real turn. */
function stubMicrophone() {
  const stopped: string[] = [];
  class FakeRecorder {
    static isTypeSupported = (type: string) => type === "audio/webm;codecs=opus";
    state: "inactive" | "recording" = "inactive";
    mimeType = "audio/webm;codecs=opus";
    ondataavailable: ((event: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;
    start() {
      this.state = "recording";
    }
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
        return { getTracks: () => [{ stop: () => stopped.push("track") }] };
      },
    },
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url === "/api/voice/transcribe") {
        return new Response(JSON.stringify({ text: "how is John" }), { status: 200 });
      }
      return new Response("", { status: 200 });
    }),
  );
  return { stopped };
}

const toggle = () => screen.getByRole("switch", { name: /nora hands-free/i });
const mic = () => screen.getByRole("button", { name: /start voice input/i });

beforeEach(() => {
  // A remembered preference must not leak between tests: it is the input to
  // the auto-arm path, and half of what "preference is not permission" means.
  window.localStorage.clear();
  vi.stubEnv("NEXT_PUBLIC_PICOVOICE_ACCESS_KEY", "pv-key");
  vi.stubEnv("NEXT_PUBLIC_NORA_KEYWORD_PATH", "/nora/Nora.ppn");
  status.value = {
    available: true,
    reason: null,
    availableUntil: "2026-09-25T23:59:59.999Z",
  };
  Object.assign(engine, { starts: 0, stops: 0, pauses: 0, resumes: 0, failWith: null });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("1. off by default, and unoffered when unconfigured", () => {
  it("is off on every load", async () => {
    render(<Chat initialConversationId="c" initialMessages={[]} />);
    await waitFor(() => expect(toggle()).toBeTruthy());
    expect(toggle().getAttribute("aria-checked")).toBe("false");
    expect(engine.starts).toBe(0);
  });

  it("is not offered at all when this build carries no Picovoice configuration", async () => {
    vi.unstubAllEnvs();
    render(<Chat initialConversationId="c" initialMessages={[]} />);
    // Nothing rendered, and — the part that matters — nothing fetched: a
    // deployment without Nora is byte-identical to CareLoop before it.
    await waitFor(() => expect(screen.getByLabelText(/write a message/i)).toBeTruthy());
    expect(screen.queryByRole("switch", { name: /nora/i })).toBeNull();
    expect(document.body.textContent).not.toMatch(/nora/i);
  });

  it("invites the person in words, and names the phrase that was trained", async () => {
    // The .ppn is trained on "Hey Nora". Telling somebody to say "Nora"
    // and then not waking is indistinguishable, to them, from a broken
    // wake word — and that is how M9's reliability reputation was earned.
    render(<Chat initialConversationId="c" initialMessages={[]} />);
    await waitFor(() => expect(screen.getByText(/Say .Hey Nora. to start a voice turn/i)).toBeTruthy());
  });
});

describe("2. turning it on and off", () => {
  it("starts the engine and says it is listening", async () => {
    render(<Chat initialConversationId="c" initialMessages={[]} />);
    await waitFor(() => expect(toggle()).toBeTruthy());
    fireEvent.click(toggle());

    await waitFor(() => expect(toggle().getAttribute("aria-checked")).toBe("true"));
    expect(engine.starts).toBe(1);
    expect(screen.getByText(/Nora is listening for .Hey Nora./i)).toBeTruthy();
  });

  it("releases the session when turned off", async () => {
    render(<Chat initialConversationId="c" initialMessages={[]} />);
    await waitFor(() => expect(toggle()).toBeTruthy());
    fireEvent.click(toggle());
    await waitFor(() => expect(engine.starts).toBe(1));

    fireEvent.click(toggle());
    await waitFor(() => expect(engine.stops).toBe(1));
    expect(toggle().getAttribute("aria-checked")).toBe("false");
  });

  it("releases the session when the page goes away", async () => {
    const { unmount } = render(<Chat initialConversationId="c" initialMessages={[]} />);
    await waitFor(() => expect(toggle()).toBeTruthy());
    fireEvent.click(toggle());
    await waitFor(() => expect(engine.starts).toBe(1));

    unmount();
    await waitFor(() => expect(engine.stops).toBe(1));
  });
});

describe("3. push-to-talk survives every Nora state", () => {
  it("the microphone button is there with Nora off", async () => {
    render(<Chat initialConversationId="c" initialMessages={[]} />);
    await waitFor(() => expect(toggle()).toBeTruthy());
    expect(mic()).toBeTruthy();
  });

  it("the microphone button is there with Nora on", async () => {
    render(<Chat initialConversationId="c" initialMessages={[]} />);
    await waitFor(() => expect(toggle()).toBeTruthy());
    fireEvent.click(toggle());
    await waitFor(() => expect(engine.starts).toBe(1));
    expect(mic()).toBeTruthy();
  });

  it("the microphone button is there after Nora fails to start", async () => {
    engine.failWith = "initialization_failed";
    render(<Chat initialConversationId="c" initialMessages={[]} />);
    await waitFor(() => expect(toggle()).toBeTruthy());
    fireEvent.click(toggle());

    await waitFor(() =>
      expect(screen.getByText(/Nora couldn't start. Push-to-talk is still available./)).toBeTruthy(),
    );
    expect(toggle().getAttribute("aria-checked")).toBe("false");
    expect(mic()).toBeTruthy();
    // No retry loop: one failure, one sentence, nothing running.
    expect(engine.starts).toBe(0);
  });

  it("the microphone button is there after Nora has expired", async () => {
    status.value = { available: false, reason: "expired", availableUntil: "2026-09-25T23:59:59.999Z" };
    render(<Chat initialConversationId="c" initialMessages={[]} />);
    await waitFor(() =>
      expect(
        screen.getByText(
          /Nora hands-free is no longer available. You can still use the microphone button to talk to CareLoop./,
        ),
      ).toBeTruthy(),
    );
    expect(mic()).toBeTruthy();
    expect(screen.getByLabelText(/write a message/i)).toBeTruthy();
  });

  it("typing still works when Nora is denied the microphone", async () => {
    engine.failWith = "microphone_denied";
    render(<Chat initialConversationId="c" initialMessages={[]} />);
    await waitFor(() => expect(toggle()).toBeTruthy());
    fireEvent.click(toggle());

    await waitFor(() => expect(screen.getByText(/Nora needs the microphone/i)).toBeTruthy());
    fireEvent.change(screen.getByLabelText(/write a message/i), { target: { value: "hello" } });
    expect((screen.getByRole("button", { name: /^send/i }) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("4. a stale client is refused, and says so as a CareLoop state", () => {
  it("cannot turn Nora on after the cutoff, whatever it believed", async () => {
    // The browser arrives believing Nora is fine; the server disagrees.
    status.value = { available: false, reason: "expired", availableUntil: "2026-09-25T23:59:59.999Z" };
    render(<Chat initialConversationId="c" initialMessages={[]} />);
    await waitFor(() => expect(toggle()).toBeTruthy());
    fireEvent.click(toggle());

    await waitFor(() => expect(toggle().getAttribute("aria-checked")).toBe("false"));
    expect(engine.starts).toBe(0);
    expect(screen.getByText(/no longer available/i)).toBeTruthy();
  });

  it("a remembered ON does not survive an expired server answer", async () => {
    window.localStorage.setItem("careloop.nora", "on");
    status.value = { available: false, reason: "expired", availableUntil: "2026-09-25T23:59:59.999Z" };
    render(<Chat initialConversationId="c" initialMessages={[]} />);
    await waitFor(() => expect(screen.getByText(/no longer available/i)).toBeTruthy());
    expect(engine.starts).toBe(0);
    expect(toggle().getAttribute("aria-checked")).toBe("false");
  });

  it("never shows a provider, a quota or a stack trace", async () => {
    engine.failWith = "initialization_failed";
    render(<Chat initialConversationId="c" initialMessages={[]} />);
    await waitFor(() => expect(toggle()).toBeTruthy());
    fireEvent.click(toggle());
    await waitFor(() => expect(screen.getByText(/Nora couldn't start/)).toBeTruthy());

    for (const leak of [/picovoice/i, /porcupine/i, /subscription/i, /quota/i, /api key/i, /at Object\./]) {
      expect(document.body.textContent, String(leak)).not.toMatch(leak);
    }
  });
});

describe("5. a wake turn, and the draft that must stand the detector down", () => {
  /**
   * THE BUG THIS SECTION EXISTS FOR.
   *
   * In a real browser: a wake produced "good morning" as an unsent draft,
   * and the interface immediately said Nora was listening again. A second
   * wake could have opened a microphone over words the person had not
   * finished with.
   *
   * The old tests here asserted `resumes === 1` right after the transcript
   * landed — they asserted the bug. They are replaced rather than adjusted,
   * because the behaviour they described is the behaviour being removed.
   */
  const wake = async () => {
    render(<Chat initialConversationId="c" initialMessages={[]} />);
    await waitFor(() => expect(toggle()).toBeTruthy());
    fireEvent.click(toggle());
    await waitFor(() => expect(engine.starts).toBe(1));
    stubMicrophone();
    engine.onWake();
  };

  const finishTurn = async () => {
    fireEvent.click(await screen.findByRole("button", { name: /stop recording/i }));
    await waitFor(() =>
      expect((screen.getByLabelText(/write a message/i) as HTMLTextAreaElement).value).toBe(
        "how is John",
      ),
    );
  };

  it("pauses wake detection while it records, rather than listening twice", async () => {
    await wake();
    await waitFor(() => expect(engine.pauses).toBeGreaterThanOrEqual(1));
    expect(await screen.findByRole("button", { name: /stop recording/i })).toBeTruthy();
  });

  it("puts the transcript in the composer and sends nothing", async () => {
    await wake();
    await finishTurn();
    const chatCalls = (globalThis.fetch as unknown as { mock: { calls: string[][] } }).mock.calls;
    expect(chatCalls.some((c) => c[0] === "/api/chat")).toBe(false);
  });

  it("does NOT re-arm while the transcript is unresolved", async () => {
    await wake();
    const resumesBefore = engine.resumes;
    await finishTurn();

    // The whole point. Give the effects every chance to misbehave.
    await waitFor(() => expect(screen.getByText(/Nora is paused/i)).toBeTruthy());
    expect(engine.resumes).toBe(resumesBefore);
    expect(screen.queryByText(/listening for/i)).toBeNull();
  });

  it("a wake arriving anyway cannot open a microphone over the draft", async () => {
    await wake();
    await finishTurn();
    // A detection frame already in flight when the state changed.
    engine.onWake();
    await waitFor(() => expect(screen.getByText(/Nora is paused/i)).toBeTruthy());
    expect(screen.queryByRole("button", { name: /stop recording/i })).toBeNull();
    expect((screen.getByLabelText(/write a message/i) as HTMLTextAreaElement).value).toBe(
      "how is John",
    );
  });

  it("re-arms once the draft is SENT", async () => {
    await wake();
    await finishTurn();
    const resumesBefore = engine.resumes;

    fireEvent.click(screen.getByRole("button", { name: /^send/i }));
    await waitFor(() => expect(engine.resumes).toBe(resumesBefore + 1));
  });

  it("re-arms once the draft is CLEARED", async () => {
    await wake();
    await finishTurn();
    const resumesBefore = engine.resumes;

    fireEvent.click(screen.getByRole("button", { name: /^clear$/i }));
    await waitFor(() => expect(engine.resumes).toBe(resumesBefore + 1));
    expect((screen.getByLabelText(/write a message/i) as HTMLTextAreaElement).value).toBe("");
  });

  it("editing the transcript does not resolve it", async () => {
    await wake();
    await finishTurn();
    const resumesBefore = engine.resumes;

    fireEvent.change(screen.getByLabelText(/write a message/i), {
      target: { value: "how is John doing" },
    });
    await waitFor(() => expect(screen.getByText(/Nora is paused/i)).toBeTruthy());
    expect(engine.resumes).toBe(resumesBefore);
  });

  it("the person's own typing stands the detector down too", async () => {
    render(<Chat initialConversationId="c" initialMessages={[]} />);
    await waitFor(() => expect(toggle()).toBeTruthy());
    fireEvent.click(toggle());
    await waitFor(() => expect(engine.starts).toBe(1));

    fireEvent.change(screen.getByLabelText(/write a message/i), { target: { value: "hello" } });
    await waitFor(() => expect(screen.getByText(/Nora is paused while you have a message/i)).toBeTruthy());
    // And no Clear button: that text is theirs, not a transcript.
    expect(screen.queryByRole("button", { name: /^clear$/i })).toBeNull();
  });

  it("turning Nora OFF mid-draft keeps the words", async () => {
    await wake();
    await finishTurn();

    fireEvent.click(toggle());
    await waitFor(() => expect(engine.stops).toBe(1));
    expect((screen.getByLabelText(/write a message/i) as HTMLTextAreaElement).value).toBe(
      "how is John",
    );
  });

  it("expiry mid-draft keeps the words too", async () => {
    await wake();
    await finishTurn();

    status.value = { available: false, reason: "expired", availableUntil: "2026-09-25T23:59:59.999Z" };
    fireEvent.click(screen.getByRole("button", { name: /^send/i }));

    await waitFor(() => expect(screen.getByText(/no longer available/i)).toBeTruthy());
    await waitFor(() => expect(engine.stops).toBe(1));
    expect(engine.resumes).toBe(0);
  });

  it("push-to-talk still works after a Nora turn", async () => {
    await wake();
    await finishTurn();
    fireEvent.click(screen.getByRole("button", { name: /^clear$/i }));
    await waitFor(() => expect(engine.resumes).toBeGreaterThanOrEqual(1));

    fireEvent.click(screen.getByRole("button", { name: /start voice input/i }));
    expect(await screen.findByRole("button", { name: /stop recording/i })).toBeTruthy();
  });

  it("a pressed microphone stands the wake detector down as well", async () => {
    render(<Chat initialConversationId="c" initialMessages={[]} />);
    await waitFor(() => expect(toggle()).toBeTruthy());
    fireEvent.click(toggle());
    await waitFor(() => expect(engine.starts).toBe(1));
    stubMicrophone();

    const pausesBefore = engine.pauses;
    fireEvent.click(screen.getByRole("button", { name: /start voice input/i }));
    await waitFor(() => expect(engine.pauses).toBeGreaterThan(pausesBefore));
  });
});

describe("6. the page left open across the cutoff", () => {
  it("disables itself when the moment arrives, with no reload", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      status.value = {
        available: true,
        reason: null,
        availableUntil: new Date(Date.now() + 5_000).toISOString(),
      };
      render(<Chat initialConversationId="c" initialMessages={[]} />);
      await vi.waitFor(() => expect(toggle()).toBeTruthy());
      fireEvent.click(toggle());
      await vi.waitFor(() => expect(engine.starts).toBe(1));

      await vi.advanceTimersByTimeAsync(6_000);

      await vi.waitFor(() => expect(engine.stops).toBe(1));
      // RTL's waitFor, not vitest's: the teardown's state updates have to be
      // flushed through React before the interface can be asserted on.
      await waitFor(() => expect(toggle().getAttribute("aria-checked")).toBe("false"));
      expect(screen.getByText(/no longer available/i)).toBeTruthy();
      // And the fallback is untouched.
      expect(screen.getByRole("button", { name: /start voice input/i })).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
});
