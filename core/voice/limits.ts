/**
 * What the voice layer will accept, and what it will say.
 *
 * Pure, and deliberately so. These are the only decisions the voice I/O layer
 * makes, and none of them is about meaning: how large an upload may be, which
 * container the browser may send, how long a sentence may be spoken. Anything
 * that decides what CareLoop *does* lives where it already lived - the chat
 * pipeline - because voice is an input and an output, not a second brain.
 *
 * The client enforces its own version of the duration limit for UX. That is a
 * courtesy, not a control: the server re-decides every one of these from the
 * bytes it actually received.
 */
export const VOICE_LIMITS = {
  /** One short turn. Long enough to say a sentence, short enough to bound cost. */
  maxRecordingSeconds: 60,
  /** ~60s of Opus at a generous bitrate, with headroom. */
  maxAudioBytes: 8 * 1024 * 1024,
  /** Below this there is no speech, only a mis-click. */
  minAudioBytes: 512,
  /**
   * An assistant turn is two or three sentences. Anything much longer is not a
   * CareLoop reply, and synthesising it would be paying for someone else's
   * mistake.
   */
  maxSpeakCharacters: 1200,
} as const;

/**
 * Containers a browser's MediaRecorder actually produces. Matched on the base
 * type so `audio/webm;codecs=opus` is accepted without hard-coding one codec,
 * which the milestone brief specifically warns against.
 */
export const ALLOWED_AUDIO_TYPES = [
  "audio/webm",
  "audio/ogg",
  "audio/mp4",
  "audio/mpeg",
  "audio/wav",
  "audio/x-wav",
] as const;

export type AudioRejection =
  | { code: "unsupported_type"; received: string }
  | { code: "empty_audio" }
  | { code: "too_large"; bytes: number; max: number };

export type AudioVerdict = { ok: true; mimeType: string } | { ok: false; reason: AudioRejection };

/** The base media type, with parameters and case folded away. */
export function normalizeAudioType(raw: string): string {
  return raw.split(";")[0]!.trim().toLowerCase();
}

export function checkAudioUpload(input: { mimeType: string; bytes: number }): AudioVerdict {
  const mimeType = normalizeAudioType(input.mimeType);

  // An allow-list, not a deny-list: an unrecognised container is refused
  // rather than forwarded to a provider to find out.
  if (!(ALLOWED_AUDIO_TYPES as readonly string[]).includes(mimeType)) {
    return { ok: false, reason: { code: "unsupported_type", received: mimeType } };
  }
  if (input.bytes < VOICE_LIMITS.minAudioBytes) {
    return { ok: false, reason: { code: "empty_audio" } };
  }
  if (input.bytes > VOICE_LIMITS.maxAudioBytes) {
    return {
      ok: false,
      reason: { code: "too_large", bytes: input.bytes, max: VOICE_LIMITS.maxAudioBytes },
    };
  }
  return { ok: true, mimeType };
}

export type SpeakRejection =
  | { code: "empty_text" }
  | { code: "too_long"; length: number; max: number };

export type SpeakVerdict = { ok: true; text: string } | { ok: false; reason: SpeakRejection };

/**
 * Text that may be spoken aloud.
 *
 * Length only. It deliberately does NOT inspect, rewrite or tidy the words:
 * what is spoken has to be what the person can already read on screen, and a
 * layer that edits text on its way to the speaker is a layer that can make the
 * spoken reply differ from the written one. Whether the text was safe to show
 * was decided before it was shown.
 */
export function checkSpeakText(raw: string): SpeakVerdict {
  const text = raw.trim();
  if (text.length === 0) return { ok: false, reason: { code: "empty_text" } };
  if (text.length > VOICE_LIMITS.maxSpeakCharacters) {
    return {
      ok: false,
      reason: {
        code: "too_long",
        length: text.length,
        max: VOICE_LIMITS.maxSpeakCharacters,
      },
    };
  }
  return { ok: true, text };
}

/**
 * A transcript, as the provider returned it.
 *
 * Trimmed and nothing else. It is NOT spell-checked, NOT name-corrected and
 * NOT matched against anything CareLoop knows - the transcript is evidence of
 * what the microphone heard, and "correcting" it towards a name in the
 * database would be the system deciding what the person meant to say. Entity
 * resolution already handles ambiguity, downstream, where it can be reviewed.
 */
export function readTranscript(raw: string): { ok: true; text: string } | { ok: false } {
  const text = raw.trim();
  return text.length === 0 ? { ok: false } : { ok: true, text };
}
