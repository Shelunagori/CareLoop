"use client";

import { VOICE_LIMITS } from "@/core/voice/limits";

/**
 * Microphone capture, as a small state machine with no opinions.
 *
 * MediaRecorder for capture, chosen from what the browser actually supports
 * rather than a hard-coded codec. Everything downstream - transcription,
 * meaning, consent - happens on the server through the ordinary pipeline; this
 * file's whole job is to produce a Blob and stop.
 */
export type RecorderState = "idle" | "recording" | "transcribing";

/** In preference order. The first the browser admits to is the one used. */
const CANDIDATE_TYPES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus",
  "audio/ogg",
  "audio/mp4",
];

export function pickRecordingType(
  isSupported: (type: string) => boolean = (type) =>
    typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(type),
): string | null {
  return CANDIDATE_TYPES.find((type) => isSupported(type)) ?? null;
}

export function isRecordingSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof MediaRecorder !== "undefined" &&
    Boolean(navigator?.mediaDevices?.getUserMedia)
  );
}

export type MicrophoneFailure = "permission_denied" | "no_microphone" | "unsupported" | "failed";

export class MicrophoneError extends Error {
  readonly name = "MicrophoneError";
  constructor(readonly reason: MicrophoneFailure) {
    super(reason);
  }
}

export type Recording = {
  /**
   * Resolves with the audio captured so far and guarantees the microphone is
   * off. Safe to call more than once, and safe to call after the recording has
   * already ended itself - it resolves with the same audio rather than hanging
   * or throwing.
   */
  stop(): Promise<Blob>;
  /** Ends the recording and throws the audio away. Also idempotent. */
  cancel(): void;
};

export type RecordingOptions = {
  /**
   * Called at most once, and only when the duration ceiling - not the person -
   * ended the recording. The handle has already released the microphone by
   * then; this exists so the interface can stop claiming to be listening.
   */
  onLimitReached?: () => void;
  /**
   * Handed the live stream once, as the recording begins (M12).
   *
   * A way to OBSERVE this recording's audio - Nora's end-of-turn detector
   * attaches an analyser to it - and never a way to start one or to keep
   * one. The single ending below stops these tracks on every terminal path
   * regardless of what an observer did with them, so an observer that forgets
   * to let go cannot hold a microphone open. Its exceptions are swallowed for
   * the same reason: a convenience must not be able to fail a recording.
   */
  onStream?: (stream: MediaStream) => void;
};

/**
 * Starts recording and resolves with a handle that stops it.
 *
 * THE MICROPHONE IS RELEASED ON EVERY TERMINAL PATH. That is the invariant,
 * and the reason this function has the shape it does.
 *
 * It used to release inside `stop()`, which was true for the paths a person
 * takes and false for the one they do not: the duration ceiling stopped the
 * MediaRecorder directly, and the tracks stayed live until the person next
 * touched the page - at the end of a sixty-second recording, precisely when
 * they have put the phone down. Stopping a recorder and releasing a stream are
 * two different things, and any design where a caller must remember to do the
 * second will eventually have a path that forgets.
 *
 * So there is exactly ONE ending here. `finalize` releases the tracks, clears
 * the timer and hands the audio to whoever is waiting; it is guarded by a flag
 * so it runs once no matter how many endings arrive. Every route in - the
 * person's stop, their cancel, the ceiling, the recorder's own `onstop` -
 * leads to it and nowhere else.
 */
const ONSTOP_GRACE_MS = 1000;

export async function startRecording(options: RecordingOptions = {}): Promise<Recording> {
  if (!isRecordingSupported()) throw new MicrophoneError("unsupported");

  const mimeType = pickRecordingType();
  if (!mimeType) throw new MicrophoneError("unsupported");

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    if (name === "NotAllowedError" || name === "SecurityError") {
      throw new MicrophoneError("permission_denied");
    }
    if (name === "NotFoundError" || name === "DevicesNotFoundError") {
      throw new MicrophoneError("no_microphone");
    }
    throw new MicrophoneError("failed");
  }

  const chunks: Blob[] = [];
  let recorder: MediaRecorder;
  try {
    recorder = new MediaRecorder(stream, { mimeType });
  } catch (error) {
    // The stream is already open at this point. Nothing below will run to
    // release it, so this path releases it itself.
    for (const track of stream.getTracks()) track.stop();
    throw error instanceof MicrophoneError ? error : new MicrophoneError("failed");
  }
  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) chunks.push(event.data);
  };

  try {
    options.onStream?.(stream);
  } catch {
    // An observer is a convenience. A recording is not.
  }

  /** Set the moment any ending begins, so the ceiling cannot fire into one. */
  let ending = false;
  /** Set when the one ending has completed. Everything after it is a no-op. */
  let ended = false;
  /** Set once the recorder has been asked to stop and its onstop is pending. */
  let stopRequested = false;
  let settle: ReturnType<typeof setTimeout> | undefined;
  let audio: Blob | null = null;
  const waiting: Array<(blob: Blob) => void> = [];

  /** The only place tracks are stopped, and the only place the timer is cleared. */
  const finalize = () => {
    if (ended) return;
    ended = true;
    clearTimeout(timeout);
    if (settle !== undefined) clearTimeout(settle);
    for (const track of stream.getTracks()) track.stop();
    audio = new Blob(chunks, { type: recorder.mimeType || mimeType });
    // Every waiter, not just the most recent one: two callers must not leave
    // one promise pending forever.
    while (waiting.length > 0) waiting.shift()!(audio);
  };

  // Assigned ONCE, here, rather than inside stop(). Whatever stops the
  // recorder - a person, the ceiling, the browser tearing the track down -
  // arrives at the same ending.
  recorder.onstop = finalize;

  /**
   * Asks the recorder to stop, once, and makes sure an ending follows.
   *
   * The subtlety is that `onstop` arrives on a LATER task, and the recorder
   * delivers its audio just before it. Finalizing the moment the recorder
   * reads `inactive` would therefore build the Blob from chunks that have not
   * arrived yet and hand back an empty recording - which downstream becomes
   * "that recording didn't work" at the end of a perfectly good sentence. So
   * once a stop is in flight, the ending waits for it.
   */
  const endNow = () => {
    ending = true;
    if (recorder.state === "recording") {
      stopRequested = true;
      // Armed BEFORE the stop, not after: a browser that fires onstop
      // synchronously would otherwise finalize first and leave this timer
      // behind, still holding a reference to a recording that is over.
      settle = setTimeout(finalize, ONSTOP_GRACE_MS);
      recorder.stop();
      return;
    }
    // Inactive with a stop already in flight: onstop is coming, and it carries
    // the audio. Anything else means nothing is coming at all, so finish now
    // rather than leave a caller waiting on a promise nobody will resolve.
    if (!stopRequested) finalize();
  };

  // The client's own ceiling, for the person's sake. The server enforces its
  // own from the bytes, and does not trust this.
  const timeout = setTimeout(() => {
    // `ending` is set synchronously by stop()/cancel(), so a ceiling that
    // lands in the same tick as a person's press does nothing.
    if (ending || ended) return;
    endNow();
    // After the release, never before: by the time anyone hears about this,
    // the microphone is already off.
    options.onLimitReached?.();
  }, VOICE_LIMITS.maxRecordingSeconds * 1000);

  recorder.start();

  return {
    stop() {
      return new Promise<Blob>((resolve) => {
        if (ended) {
          resolve(audio ?? new Blob(chunks, { type: mimeType }));
          return;
        }
        waiting.push(resolve);
        endNow();
      });
    },
    cancel() {
      if (ended) return;
      endNow();
    },
  };
}

/** What the person is told when the microphone will not cooperate. */
export function microphoneMessage(reason: MicrophoneFailure): string {
  switch (reason) {
    case "permission_denied":
      return "Microphone access is needed to use voice. You can still type.";
    case "no_microphone":
      return "I couldn't find a microphone. You can still type.";
    case "unsupported":
      return "This browser can't record audio. You can still type.";
    case "failed":
      return "I couldn't start recording just then. Please try again.";
  }
}

/**
 * Sends the recording for transcription.
 *
 * Returns the transcript for the person to READ before anything is sent. The
 * microphone can mishear a name, and a mishearing that goes straight into an
 * irreversible action is exactly the failure this ordering prevents.
 */
export class NothingHeardError extends Error {
  readonly name = "NothingHeardError";
  constructor() {
    super("no_speech");
  }
}

export async function transcribe(audio: Blob): Promise<string> {
  const form = new FormData();
  form.append("audio", audio, "speech");
  const response = await fetch("/api/voice/transcribe", { method: "POST", body: form });

  // 422, and ONLY 422, is "nothing heard".
  //
  // The route returns it for exactly one outcome - `no_speech`, which is a
  // transcription that succeeded and came back empty. That is somebody
  // coughing, and the conversation should carry on.
  //
  // 413 and 415 are NOT that. They are the recording being too large, or in a
  // container the server will not accept: the capture went wrong, and calling
  // it "I didn't catch that" would tell the person their speech was unclear
  // when the truth is that our recorder produced something unusable. They fall
  // through to the sanitized failure below, which still submits nothing.
  if (response.status === 422) throw new NothingHeardError();
  if (!response.ok) throw new Error(`transcribe_failed_${response.status}`);

  const body = (await response.json()) as { text?: string };
  const text = body.text?.trim();
  // A SUCCESSFUL response carrying nothing is the same thing 422 means, and
  // the route can only produce one of them at a time. Never submitted, never
  // an assistant turn.
  if (!text) throw new NothingHeardError();
  return text;
}
