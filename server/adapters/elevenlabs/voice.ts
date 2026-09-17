import "server-only";
import { isSpeechSynthesisConfigured, type SpeechEnv } from "@/server/config";
import { errorName, logProviderCall } from "@/server/adapters/openai/log";
import {
  unavailableVoice,
  type SynthesizeResponse,
  type VoiceProvider,
} from "@/server/adapters/openai/types";

/**
 * Text to speech, via ElevenLabs.
 *
 * `fetch` rather than an SDK: the call is one POST with a body of
 * `{ text }`, and a dependency whose only job is to build that request would
 * be more surface than the request itself.
 *
 * The text is passed through UNCHANGED. There is no prompt here and no model
 * choosing phrasing - what is spoken is what was shown, and the moment
 * something rewrites a sentence on its way to the speaker, the audio and the
 * screen can disagree about what CareLoop said.
 */
const API = "https://api.elevenlabs.io/v1/text-to-speech";

export function createElevenLabsVoice(
  env: SpeechEnv & { ELEVENLABS_MODEL_ID?: string } = process.env,
): VoiceProvider {
  // Absent credentials produce a provider that REFUSES, never a constructor
  // that throws. Voice output is the only optional capability in CareLoop, and
  // if its absence could break dependency construction it would take the typed
  // conversation - and transcription - down with it. The refusal surfaces once,
  // at the one call that needs it, as a clean "not set up here".
  if (!isSpeechSynthesisConfigured(env)) return unavailableVoice();

  const apiKey = env.ELEVENLABS_API_KEY!.trim();
  const voiceId = env.ELEVENLABS_VOICE_ID!.trim();
  const modelId = env.ELEVENLABS_MODEL_ID?.trim() || "eleven_turbo_v2_5";

  return {
    async synthesize({ text }): Promise<SynthesizeResponse> {
      const startedAt = Date.now();

      try {
        const response = await fetch(`${API}/${encodeURIComponent(voiceId)}`, {
          method: "POST",
          headers: {
            "xi-api-key": apiKey,
            "content-type": "application/json",
            accept: "audio/mpeg",
          },
          body: JSON.stringify({ text, model_id: modelId }),
        });

        if (!response.ok) {
          // The provider's body may name the account, the quota or the key.
          // None of it travels: the status is enough to diagnose from a log.
          throw new Error(`elevenlabs_status_${response.status}`);
        }

        const audio = new Uint8Array(await response.arrayBuffer());
        logProviderCall({
          event: "voice.synthesize",
          outcome: "ok",
          model: modelId,
          latencyMs: Date.now() - startedAt,
          // Lengths, never the sentence. It is already on the person's screen;
          // it does not also belong in a log.
          textLength: text.length,
          audioBytes: audio.byteLength,
        });
        return { audio, mimeType: "audio/mpeg" };
      } catch (error) {
        logProviderCall({
          event: "voice.synthesize",
          outcome: "request_failed",
          model: modelId,
          latencyMs: Date.now() - startedAt,
          errorName: errorName(error),
        });
        throw error;
      }
    },
  };
}
