"use client";

import {
  createEndpointTracker,
  ENDPOINT_BOUNDS,
  type EndpointBounds,
  type EndpointOutcome,
} from "@/core/voice/endpoint";

/**
 * The Web Audio half of end-of-turn detection (M12).
 *
 * THE ONLY FILE IN CARELOOP THAT WATCHES AUDIO, and it may do so under
 * exactly one condition: a post-wake recording is already open. It attaches
 * to the recorder's existing stream, measures loudness for the length of that
 * one turn, reports one decision, and is torn down. It never opens a
 * microphone — it has no `getUserMedia` and no way to reach one — and it
 * never runs between turns.
 *
 * That last sentence is the difference between this and what M9 built. M9
 * monitored continuously to keep a conversation session open, which is why
 * it was impossible to reason about and why it was deleted. Here the audio
 * graph cannot outlive the recording that justified it: the caller holds the
 * handle, and every path that ends a recording also calls `stop()`.
 *
 * The decision logic is not here. It is a pure tracker in
 * `core/voice/endpoint.ts`, tested against literal frames, because the part
 * worth testing is the arithmetic and the part worth keeping small is this.
 */

export type Endpointer = {
  /**
   * Releases the analyser, the interval and the audio context. Idempotent,
   * and never throws at a caller: it runs inside other teardowns.
   *
   * It deliberately does NOT stop the stream's tracks. The recorder owns
   * those, and its single-`finalize` guarantee is what releases them. Two
   * owners for one microphone is how a release gets skipped.
   */
  stop(): void;
};

export type StartEndpointingInput = {
  /** The recorder's live stream. Observed, never owned. */
  stream: MediaStream;
  /** Called at most once, with the first decision the tracker reaches. */
  onDecision: (outcome: EndpointOutcome) => void;
  bounds?: EndpointBounds;
  /** How often loudness is sampled. */
  frameMs?: number;
};

const DEFAULT_FRAME_MS = 50;

/** Whether this browser can do it at all. */
export function endpointingSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof (window.AudioContext ?? (window as { webkitAudioContext?: unknown }).webkitAudioContext) !==
      "undefined"
  );
}

/**
 * Starts watching, or returns null.
 *
 * Null is a supported answer, not a failure: a browser without Web Audio
 * keeps the turn exactly as it is today — the person presses Stop. Automatic
 * endpointing is a convenience on top of push-to-talk, and a convenience
 * that cannot start must not take the working path down with it.
 */
export function startEndpointing(input: StartEndpointingInput): Endpointer | null {
  if (!endpointingSupported()) return null;

  const frameMs = input.frameMs ?? DEFAULT_FRAME_MS;
  const tracker = createEndpointTracker(input.bounds ?? ENDPOINT_BOUNDS);

  let context: AudioContext;
  let source: MediaStreamAudioSourceNode;
  let analyser: AnalyserNode;
  try {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    context = new Ctor();
    source = context.createMediaStreamSource(input.stream);
    analyser = context.createAnalyser();
    // Small window: this is loudness over ~23ms at 44.1kHz, which is the
    // resolution the decision actually needs. A larger FFT would smooth the
    // very gaps being looked for.
    analyser.fftSize = 1024;
    source.connect(analyser);
  } catch {
    // Same answer as an unsupported browser. The turn still works; it just
    // needs the Stop button.
    return null;
  }

  const buffer = new Float32Array(analyser.fftSize);
  const startedAt = Date.now();
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  /** The one ending. Guarded, total, and safe to call from any teardown. */
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    if (timer !== undefined) clearInterval(timer);
    timer = undefined;
    try {
      source.disconnect();
      analyser.disconnect();
    } catch {
      /* already torn down by the context closing under us */
    }
    // Fire and forget: nothing waits on an audio context closing, and an
    // unhandled rejection here would surface as a page error for a graph
    // that is already unreachable.
    void context.close().catch(() => {});
  };

  timer = setInterval(() => {
    if (stopped) return;
    analyser.getFloatTimeDomainData(buffer);
    let sum = 0;
    for (let i = 0; i < buffer.length; i += 1) sum += buffer[i]! * buffer[i]!;
    const rms = Math.sqrt(sum / buffer.length);

    // Wall clock, not a frame count. A throttled interval — a backgrounded
    // tab, a busy main thread — then makes the turn end LATE rather than
    // never, and `maxTurnMs` still lands at the right moment.
    const decision = tracker.observe({ atMs: Date.now() - startedAt, rms });
    if (decision === null) return;

    // Released before the caller is told, so a handler that starts the next
    // thing cannot race this graph's teardown.
    stop();
    input.onDecision(decision);
  }, frameMs);

  return { stop };
}
