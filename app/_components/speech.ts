"use client";

/**
 * Reading a reply aloud.
 *
 * One player, module-wide, so two replies can never talk over each other: a
 * new request stops whatever is playing before it starts. Audio is fetched as
 * a blob and revoked afterwards rather than streamed from a URL, because the
 * endpoint is a POST and the object URL is the only thing that outlives the
 * call.
 *
 * Nothing here decides WHAT to speak, and - since the architecture review - it
 * cannot even say it. It sends a REFERENCE to something the server already
 * produced and showed: an assistant message, the offer on the table, a
 * closure. The server resolves it, proves it is this person's, and derives the
 * words from storage. There is no parameter through which a browser could put
 * a sentence in CareLoop's mouth.
 */
export type SpeakSource =
  | { type: "assistant_message"; id: string }
  | { type: "offer"; id: string }
  | { type: "closure"; id: string };

export type SpeakRequest = { conversationId: string; source: SpeakSource };
let current: HTMLAudioElement | null = null;
let currentUrl: string | null = null;
/** Fires the current request's completion callback, whatever ended it. */
let endCurrent: (() => void) | null = null;

export function stopSpeaking(): void {
  const finish = endCurrent;
  endCurrent = null;
  if (current) {
    current.pause();
    current.src = "";
    current = null;
  }
  if (currentUrl) {
    URL.revokeObjectURL(currentUrl);
    currentUrl = null;
  }
  finish?.();
}

export type SpeakFailure = "unavailable" | "failed" | "blocked";

export class SpeakError extends Error {
  readonly name = "SpeakError";
  constructor(readonly reason: SpeakFailure) {
    super(reason);
  }
}

export type SpeakOptions = {
  /**
   * Called when playback actually ENDS, not when it begins.
   *
   * `audio.play()` resolves as soon as the sound starts, which is the wrong
   * moment for the "Stop reading" control: it should exist for as long as
   * there is something to stop, not for as long as it takes to start. It
   * fires exactly once, including when playback is stopped early or never
   * starts.
   */
  onEnded?: () => void;
  /**
   * Playback speed (M12d). 1 is the synthesized speed and the default.
   *
   * This is the browser's own `playbackRate` on the same audio element, so
   * nothing is re-synthesized, no provider setting changes, and the bytes
   * are byte-identical to the ones the server authorized. `preservesPitch`
   * is set explicitly alongside it: a slower voice that also drops in
   * pitch is the "hack" this is deliberately not.
   */
  rate?: number;
};

/** The only speeds offered. Two, because a slider is a decision to make. */
export const SPEECH_RATES = { normal: 1, slower: 0.8 } as const;
export type SpeechRate = keyof typeof SPEECH_RATES;

export async function speak(request: SpeakRequest, options: SpeakOptions = {}): Promise<void> {
  // Never two at once.
  stopSpeaking();

  const response = await fetch("/api/voice/speak", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(request),
  });

  if (response.status === 503) throw new SpeakError("unavailable");
  if (!response.ok) throw new SpeakError("failed");

  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  if (options.rate !== undefined && options.rate !== 1) {
    // Order matters: `preservesPitch` before `playbackRate`, so no frame is
    // ever rendered at the wrong pitch.
    audio.preservesPitch = true;
    audio.playbackRate = options.rate;
  }
  current = audio;
  currentUrl = url;

  let ended = false;
  const finish = () => {
    if (ended) return;
    ended = true;
    options.onEnded?.();
  };
  endCurrent = finish;

  audio.onended = () => stopSpeaking();

  try {
    await audio.play();
  } catch {
    // Autoplay policy, almost always. The text is on screen either way, so
    // this is a missing convenience rather than a failure of the turn.
    stopSpeaking();
    throw new SpeakError("blocked");
  }
}

/**
 * Three failures, three sentences (M12d recovery audit).
 *
 * It used to be two, with `blocked` folded into the generic one — so a
 * person whose browser had simply refused to autoplay was told the same
 * thing as somebody whose provider was down, and neither was told that the
 * reply is still there to read. Losing the audio costs nothing as long as
 * that is said.
 */
export function speakMessage(reason: SpeakFailure): string {
  switch (reason) {
    case "unavailable":
      return "Reading aloud isn't set up here. You can still read it on screen.";
    case "blocked":
      return "The sound was blocked. Press the speaker button to try again.";
    case "failed":
      return "I couldn't read that aloud, but you can still read it here.";
  }
}
