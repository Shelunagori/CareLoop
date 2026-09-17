import {
  checkAudioUpload,
  checkSpeakText,
  readTranscript,
  type AudioRejection,
  type SpeakRejection,
} from "@/core/voice/limits";
import {
  SpeechUnavailableError,
  type SpeechToTextProvider,
  type VoiceProvider,
} from "@/server/adapters/openai/types";

/**
 * Voice I/O as a use-case, so the routes stay thin and the providers stay
 * injectable.
 *
 * Read what this file does NOT do. It does not look at the conversation, load
 * memory, resolve an entity, touch an opportunity or evaluate consent. A
 * transcript leaves here as a string and has to be sent through the ordinary
 * chat endpoint like anything the person typed - which is the whole reason
 * voice cannot become a second way of deciding things.
 */
export type TranscriptionDeps = { speechToText: SpeechToTextProvider };
export type SynthesisDeps = { voice: VoiceProvider };

export type TranscriptionOutcome =
  | { outcome: "transcribed"; text: string }
  | { outcome: "rejected"; reason: AudioRejection }
  | { outcome: "no_speech" }
  | { outcome: "provider_failed"; errorName: string };

export async function transcribeTurn(
  deps: TranscriptionDeps,
  input: { audio: Uint8Array; mimeType: string },
): Promise<TranscriptionOutcome> {
  // Decided from the bytes actually received, never from what the client
  // claimed before sending them.
  const verdict = checkAudioUpload({ mimeType: input.mimeType, bytes: input.audio.byteLength });
  if (!verdict.ok) return { outcome: "rejected", reason: verdict.reason };

  let raw: string;
  try {
    const result = await deps.speechToText.transcribe({
      audio: input.audio,
      mimeType: verdict.mimeType,
    });
    raw = result.text;
  } catch (error) {
    // The name only. A provider message can carry a model, a quota or a key.
    return {
      outcome: "provider_failed",
      errorName: error instanceof Error ? error.name : "UnknownError",
    };
  }

  const read = readTranscript(raw);
  // Exactly what was heard. Not matched against known names, not corrected
  // towards anything CareLoop expects - see core/voice/limits.ts.
  return read.ok ? { outcome: "transcribed", text: read.text } : { outcome: "no_speech" };
}

export type SynthesisOutcome =
  | { outcome: "spoken"; audio: Uint8Array; mimeType: string }
  | { outcome: "rejected"; reason: SpeakRejection }
  /** No synthesis credentials. Configuration, not failure - and not a 500. */
  | { outcome: "unavailable" }
  | { outcome: "provider_failed"; errorName: string };

export async function speakText(
  deps: SynthesisDeps,
  input: { text: string },
): Promise<SynthesisOutcome> {
  const verdict = checkSpeakText(input.text);
  if (!verdict.ok) return { outcome: "rejected", reason: verdict.reason };

  try {
    // Verbatim, all the way to the provider. Nothing here rewrites a sentence
    // for speech: the spoken reply and the written one are the same reply.
    const { audio, mimeType } = await deps.voice.synthesize({ text: verdict.text });
    return { outcome: "spoken", audio, mimeType };
  } catch (error) {
    // The one failure the caller must NOT treat as an error. It is answered by
    // the provider itself rather than by an environment check in the route,
    // so there is exactly one place that knows whether voice is configured.
    if (error instanceof SpeechUnavailableError) return { outcome: "unavailable" };
    return {
      outcome: "provider_failed",
      errorName: error instanceof Error ? error.name : "UnknownError",
    };
  }
}
