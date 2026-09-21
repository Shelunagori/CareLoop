/**
 * End of one spoken turn, decided from audio energy (M12).
 *
 * WHAT THIS IS, PLAINLY: a bounded silence detector. It is NOT voice activity
 * detection in the sense a speech vendor means it — there is no model, no
 * spectral analysis, no noise suppression and no speaker adaptation. It
 * compares short-window loudness against a floor measured at the start of the
 * turn, and it gives up after fixed deadlines. Calling it a VAD would be
 * claiming a robustness it does not have, and M9 died of exactly that kind of
 * claim.
 *
 * WHY IT IS ACCEPTABLE ANYWAY: it is bounded on all four sides, it runs only
 * while a post-wake recording is already open, and every way it can be wrong
 * has a floor under it. Too eager and the person sees a short transcript they
 * can edit or clear. Too slow and `maxTurnMs` ends the turn. Deaf and
 * `speechStartTimeoutMs` returns to the wake state with nothing submitted.
 * None of those states can send anything: the transcript still lands in the
 * composer and still waits for a press.
 *
 * WHAT IT IS NOT ALLOWED TO BECOME: the M9 session machine. There is no
 * continuous monitoring, no listening between turns, no idle timer keeping a
 * conversation open. One decision per turn, then the caller tears it down.
 *
 * This module is PURE — timestamps and loudness in, one decision out. The Web
 * Audio plumbing lives in `app/_components/endpoint.ts`, which is the only
 * thing that has to be exercised in a browser.
 */

export type EndpointOutcome =
  /** Speech happened and then stopped for long enough. Transcribe it. */
  | "speech_ended"
  /** Nothing loud enough arrived in time. Discard; do not transcribe. */
  | "no_speech"
  /** The ceiling. Transcribe what there is rather than throw it away. */
  | "max_duration";

export type EndpointBounds = {
  /** How long after the wake the person has to start speaking. */
  readonly speechStartTimeoutMs: number;
  /**
   * How much speech must have happened before trailing silence may end the
   * turn. Guards against a cough or a door closing being treated as a turn.
   * Deliberately short: "yes" and "no" are the words this product most needs
   * to hear, and a spoken "yes" is only about 300ms of audio.
   */
  readonly minSpeechMs: number;
  /**
   * Trailing silence that ends the turn. The number most likely to need
   * tuning against real speakers: too short clips people who pause
   * mid-sentence, which older adults do more than the engineers testing it.
   */
  readonly silenceToFinalizeMs: number;
  /** Absolute ceiling for one Nora turn. Well inside the recorder's own. */
  readonly maxTurnMs: number;
  /** Frames used to measure the room before any decision is made. */
  readonly noiseFloorFrames: number;
  /** Speech is this many times the measured floor. */
  readonly thresholdRatio: number;
  /** The floor's floor, for a silent room where the measured floor is ~0. */
  readonly minThreshold: number;
  /**
   * How long after a deadline the APPLICATION's own bound fires (M12i).
   *
   * The watcher is an optimisation; the bound is the application's. A
   * follow-up window whose watcher never starts — no Web Audio, an audio
   * graph that will not construct, a stream with no usable track — or
   * whose watcher starts and then never reports, was bounded by nothing
   * at all, while the interface promised a bounded window either way. The
   * grace exists so that when the watcher IS working it always decides
   * first, and the backstop is never what a person experiences.
   */
  readonly backstopGraceMs: number;
  /**
   * And its ceiling, for a loud room — or for somebody who starts talking
   * during calibration, which would otherwise measure their voice as silence
   * and make the turn undetectable.
   */
  readonly maxThreshold: number;
};

export const ENDPOINT_BOUNDS: EndpointBounds = {
  speechStartTimeoutMs: 5_000,
  minSpeechMs: 200,
  silenceToFinalizeMs: 1_500,
  maxTurnMs: 20_000,
  backstopGraceMs: 2_000,
  noiseFloorFrames: 5,
  thresholdRatio: 3,
  minThreshold: 0.012,
  maxThreshold: 0.05,
};

export type EndpointSample = {
  /** Milliseconds since the recording started. Wall clock, not frame count. */
  atMs: number;
  /** Root-mean-square amplitude of this frame, 0..1. */
  rms: number;
};

export type EndpointTracker = {
  /**
   * Feeds one frame. Returns the decision the FIRST time one is reached, and
   * null every other time — including every call after a decision.
   *
   * That "exactly once" is the whole contract. The caller turns a decision
   * into stopping a recording, and a detector that could decide twice would
   * be a recording stopped twice, or worse, a second turn started on top of
   * the first.
   */
  observe(sample: EndpointSample): EndpointOutcome | null;
  /** For the debug view, the backstop and the tests. Never shown to a person. */
  inspect(): {
    decided: EndpointOutcome | null;
    threshold: number | null;
    speechMs: number;
    silenceMs: number;
    /**
     * Whether anything above the threshold has been heard at all (M12i).
     *
     * Distinct from `speechMs`, which is zero until a SECOND loud frame
     * arrives. The application's backstop asks this one question — is
     * this window silent, or is somebody talking? — so it can end a
     * silent window without cutting a real turn short.
     */
    speechStarted: boolean;
  };
};

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

export function createEndpointTracker(
  bounds: EndpointBounds = ENDPOINT_BOUNDS,
): EndpointTracker {
  let decided: EndpointOutcome | null = null;
  let threshold: number | null = null;
  const floorSamples: number[] = [];
  let firstLoudAtMs: number | null = null;
  let lastLoudAtMs: number | null = null;
  let lastAtMs = 0;

  const decide = (outcome: EndpointOutcome): EndpointOutcome => {
    decided = outcome;
    return outcome;
  };

  const speechMs = () =>
    firstLoudAtMs === null || lastLoudAtMs === null ? 0 : lastLoudAtMs - firstLoudAtMs;
  const silenceMs = () => (lastLoudAtMs === null ? 0 : lastAtMs - lastLoudAtMs);

  return {
    inspect: () => ({
      decided,
      threshold,
      speechMs: speechMs(),
      silenceMs: silenceMs(),
      speechStarted: firstLoudAtMs !== null,
    }),

    observe({ atMs, rms }) {
      // Exactly once, forever. Everything below depends on this line.
      if (decided !== null) return null;
      lastAtMs = atMs;

      // The ceiling outranks everything, including calibration: a turn that
      // has run this long is over whatever the room sounds like.
      if (atMs >= bounds.maxTurnMs) return decide("max_duration");

      if (threshold === null) {
        floorSamples.push(rms);
        if (floorSamples.length < bounds.noiseFloorFrames) return null;
        const floor = median(floorSamples) * bounds.thresholdRatio;
        threshold = Math.min(
          bounds.maxThreshold,
          Math.max(bounds.minThreshold, floor),
        );
        return null;
      }

      if (rms >= threshold) {
        if (firstLoudAtMs === null) firstLoudAtMs = atMs;
        lastLoudAtMs = atMs;
      }

      if (firstLoudAtMs === null) {
        // Nothing has been said yet.
        return atMs >= bounds.speechStartTimeoutMs ? decide("no_speech") : null;
      }

      const silent = atMs - lastLoudAtMs!;
      if (speechMs() >= bounds.minSpeechMs && silent >= bounds.silenceToFinalizeMs) {
        return decide("speech_ended");
      }
      // Something brief and then nothing: a cough, a chair, a door. Treated
      // as no speech rather than transcribed, because an empty or nonsense
      // transcript appearing in the composer unprompted is worse than
      // silence.
      if (speechMs() < bounds.minSpeechMs && silent >= bounds.speechStartTimeoutMs) {
        return decide("no_speech");
      }
      return null;
    },
  };
}
