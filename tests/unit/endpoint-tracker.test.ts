import { describe, expect, it } from "vitest";
import {
  createEndpointTracker,
  ENDPOINT_BOUNDS,
  type EndpointBounds,
  type EndpointOutcome,
} from "@/core/voice/endpoint";

/**
 * Deciding that one spoken turn is over.
 *
 * The browser test that prompted this found the wake word working and the
 * turn still needing a click, which makes a wake word a button with extra
 * steps. This is the smallest thing that removes the click, and it is a
 * silence detector rather than a VAD — so the tests below are mostly about
 * its BOUNDS, not its accuracy. Accuracy is a live question and is settled in
 * `docs/09-nora-acceptance.md`, not here.
 *
 * The property that matters most is the first one: exactly one decision,
 * ever. A detector that can decide twice is a recording stopped twice, or a
 * second turn started on top of the first.
 */
const B = ENDPOINT_BOUNDS;

/** Quiet room: well under any plausible threshold. */
const QUIET = 0.002;
/** Speech: well over the ceiling the threshold is clamped to. */
const LOUD = 0.2;

/** Feeds frames at `step` ms and returns every decision that came back. */
function feed(
  tracker: ReturnType<typeof createEndpointTracker>,
  frames: ReadonlyArray<{ rms: number; ms: number }>,
  step = 50,
): { decisions: EndpointOutcome[]; endedAtMs: number } {
  const decisions: EndpointOutcome[] = [];
  let atMs = 0;
  for (const frame of frames) {
    for (let elapsed = 0; elapsed < frame.ms; elapsed += step) {
      const decision = tracker.observe({ atMs, rms: frame.rms });
      if (decision) decisions.push(decision);
      atMs += step;
    }
  }
  return { decisions, endedAtMs: atMs };
}

describe("1. the bounds are named, reviewable numbers", () => {
  it("has all four safety bounds the brief asked for", () => {
    expect(B.speechStartTimeoutMs).toBe(5_000);
    expect(B.minSpeechMs).toBe(200);
    expect(B.silenceToFinalizeMs).toBe(1_500);
    expect(B.maxTurnMs).toBe(20_000);
  });

  it("ends a turn well inside the recorder's own ceiling", async () => {
    const { VOICE_LIMITS } = await import("@/core/voice/limits");
    expect(B.maxTurnMs).toBeLessThan(VOICE_LIMITS.maxRecordingSeconds * 1000);
  });
});

describe("2. speech then silence finalises, exactly once", () => {
  it("decides speech_ended after the silence threshold", () => {
    const tracker = createEndpointTracker();
    const { decisions } = feed(tracker, [
      { rms: QUIET, ms: 400 },   // calibration + a beat
      { rms: LOUD, ms: 900 },    // "good morning"
      { rms: QUIET, ms: 2_000 }, // they stop
    ]);
    expect(decisions).toEqual(["speech_ended"]);
  });

  it("does NOT finalise while the silence is still short", () => {
    const tracker = createEndpointTracker();
    const { decisions } = feed(tracker, [
      { rms: QUIET, ms: 400 },
      { rms: LOUD, ms: 900 },
      { rms: QUIET, ms: B.silenceToFinalizeMs - 200 },
    ]);
    expect(decisions).toEqual([]);
  });

  it("survives a pause mid-sentence rather than cutting the person off", () => {
    // The failure a 1.5s threshold exists to avoid: someone thinking for a
    // second in the middle of a sentence must not have the turn ended on
    // them. An older-adult product cannot afford that.
    const tracker = createEndpointTracker();
    const { decisions } = feed(tracker, [
      { rms: QUIET, ms: 400 },
      { rms: LOUD, ms: 600 },
      { rms: QUIET, ms: 1_200 }, // a real pause, under the threshold
      { rms: LOUD, ms: 600 },    // ...and they carry on
      { rms: QUIET, ms: 400 },
    ]);
    expect(decisions).toEqual([]);
  });

  it("cannot decide twice, however long the silence runs", () => {
    const tracker = createEndpointTracker();
    const { decisions } = feed(tracker, [
      { rms: QUIET, ms: 400 },
      { rms: LOUD, ms: 900 },
      { rms: QUIET, ms: 30_000 }, // long past both silence AND max duration
    ]);
    expect(decisions).toEqual(["speech_ended"]);
    // And every later frame is inert.
    expect(tracker.observe({ atMs: 999_999, rms: LOUD })).toBeNull();
    expect(tracker.inspect().decided).toBe("speech_ended");
  });
});

describe("3. nobody spoke", () => {
  it("returns no_speech at the start timeout, and transcribes nothing", () => {
    const tracker = createEndpointTracker();
    const { decisions } = feed(tracker, [{ rms: QUIET, ms: 6_000 }]);
    expect(decisions).toEqual(["no_speech"]);
  });

  it("waits the full timeout before giving up", () => {
    const tracker = createEndpointTracker();
    const { decisions } = feed(tracker, [
      { rms: QUIET, ms: B.speechStartTimeoutMs - 100 },
    ]);
    expect(decisions).toEqual([]);
  });

  it("treats a cough as no speech rather than as a turn", () => {
    // One loud frame, then nothing. `minSpeechMs` is what stops a door
    // closing from producing a transcript nobody asked for.
    const tracker = createEndpointTracker();
    const { decisions } = feed(tracker, [
      { rms: QUIET, ms: 400 },
      { rms: LOUD, ms: 50 },
      { rms: QUIET, ms: 6_000 },
    ]);
    expect(decisions).toEqual(["no_speech"]);
  });

  it("but a short 'yes' IS a turn", () => {
    // The word this product most needs to hear. ~300ms of audio.
    const tracker = createEndpointTracker();
    const { decisions } = feed(tracker, [
      { rms: QUIET, ms: 400 },
      { rms: LOUD, ms: 350 },
      { rms: QUIET, ms: 2_000 },
    ]);
    expect(decisions).toEqual(["speech_ended"]);
  });
});

describe("4. the ceiling", () => {
  it("ends a turn that never stops, and keeps what was said", () => {
    const tracker = createEndpointTracker();
    const { decisions } = feed(tracker, [
      { rms: QUIET, ms: 400 },
      { rms: LOUD, ms: 25_000 },
    ]);
    // max_duration, not no_speech: there IS audio, and discarding a long
    // answer because it was long would be the rudest possible failure.
    expect(decisions).toEqual(["max_duration"]);
  });

  it("outranks calibration, so a strange room cannot disable the ceiling", () => {
    const tracker = createEndpointTracker({ ...B, noiseFloorFrames: 100_000 });
    const { decisions } = feed(tracker, [{ rms: QUIET, ms: 21_000 }]);
    expect(decisions).toEqual(["max_duration"]);
  });
});

describe("5. the threshold is measured, and clamped at both ends", () => {
  it("adapts to a noisy room instead of hearing the room as speech", () => {
    const tracker = createEndpointTracker();
    // A room humming at 0.01 — above the absolute floor of 0.012? No: just
    // under. Calibrate, then keep humming: nothing must be heard as speech.
    const { decisions } = feed(tracker, [{ rms: 0.01, ms: 6_000 }]);
    expect(decisions).toEqual(["no_speech"]);
    expect(tracker.inspect().threshold).toBeGreaterThan(0.01);
  });

  it("never sets a threshold so high that speech is undetectable", () => {
    // Somebody who starts talking during calibration would otherwise have
    // their own voice measured as the noise floor.
    const tracker = createEndpointTracker();
    feed(tracker, [{ rms: 0.9, ms: 400 }]);
    expect(tracker.inspect().threshold).toBeLessThanOrEqual(B.maxThreshold);
  });

  it("never sets one so low that a silent room reads as speech", () => {
    const tracker = createEndpointTracker();
    feed(tracker, [{ rms: 0, ms: 400 }]);
    expect(tracker.inspect().threshold).toBeGreaterThanOrEqual(B.minThreshold);
  });
});

describe("6. the bounds are injectable, so a threshold change is testable", () => {
  it("honours a different silence window", () => {
    const fast: EndpointBounds = { ...B, silenceToFinalizeMs: 300 };
    const tracker = createEndpointTracker(fast);
    const { decisions } = feed(tracker, [
      { rms: QUIET, ms: 400 },
      { rms: LOUD, ms: 400 },
      { rms: QUIET, ms: 400 },
    ]);
    expect(decisions).toEqual(["speech_ended"]);
  });
});

describe("7. it is a silence detector, and the code says so", () => {
  it("makes no claim to be a VAD", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("core/voice/endpoint.ts", "utf8");
    // Guarding the honesty of the description, not the behaviour. M9 was
    // removed partly for being described as more than it was.
    expect(source).toMatch(/NOT voice activity detection|bounded silence detector/i);
    expect(source).not.toMatch(/production[- ]grade/i);
  });
});
