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
  stop(): Promise<Blob>;
  cancel(): void;
};

/**
 * Starts recording and resolves with a handle that stops it.
 *
 * The track is stopped on every exit path, including cancellation and error -
 * a microphone left live after a failed turn is the kind of thing people
 * rightly never forgive.
 */
export async function startRecording(): Promise<Recording> {
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
  const recorder = new MediaRecorder(stream, { mimeType });
  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) chunks.push(event.data);
  };

  const release = () => {
    for (const track of stream.getTracks()) track.stop();
  };

  // The client's own ceiling, for the person's sake. The server enforces its
  // own from the bytes, and does not trust this.
  const timeout = setTimeout(() => {
    if (recorder.state === "recording") recorder.stop();
  }, VOICE_LIMITS.maxRecordingSeconds * 1000);

  recorder.start();

  return {
    stop() {
      clearTimeout(timeout);
      return new Promise<Blob>((resolve) => {
        recorder.onstop = () => {
          release();
          resolve(new Blob(chunks, { type: recorder.mimeType || mimeType }));
        };
        if (recorder.state === "recording") recorder.stop();
        else {
          release();
          resolve(new Blob(chunks, { type: mimeType }));
        }
      });
    },
    cancel() {
      clearTimeout(timeout);
      if (recorder.state === "recording") recorder.stop();
      release();
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
export async function transcribe(audio: Blob): Promise<string> {
  const form = new FormData();
  form.append("audio", audio, "speech");
  const response = await fetch("/api/voice/transcribe", { method: "POST", body: form });
  if (!response.ok) throw new Error(`transcribe_failed_${response.status}`);
  const body = (await response.json()) as { text?: string };
  const text = body.text?.trim();
  if (!text) throw new Error("transcribe_empty");
  return text;
}
