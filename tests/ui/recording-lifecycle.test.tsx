import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VOICE_LIMITS } from "@/core/voice/limits";

/**
 * The microphone goes off. Every time, on every path.
 *
 * `MediaRecorder.stop()` and releasing the MediaStream are two different
 * things, and only the second one turns off the recording light. A review
 * found a path where the first happened without the second: the client's
 * duration ceiling stopped the recorder, but the release lived in the handle's
 * `stop()`, which nobody had called. The microphone then stayed live until the
 * person next touched the page - which, at the end of a sixty-second
 * recording, is exactly when they have stopped paying attention.
 *
 * These tests are about the one invariant that cannot be allowed to rot: after
 * a recording ends, for ANY reason, no track is live. They drive the real
 * module with fake timers rather than asserting on its source.
 */
type Track = { kind: string; stopped: number };

/** A recorder and a stream that report exactly what was done to them. */
function stubMedia(
  options: { tracks?: string[]; asyncStop?: boolean; neverStops?: boolean } = {},
) {
  const tracks: Track[] = (options.tracks ?? ["audio"]).map((kind) => ({ kind, stopped: 0 }));
  const recorders: FakeRecorder[] = [];

  class FakeRecorder {
    static isTypeSupported() {
      return true;
    }
    state: "inactive" | "recording" = "inactive";
    mimeType = "audio/webm";
    ondataavailable: ((event: { data: Blob }) => void) | null = null;
    onstop: (() => void) | null = null;
    stopCalls = 0;
    constructor() {
      recorders.push(this);
    }
    start() {
      this.state = "recording";
    }
    stop() {
      this.stopCalls += 1;
      // Browsers refuse a second stop; a handle that relies on being allowed
      // one would pass a friendlier fake and fail in the real thing.
      if (this.state !== "recording") throw new Error("InvalidStateError");
      this.state = "inactive";
      const finish = () => {
        this.ondataavailable?.({ data: new Blob([new Uint8Array(2048)]) });
        this.onstop?.();
      };
      // A real MediaRecorder fires onstop on a later task, which is the gap
      // every race in this file lives in.
      if (options.neverStops) return;   // accepted, and then silence
      if (options.asyncStop) queueMicrotask(finish);
      else finish();
    }
  }

  vi.stubGlobal("MediaRecorder", FakeRecorder);
  vi.stubGlobal("window", globalThis);
  vi.stubGlobal("navigator", {
    mediaDevices: {
      getUserMedia: async () => ({
        getTracks: () => tracks.map((t) => ({ kind: t.kind, stop: () => { t.stopped += 1; } })),
      }),
    },
  });

  return {
    tracks,
    get recorder() {
      return recorders[0]!;
    },
    live: () => tracks.filter((t) => t.stopped === 0).length,
    releases: () => tracks.map((t) => t.stopped),
  };
}

const CEILING_MS = VOICE_LIMITS.maxRecordingSeconds * 1000;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("1. every ending releases the microphone", () => {
  it("manual stop releases every track", async () => {
    const media = stubMedia({ tracks: ["audio", "audio"] });
    const { startRecording } = await import("@/app/_components/voice");

    const recording = await startRecording();
    expect(media.live()).toBe(2);

    await recording.stop();
    expect(media.live()).toBe(0);
    expect(media.releases()).toEqual([1, 1]);
  });

  it("cancel releases every track", async () => {
    const media = stubMedia({ tracks: ["audio", "audio"] });
    const { startRecording } = await import("@/app/_components/voice");

    const recording = await startRecording();
    recording.cancel();

    expect(media.live()).toBe(0);
    expect(media.releases()).toEqual([1, 1]);
  });

  it("the duration ceiling releases every track, with nobody watching", async () => {
    const media = stubMedia({ tracks: ["audio", "audio"] });
    const { startRecording } = await import("@/app/_components/voice");

    await startRecording();
    // Nobody calls stop(). This is the bug: the person set the phone down and
    // the recorder hit its limit on its own.
    vi.advanceTimersByTime(CEILING_MS);

    expect(media.recorder.state).toBe("inactive");
    expect(media.live(), "tracks still live after the ceiling fired").toBe(0);
  });

  it("releases exactly once, however the endings pile up", async () => {
    const media = stubMedia({ tracks: ["audio", "audio"] });
    const { startRecording } = await import("@/app/_components/voice");

    const recording = await startRecording();
    vi.advanceTimersByTime(CEILING_MS);
    await recording.stop();
    await recording.stop();
    recording.cancel();

    // Stopping an already-stopped track is harmless in a browser, but a count
    // above one means the release logic is scattered, which is how the missing
    // path happened in the first place.
    expect(media.releases()).toEqual([1, 1]);
    expect(media.recorder.stopCalls).toBe(1);
  });
});

describe("2. the handle stays usable after it has ended itself", () => {
  it("stop after an automatic expiry resolves with the audio, not a hang", async () => {
    const media = stubMedia();
    const { startRecording } = await import("@/app/_components/voice");

    const recording = await startRecording();
    vi.advanceTimersByTime(CEILING_MS);

    const blob = await recording.stop();
    expect(blob.size).toBeGreaterThan(0);
    expect(media.live()).toBe(0);
  });

  it("two waiters both get the audio", async () => {
    stubMedia();
    const { startRecording } = await import("@/app/_components/voice");

    const recording = await startRecording();
    const [first, second] = await Promise.all([recording.stop(), recording.stop()]);

    expect(first.size).toBeGreaterThan(0);
    expect(second.size).toBe(first.size);
  });

  it("cancel after an automatic expiry is a no-op, not a second stop", async () => {
    const media = stubMedia();
    const { startRecording } = await import("@/app/_components/voice");

    const recording = await startRecording();
    vi.advanceTimersByTime(CEILING_MS);
    expect(() => recording.cancel()).not.toThrow();
    expect(media.recorder.stopCalls).toBe(1);
  });
});

describe("3. the timer does not outlive the recording", () => {
  it("manual stop clears it", async () => {
    const media = stubMedia();
    const { startRecording } = await import("@/app/_components/voice");

    const recording = await startRecording();
    await recording.stop();
    expect(vi.getTimerCount()).toBe(0);

    // And nothing detonates later.
    vi.advanceTimersByTime(CEILING_MS * 2);
    expect(media.recorder.stopCalls).toBe(1);
    expect(media.releases()).toEqual([1]);
  });

  it("cancel clears it", async () => {
    const media = stubMedia();
    const { startRecording } = await import("@/app/_components/voice");

    const recording = await startRecording();
    recording.cancel();
    expect(vi.getTimerCount()).toBe(0);

    vi.advanceTimersByTime(CEILING_MS * 2);
    expect(media.recorder.stopCalls).toBe(1);
    expect(media.releases()).toEqual([1]);
  });

  it("the ceiling is the documented one, not a number someone liked", async () => {
    const media = stubMedia();
    const { startRecording } = await import("@/app/_components/voice");

    await startRecording();
    vi.advanceTimersByTime(CEILING_MS - 1);
    expect(media.live(), "released early").toBe(1);
    vi.advanceTimersByTime(1);
    expect(media.live()).toBe(0);
  });
});

describe("4. the ceiling tells whoever is listening", () => {
  it("says so once, and only when it was the ceiling that ended it", async () => {
    stubMedia();
    const { startRecording } = await import("@/app/_components/voice");

    const reached = vi.fn();
    const recording = await startRecording({ onLimitReached: reached });
    expect(reached).not.toHaveBeenCalled();

    vi.advanceTimersByTime(CEILING_MS);
    expect(reached).toHaveBeenCalledTimes(1);

    await recording.stop();
    vi.advanceTimersByTime(CEILING_MS);
    expect(reached).toHaveBeenCalledTimes(1);
  });

  it("stays silent when the person stopped it themselves", async () => {
    stubMedia();
    const { startRecording } = await import("@/app/_components/voice");

    const reached = vi.fn();
    const recording = await startRecording({ onLimitReached: reached });
    await recording.stop();
    vi.advanceTimersByTime(CEILING_MS * 2);

    expect(reached).not.toHaveBeenCalled();
  });
});

describe("5. the interface does not go on listening after the recording has ended", () => {
  // Testing Library polls with real timers, so these two let the clock run
  // while still allowing the ceiling to be jumped to.
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  it("the ceiling takes the composer out of 'Listening…' by itself", async () => {
    const media = stubMedia();
    const { render, screen, waitFor } = await import("@testing-library/react");
    const { Chat } = await import("@/app/_components/chat");

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url === "/api/voice/transcribe"
          ? new Response(JSON.stringify({ text: "I saw John on Tuesday" }), { status: 200 })
          : new Response("{}", { status: 200 }),
      ),
    );

    render(<Chat initialConversationId="c" initialMessages={[]} />);
    const { fireEvent } = await import("@testing-library/react");
    fireEvent.click(screen.getByRole("button", { name: /start voice input/i }));
    await waitFor(() => screen.getByRole("button", { name: /stop recording/i }));
    expect(screen.getByText("Listening…")).toBeTruthy();

    // The person has put the phone down. Nobody presses anything.
    await vi.advanceTimersByTimeAsync(CEILING_MS);

    // The microphone is off, the interface has stopped claiming otherwise,
    // and the words the ceiling did capture are not thrown away.
    expect(media.live()).toBe(0);
    await waitFor(() => expect(screen.queryByText("Listening…")).toBeNull());
    await waitFor(() =>
      expect((screen.getByLabelText(/write a message/i) as HTMLTextAreaElement).value).toBe(
        "I saw John on Tuesday",
      ),
    );

    // And it is still the person who sends it.
    const calls = vi.mocked(fetch).mock.calls.map(([url]) => url);
    expect(calls).not.toContain("/api/chat");
    expect(screen.getByRole("button", { name: /^send/i })).toBeTruthy();
  });

  it("says why the recording ended, without inventing a new state", async () => {
    stubMedia();
    const { render, screen, waitFor, fireEvent } = await import("@testing-library/react");
    const { Chat } = await import("@/app/_components/chat");

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ text: "hello" }), { status: 200 })),
    );

    render(<Chat initialConversationId="c" initialMessages={[]} />);
    fireEvent.click(screen.getByRole("button", { name: /start voice input/i }));
    await waitFor(() => screen.getByRole("button", { name: /stop recording/i }));
    await vi.advanceTimersByTimeAsync(CEILING_MS);

    // One plain sentence. Not a mode, not a dialog, not a decision to make.
    const note = await screen.findByRole("status");
    expect(note.textContent).toMatch(/as long as/i);
    expect(note.textContent).not.toMatch(/error|failed/i);
  });
});


describe("6. the gap between stop() and onstop", () => {
  /**
   * A browser does not fire `onstop` synchronously. Everything below happens
   * in the window after the recorder has gone inactive and before the ending
   * has run - which is where a second release, or a promise with nobody left
   * to resolve it, would hide.
   */
  it("a stop arriving while onstop is in flight still releases exactly once", async () => {
    const media = stubMedia({ asyncStop: true });
    const { startRecording } = await import("@/app/_components/voice");

    const recording = await startRecording();
    vi.advanceTimersByTime(CEILING_MS);           // recorder stopped, onstop pending
    expect(media.recorder.state).toBe("inactive");

    const blob = await recording.stop();           // lands in the gap
    await Promise.resolve();                       // let the pending onstop through
    await Promise.resolve();

    expect(blob.size).toBeGreaterThan(0);
    expect(media.releases(), "the microphone was released twice").toEqual([1]);
  });

  it("every waiter queued in the gap is answered", async () => {
    stubMedia({ asyncStop: true });
    const { startRecording } = await import("@/app/_components/voice");

    const recording = await startRecording();
    // Three callers, all before anything has settled. A handle that remembers
    // one of them leaves two promises pending for the life of the page.
    const all = Promise.all([recording.stop(), recording.stop(), recording.stop()]);
    const sizes = (await all).map((b) => b.size);

    expect(sizes).toHaveLength(3);
    expect(new Set(sizes).size).toBe(1);
    expect(sizes[0]).toBeGreaterThan(0);
  });

  it("a browser that never fires onstop still gives the microphone back", async () => {
    // The pathological case: stop() is accepted, the audio never arrives, and
    // onstop never comes. Better a short recording than a live microphone.
    const media = stubMedia({ neverStops: true });
    const { startRecording } = await import("@/app/_components/voice");

    const recording = await startRecording();
    const pending = recording.stop();
    expect(media.live(), "released before the grace period").toBe(1);

    await vi.advanceTimersByTimeAsync(1000);

    await expect(pending).resolves.toBeInstanceOf(Blob);
    expect(media.live()).toBe(0);
  });

  it("an ending the handle never asked for is still an ending", async () => {
    // The device is unplugged, or permission is revoked mid-sentence: the
    // browser stops the recorder on its own. Nobody here called stop(), so
    // this arrives through onstop and nowhere else - and the person's press,
    // whenever it comes, must still resolve rather than hang on a recording
    // that is already over.
    const media = stubMedia();
    const { startRecording } = await import("@/app/_components/voice");

    const recording = await startRecording();
    media.recorder.stop();                 // the browser's doing, not ours

    expect(media.live(), "a browser-initiated stop left the tracks live").toBe(0);
    expect(vi.getTimerCount()).toBe(0);

    await expect(recording.stop()).resolves.toBeInstanceOf(Blob);
    expect(() => recording.cancel()).not.toThrow();
    expect(media.releases()).toEqual([1]);
    expect(media.recorder.stopCalls).toBe(1);
  });

  it("a cancel in the gap does not stop the recorder a second time", async () => {
    const media = stubMedia({ asyncStop: true });
    const { startRecording } = await import("@/app/_components/voice");

    const recording = await startRecording();
    vi.advanceTimersByTime(CEILING_MS);
    recording.cancel();
    await Promise.resolve();
    await Promise.resolve();

    expect(media.recorder.stopCalls).toBe(1);
    expect(media.releases()).toEqual([1]);
  });
});
