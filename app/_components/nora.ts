"use client";

import type { NoraUnavailableReason } from "@/core/nora/availability";

/**
 * Nora — the optional wake word (M12).
 *
 * CareLoop's shipped voice interaction is push-to-talk, and stays that way.
 * Nora is a convenience laid on top of it: it saves the press that starts a
 * recording, and nothing else. Everything after the wake — recording,
 * transcription, the transcript appearing as editable text, the person
 * pressing Send — is the existing path, unmodified. There is no second chat
 * endpoint, no second consent parser and no second memory path, because a
 * wake word is an input device, not a reasoning route.
 *
 * TWO INVARIANTS live in this file.
 *
 * THE MICROPHONE IS RELEASED ON EVERY TERMINAL PATH. The same invariant
 * `startRecording` has, and for the same reason: a listener that survives a
 * failure is a microphone nobody knows is open. There is exactly one
 * `teardown`, it is guarded by a flag, and every ending — the person's
 * toggle, a component unmount, the cutoff passing, an initialization error,
 * a server revalidation that comes back unavailable — leads to it and
 * nowhere else.
 *
 * THE SERVER DECIDES WHETHER NORA MAY RUN. Not this file, and not the
 * device's clock. The clock here drives a timer so the interface can change
 * at the right moment; the server is asked again before the session is
 * re-armed. A client that believes it is still September because a tab was
 * left open is a client that gets told otherwise.
 */

export type NoraStatus = {
  available: boolean;
  reason: NoraUnavailableReason | null;
  availableUntil: string;
};

/**
 * The server's answer. A network failure is NOT "available": an unreachable
 * authority is an authority that has not said yes.
 */
export async function fetchNoraStatus(): Promise<NoraStatus> {
  try {
    const response = await fetch("/api/voice/nora/status", { cache: "no-store" });
    if (!response.ok) {
      return { available: false, reason: "initialization_failed", availableUntil: "" };
    }
    const body = (await response.json()) as Partial<NoraStatus>;
    if (typeof body.available !== "boolean") {
      return { available: false, reason: "initialization_failed", availableUntil: "" };
    }
    return {
      available: body.available,
      reason: body.reason ?? null,
      availableUntil: typeof body.availableUntil === "string" ? body.availableUntil : "",
    };
  } catch {
    return { available: false, reason: "initialization_failed", availableUntil: "" };
  }
}

/** What the browser itself can rule out, before any credential is used. */
export function noraBrowserSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof Worker !== "undefined" &&
    typeof WebAssembly !== "undefined" &&
    typeof AudioWorkletNode !== "undefined" &&
    Boolean(navigator?.mediaDevices?.getUserMedia)
  );
}

export class NoraError extends Error {
  readonly name = "NoraError";
  constructor(readonly reason: NoraUnavailableReason) {
    super(reason);
  }
}

export type NoraSession = {
  /**
   * Stops listening for the wake word and releases the microphone. Safe to
   * call more than once and safe to call after something else has already
   * ended the session — the invariant is that when this resolves, nothing of
   * Nora's is still holding audio.
   */
  stop(): Promise<void>;
  /** Stops wake detection for the duration of a turn, without tearing down. */
  pause(): Promise<void>;
  /** Resumes wake detection after a turn. No-op once stopped. */
  resume(): Promise<void>;
};

export type StartNoraOptions = {
  accessKey: string;
  /** Path under `public/` to the trained "Nora" keyword. */
  keywordPath: string;
  /** Path under `public/` to the Porcupine parameter model. */
  modelPath: string;
  /** Called when the wake phrase is heard. */
  onWake: () => void;
  /** Called when the engine fails after it started. Terminal: teardown ran. */
  onFailure: (reason: NoraUnavailableReason) => void;
};

/**
 * Starts listening for the wake word.
 *
 * Every failure below tears down whatever was already built before it throws.
 * A half-initialized wake engine is the failure mode that matters here: it
 * leaves a worker running and, worse, a microphone open, for a feature the
 * person was just told did not start.
 */
export async function startNora(options: StartNoraOptions): Promise<NoraSession> {
  if (!noraBrowserSupported()) throw new NoraError("unsupported_browser");

  /**
   * Imported at the point of use, not at module load. Three reasons, all of
   * them about not paying for a feature that is off by default: the engine
   * is several megabytes and must not sit in the bundle every person
   * downloads; an import failure becomes a caught error instead of a blank
   * page; and after the cutoff the code is never fetched at all.
   */
  let PorcupineWorker: typeof import("@picovoice/porcupine-web").PorcupineWorker;
  let WebVoiceProcessor: typeof import("@picovoice/web-voice-processor").WebVoiceProcessor;
  try {
    ({ PorcupineWorker } = await import("@picovoice/porcupine-web"));
    ({ WebVoiceProcessor } = await import("@picovoice/web-voice-processor"));
  } catch {
    throw new NoraError("initialization_failed");
  }

  let stopped = false;
  let listening = false;
  let porcupine: Awaited<ReturnType<typeof PorcupineWorker.create>> | null = null;

  /** The ONE ending. Idempotent, and total: it never throws at a caller. */
  const teardown = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    const engine = porcupine;
    porcupine = null;
    if (engine === null) return;
    try {
      if (listening) await WebVoiceProcessor.unsubscribe(engine);
    } catch {
      // Already unsubscribed, or the processor is gone. Either way the next
      // two calls are what actually release the engine, and a throw here
      // must not stop them from running.
    }
    listening = false;
    try {
      await engine.release();
    } catch {
      /* the worker is being terminated regardless */
    }
    try {
      engine.terminate();
    } catch {
      /* nothing left to do about a worker that will not stop */
    }
  };

  try {
    porcupine = await PorcupineWorker.create(
      options.accessKey,
      { publicPath: options.keywordPath, label: "Hey Nora" },
      () => {
        if (!stopped) options.onWake();
      },
      { publicPath: options.modelPath },
      {
        processErrorCallback: () => {
          // A failure mid-stream is terminal: release everything, then say
          // so once. No retry loop — an engine that cannot process audio
          // will not start being able to, and a loop here is a microphone
          // reopening forever behind a person's back.
          void teardown().then(() => options.onFailure("initialization_failed"));
        },
      },
    );
  } catch (error) {
    await teardown();
    throw new NoraError(classifyStartFailure(error));
  }

  try {
    // This is where the microphone is actually requested.
    await WebVoiceProcessor.subscribe(porcupine);
    listening = true;
  } catch (error) {
    await teardown();
    throw new NoraError(classifyStartFailure(error));
  }

  return {
    stop: teardown,
    async pause() {
      if (stopped || !listening || porcupine === null) return;
      await WebVoiceProcessor.unsubscribe(porcupine);
      listening = false;
    },
    async resume() {
      if (stopped || listening || porcupine === null) return;
      await WebVoiceProcessor.subscribe(porcupine);
      listening = true;
    },
  };
}

/**
 * A start failure, as one of the reasons the interface knows how to say.
 *
 * Deliberately coarse. The person is never shown a provider's error: an
 * activation limit, an invalid key and a corrupt model are all "Nora couldn't
 * start", because none of them is something they can act on and all of them
 * have the same remedy, which is the microphone button that already works.
 */
function classifyStartFailure(error: unknown): NoraUnavailableReason {
  const name = error instanceof Error ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") return "microphone_denied";
  if (name === "NotFoundError" || name === "DevicesNotFoundError") return "microphone_denied";
  return "initialization_failed";
}

/** What the person is told. A CareLoop product state, never a vendor's. */
export function noraMessage(reason: NoraUnavailableReason): string {
  switch (reason) {
    case "expired":
      return "Nora hands-free is no longer available. You can still use the microphone button to talk to CareLoop.";
    case "not_configured":
      return "Nora hands-free isn't set up here. You can still use the microphone button to talk to CareLoop.";
    case "unsupported_browser":
      return "Nora hands-free doesn't work in this browser. You can still use the microphone button to talk to CareLoop.";
    case "microphone_denied":
      return "Nora needs the microphone to listen. You can still type, or use the microphone button.";
    case "initialization_failed":
      return "Nora couldn't start. Push-to-talk is still available.";
  }
}

/**
 * Milliseconds until the cutoff, or null when there is nothing to schedule.
 *
 * Clamped to a 32-bit delay because `setTimeout` silently fires immediately
 * past that — which would disable Nora at once on a deployment whose cutoff
 * is more than 24 days out, the exact opposite of what the timer is for.
 */
export const MAX_TIMER_MS = 2_147_483_647;

export function msUntilExpiry(availableUntil: string, now: Date): number | null {
  const deadline = Date.parse(availableUntil);
  if (Number.isNaN(deadline)) return null;
  const remaining = deadline - now.getTime() + 1;
  if (remaining <= 0) return 0;
  return Math.min(remaining, MAX_TIMER_MS);
}
