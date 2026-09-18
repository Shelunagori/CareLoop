import "server-only";
import OpenAI from "openai";
import { transcriptionLanguage, transcriptionModel } from "@/server/config";
import { describeProviderError, errorName, logProviderCall } from "./log";
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
      // PINNED, never detected. A one-word clip gives automatic detection
      // almost nothing to go on, and live acceptance produced a "yes"
      // transcribed as a Chinese character - which then travelled correctly
      // through a pipeline that was right about everything except the
      // premise. See server/config.ts for why this is configuration.
      const language = transcriptionLanguage();
      const startedAt = Date.now();

      /**
       * The filename and type the PROVIDER sees, built here rather than taken
       * from the browser.
       *
       * The browser uploads its part as `filename="speech"` with
       * `audio/webm;codecs=opus`. Neither reaches OpenAI: the route hands over
       * bytes plus a mime type, `normalizeAudioType` has already stripped the
       * `;codecs=` parameter, and the name below is constructed with an
       * extension. OpenAI infers the container from the extension, so a
       * name with none would be rejected - which is why it has one.
       */
      const filename = `speech.${extensionFor(mimeType)}`;
      const uploadBytes = audio.byteLength;

      try {
        const file = await OpenAI.toFile(Buffer.from(audio), filename, {
          type: mimeType,
        });
        const response = await client.audio.transcriptions.create({ file, model, language });
        // The provider's words, trimmed. Never corrected towards a name
        // CareLoop happens to know - see core/voice/limits.ts.
        const text = (response.text ?? "").trim();

        logProviderCall({
          event: "voice.transcribe",
          outcome: "ok",
          model,
          language,
          latencyMs: Date.now() - startedAt,
          // Length only. The transcript is the person's own speech and has no
          // business in a log line.
          transcriptLength: text.length,
        });
        return { text, model };
      } catch (error) {
        const upstream = describeProviderError(error);
        logProviderCall({
          event: "voice.transcribe",
          outcome: "request_failed",
          model,
          language,
          latencyMs: Date.now() - startedAt,
          errorName: errorName(error),
          // Exactly what the provider rejected, and exactly what we sent it.
          // Enough to tell a bad key from a bad model from a bad container
          // without a second deploy.
          upstreamStatus: upstream.status,
          upstreamCode: upstream.code,
          upstreamType: upstream.type,
          upstreamRequestId: upstream.requestId,
          upstreamMessage: upstream.message,
          sentFilename: filename,
          sentMimeType: mimeType,
          uploadBytes,
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
