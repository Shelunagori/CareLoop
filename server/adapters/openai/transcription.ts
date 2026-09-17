import "server-only";
import OpenAI from "openai";
import { transcriptionModel } from "@/server/config";
import { errorName, logProviderCall } from "./log";
import type { SpeechToTextProvider, TranscribeResponse } from "./types";

/**
 * Speech to text.
 *
 * The audio is handed to the provider from memory and never written to disk:
 * `toFile` wraps the buffer the route already holds, so there is no temporary
 * file to forget to delete. Once this function returns, the only surviving
 * artefact of the recording is a string.
 *
 * Nothing about the audio is logged - not the bytes, not a hash of them, not a
 * duration that could distinguish one utterance from another. Only that a call
 * happened, how long it took, and how many characters came back.
 */
export function createOpenAiTranscription(): SpeechToTextProvider {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("Missing required environment variable OPENAI_API_KEY.");
  const client = new OpenAI({ apiKey });

  return {
    async transcribe({ audio, mimeType }): Promise<TranscribeResponse> {
      const model = transcriptionModel();
      const startedAt = Date.now();

      try {
        const file = await OpenAI.toFile(Buffer.from(audio), `speech.${extensionFor(mimeType)}`, {
          type: mimeType,
        });
        const response = await client.audio.transcriptions.create({ file, model });
        // The provider's words, trimmed. Never corrected towards a name
        // CareLoop happens to know - see core/voice/limits.ts.
        const text = (response.text ?? "").trim();

        logProviderCall({
          event: "voice.transcribe",
          outcome: "ok",
          model,
          latencyMs: Date.now() - startedAt,
          // Length only. The transcript is the person's own speech and has no
          // business in a log line.
          transcriptLength: text.length,
        });
        return { text, model };
      } catch (error) {
        logProviderCall({
          event: "voice.transcribe",
          outcome: "request_failed",
          model,
          latencyMs: Date.now() - startedAt,
          errorName: errorName(error),
        });
        throw error;
      }
    },
  };
}

/** A filename extension the provider will accept for this container. */
function extensionFor(mimeType: string): string {
  switch (mimeType) {
    case "audio/ogg":
      return "ogg";
    case "audio/mp4":
      return "mp4";
    case "audio/mpeg":
      return "mp3";
    case "audio/wav":
    case "audio/x-wav":
      return "wav";
    default:
      return "webm";
  }
}
