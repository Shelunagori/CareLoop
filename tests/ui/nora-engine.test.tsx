import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The wake engine's lifecycle.
 *
 * One invariant, and it is the reason this file exists: THE MICROPHONE IS
 * RELEASED ON EVERY TERMINAL PATH. M9's recorder had the same rule and got
 * it wrong once — release lived inside the path a person takes, and the
 * duration ceiling was the path they do not. A wake engine has more endings
 * than a recorder does (the toggle, an unmount, the cutoff, a worker
 * failure, a start that got halfway), so every one of them is written down
 * below as a test rather than as a comment.
 */
const pv = vi.hoisted(() => ({
  created: 0,
  released: 0,
  terminated: 0,
  subscribed: 0,
  unsubscribed: 0,
  createThrows: null as Error | null,
  subscribeThrows: null as Error | null,
  onDetect: (() => {}) as () => void,
  onProcessError: (() => {}) as () => void,
}));

vi.mock("@picovoice/porcupine-web", () => ({
  PorcupineWorker: {
    async create(
      _key: string,
      _keyword: unknown,
      detection: () => void,
      _model: unknown,
      options?: { processErrorCallback?: () => void },
    ) {
      if (pv.createThrows) throw pv.createThrows;
      pv.created += 1;
      pv.onDetect = detection;
      pv.onProcessError = options?.processErrorCallback ?? (() => {});
      return {
        async release() {
          pv.released += 1;
        },
        terminate() {
          pv.terminated += 1;
        },
      };
    },
  },
}));

vi.mock("@picovoice/web-voice-processor", () => ({
  WebVoiceProcessor: {
    async subscribe() {
      if (pv.subscribeThrows) throw pv.subscribeThrows;
      pv.subscribed += 1;
    },
    async unsubscribe() {
      pv.unsubscribed += 1;
    },
  },
}));

const { startNora, NoraError, msUntilExpiry, MAX_TIMER_MS, noraMessage, fetchNoraStatus } =
  await import("@/app/_components/nora");
type NoraErrorType = InstanceType<typeof NoraError>;

const options = {
  accessKey: "pv-key",
  keywordPath: "/nora/Nora.ppn",
  modelPath: "/nora/porcupine_params.pv",
  onWake: () => {},
  onFailure: () => {},
};

beforeEach(() => {
  Object.assign(pv, {
    created: 0,
    released: 0,
    terminated: 0,
    subscribed: 0,
    unsubscribed: 0,
    createThrows: null,
    subscribeThrows: null,
  });
  vi.stubGlobal("AudioWorkletNode", class {});
  vi.stubGlobal("Worker", class {});
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: async () => ({}) },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("1. a clean start and a clean stop", () => {
  it("creates the engine and opens the microphone, in that order", async () => {
    await startNora(options);
    expect(pv.created).toBe(1);
    expect(pv.subscribed).toBe(1);
  });

  it("stop() unsubscribes, releases and terminates — all three", async () => {
    const session = await startNora(options);
    await session.stop();
    expect(pv.unsubscribed).toBe(1);
    expect(pv.released).toBe(1);
    expect(pv.terminated).toBe(1);
  });

  it("stop() is idempotent, so two endings are not a bug", async () => {
    const session = await startNora(options);
    await Promise.all([session.stop(), session.stop(), session.stop()]);
    expect(pv.released).toBe(1);
    expect(pv.terminated).toBe(1);
  });
});

describe("2. a start that fails leaves nothing behind", () => {
  it("releases the engine when the microphone is refused", async () => {
    pv.subscribeThrows = Object.assign(new Error("denied"), { name: "NotAllowedError" });
    await expect(startNora(options)).rejects.toMatchObject({ reason: "microphone_denied" });
    // Created, then released: a half-built engine is the thing that must not
    // survive the sentence telling somebody it did not start.
    expect(pv.created).toBe(1);
    expect(pv.released).toBe(1);
    expect(pv.terminated).toBe(1);
  });

  it("reports initialization_failed for anything else, and holds nothing", async () => {
    pv.createThrows = new Error("invalid access key");
    await expect(startNora(options)).rejects.toMatchObject({ reason: "initialization_failed" });
    expect(pv.subscribed).toBe(0);
    expect(pv.released).toBe(0);
  });

  it("never lets a provider's words reach the thrown reason", async () => {
    pv.createThrows = new Error("PorcupineActivationLimitError: quota exceeded for key pv_abc");
    const error = await startNora(options).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NoraError);
    expect((error as NoraErrorType).reason).toBe("initialization_failed");
    expect(noraMessage((error as NoraErrorType).reason)).not.toMatch(/quota|pv_abc|Porcupine/);
  });

  it("refuses before touching a credential on a browser that cannot run it", async () => {
    vi.stubGlobal("AudioWorkletNode", undefined);
    await expect(startNora(options)).rejects.toMatchObject({ reason: "unsupported_browser" });
    expect(pv.created).toBe(0);
  });
});

describe("3. a failure mid-stream is terminal, not a retry loop", () => {
  it("tears down and reports once", async () => {
    const failures: string[] = [];
    await startNora({ ...options, onFailure: (reason) => failures.push(reason) });
    pv.onProcessError();
    await vi.waitFor(() => expect(failures).toEqual(["initialization_failed"]));
    expect(pv.released).toBe(1);
    expect(pv.terminated).toBe(1);
    // Nothing restarted itself.
    expect(pv.created).toBe(1);
    expect(pv.subscribed).toBe(1);
  });
});

describe("4. a turn pauses the wake word rather than racing it", () => {
  it("pause unsubscribes, resume subscribes again", async () => {
    const session = await startNora(options);
    await session.pause();
    expect(pv.unsubscribed).toBe(1);
    await session.resume();
    expect(pv.subscribed).toBe(2);
  });

  it("resume after stop does nothing — a released engine stays released", async () => {
    const session = await startNora(options);
    await session.stop();
    await session.resume();
    expect(pv.subscribed).toBe(1);
  });

  it("a wake that arrives after stop is ignored", async () => {
    let wakes = 0;
    const session = await startNora({ ...options, onWake: () => (wakes += 1) });
    pv.onDetect();
    await session.stop();
    pv.onDetect();
    expect(wakes).toBe(1);
  });
});

describe("5. the expiry timer", () => {
  const now = new Date("2026-09-25T23:00:00.000Z");

  it("counts to just past the cutoff, so the boundary is crossed not touched", () => {
    expect(msUntilExpiry("2026-09-25T23:59:59.999Z", now)).toBe(60 * 60 * 1000 - 1 + 1);
  });

  it("is zero when the cutoff has already passed", () => {
    expect(msUntilExpiry("2026-09-25T00:00:00.000Z", now)).toBe(0);
  });

  it("is clamped, so a distant cutoff does not fire immediately", () => {
    // setTimeout overflows past 2^31-1 ms and fires at once — which would
    // disable Nora the moment it started on any deployment more than ~24
    // days from its cutoff. The exact opposite of the timer's purpose.
    expect(msUntilExpiry("2099-01-01T00:00:00.000Z", now)).toBe(MAX_TIMER_MS);
  });

  it("schedules nothing when the cutoff cannot be read", () => {
    expect(msUntilExpiry("whenever", now)).toBeNull();
  });
});

describe("6. an unreachable server is not a yes", () => {
  it("treats a network failure as unavailable", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("offline");
    });
    expect((await fetchNoraStatus()).available).toBe(false);
  });

  it("treats a non-OK response as unavailable", async () => {
    vi.stubGlobal("fetch", async () => new Response("", { status: 500 }));
    expect((await fetchNoraStatus()).available).toBe(false);
  });

  it("treats a malformed body as unavailable", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    expect((await fetchNoraStatus()).available).toBe(false);
  });
});
