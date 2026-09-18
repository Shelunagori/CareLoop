import { readFileSync } from "node:fs";

/** Source with comments removed: only executable text is policy. */
const code = (file: string) =>
  readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
import { describe, expect, it } from "vitest";
import {
  ALLOWED_AUDIO_TYPES,
  checkAudioUpload,
  checkSpeakText,
  normalizeAudioType,
  readTranscript,
  VOICE_LIMITS,
} from "@/core/voice/limits";
import { speakText, transcribeTurn } from "@/server/services/voice";
import type { SpeechToTextProvider, VoiceProvider } from "@/server/adapters/openai/types";

/**
 * Voice I/O (M8).
 *
 * The thing under test is a boundary, not a feature: audio becomes a string,
 * a string becomes audio, and NOTHING in between decides what CareLoop does.
 * Several assertions below look like plumbing checks and are really that
 * boundary written down — a voice layer that started resolving names or
 * approving things would be a second policy system, and the architecture
 * would be a claim rather than a fact.
 */
const bytes = (n: number) => new Uint8Array(n);

const sttProvider = (result: string | Error): SpeechToTextProvider & { calls: number } => {
  const provider = {
    calls: 0,
    async transcribe() {
      provider.calls += 1;
      if (result instanceof Error) throw result;
      return { text: result, model: "test-stt" };
    },
  };
  return provider;
};

const ttsProvider = (result?: Error) => {
  const calls: string[] = [];
  const provider: VoiceProvider & { calls: string[] } = {
    calls,
    async synthesize({ text }) {
      calls.push(text);
      if (result) throw result;
      return { audio: new Uint8Array([1, 2, 3]), mimeType: "audio/mpeg" };
    },
  };
  return provider;
};

describe("1. what may be uploaded", () => {
  it("accepts the containers a browser actually records", () => {
    for (const type of ALLOWED_AUDIO_TYPES) {
      expect(checkAudioUpload({ mimeType: type, bytes: 4096 }).ok, type).toBe(true);
    }
  });

  it("accepts a codec parameter without hard-coding one codec", () => {
    // MediaRecorder reports `audio/webm;codecs=opus`. Matching the base type
    // is what lets the browser choose.
    const verdict = checkAudioUpload({ mimeType: "audio/webm;codecs=opus", bytes: 4096 });
    expect(verdict).toEqual({ ok: true, mimeType: "audio/webm" });
    expect(normalizeAudioType("AUDIO/WEBM; codecs=opus")).toBe("audio/webm");
  });

  it("refuses anything not on the list, rather than asking a provider", () => {
    for (const type of ["video/mp4", "application/octet-stream", "text/plain", ""]) {
      const verdict = checkAudioUpload({ mimeType: type, bytes: 4096 });
      expect(verdict.ok, type).toBe(false);
      expect(!verdict.ok && verdict.reason.code).toBe("unsupported_type");
    }
  });

  it("refuses a recording too small to contain speech", () => {
    const verdict = checkAudioUpload({ mimeType: "audio/webm", bytes: 0 });
    expect(!verdict.ok && verdict.reason.code).toBe("empty_audio");
    expect(
      checkAudioUpload({ mimeType: "audio/webm", bytes: VOICE_LIMITS.minAudioBytes - 1 }).ok,
    ).toBe(false);
  });

  it("refuses a recording larger than the server's own ceiling", () => {
    const verdict = checkAudioUpload({
      mimeType: "audio/webm",
      bytes: VOICE_LIMITS.maxAudioBytes + 1,
    });
    expect(!verdict.ok && verdict.reason.code).toBe("too_large");
    // Exactly at the limit is fine; one byte over is not.
    expect(checkAudioUpload({ mimeType: "audio/webm", bytes: VOICE_LIMITS.maxAudioBytes }).ok).toBe(
      true,
    );
  });
});

describe("2. the transcript is evidence, not a guess to be improved", () => {
  it("returns exactly what the provider said", async () => {
    const provider = sttProvider("I haven't seen John this week.");
    const result = await transcribeTurn({ speechToText: provider }, {
      audio: bytes(4096),
      mimeType: "audio/webm",
    });
    expect(result).toEqual({ outcome: "transcribed", text: "I haven't seen John this week." });
  });

  it("does not correct a name towards one CareLoop happens to know", async () => {
    // The microphone heard "Johnny". Whether that is the John in the database
    // is entity resolution's question, downstream, where it can be reviewed -
    // not something the voice layer silently decides.
    const provider = sttProvider("I haven't seen Johnny this week.");
    const result = await transcribeTurn({ speechToText: provider }, {
      audio: bytes(4096),
      mimeType: "audio/webm",
    });
    expect(result).toMatchObject({ text: "I haven't seen Johnny this week." });
  });

  it("trims, and nothing else", () => {
    expect(readTranscript("  yes  ")).toEqual({ ok: true, text: "yes" });
    expect(readTranscript("   ")).toEqual({ ok: false });
  });

  it("silence is a distinct outcome, not an empty message", async () => {
    const result = await transcribeTurn({ speechToText: sttProvider("   ") }, {
      audio: bytes(4096),
      mimeType: "audio/webm",
    });
    expect(result).toEqual({ outcome: "no_speech" });
  });

  it("a rejected upload never reaches the provider", async () => {
    const provider = sttProvider("should not happen");
    for (const input of [
      { audio: bytes(4096), mimeType: "video/mp4" },
      { audio: bytes(0), mimeType: "audio/webm" },
      { audio: bytes(VOICE_LIMITS.maxAudioBytes + 1), mimeType: "audio/webm" },
    ]) {
      const result = await transcribeTurn({ speechToText: provider }, input);
      expect(result.outcome).toBe("rejected");
    }
    expect(provider.calls).toBe(0);
  });

  it("a provider failure is reduced to a name", async () => {
    const boom = new Error("api key sk-live-123 rejected for org acme");
    boom.name = "AuthenticationError";
    const result = await transcribeTurn({ speechToText: sttProvider(boom) }, {
      audio: bytes(4096),
      mimeType: "audio/webm",
    });
    expect(result).toEqual({ outcome: "provider_failed", errorName: "AuthenticationError" });
    // The message could name a key, a model or an account. None of it travels.
    expect(JSON.stringify(result)).not.toContain("sk-live");
    expect(JSON.stringify(result)).not.toContain("acme");
  });

  it("the audio is never returned, stored or echoed", async () => {
    const result = await transcribeTurn({ speechToText: sttProvider("hello") }, {
      audio: bytes(4096),
      mimeType: "audio/webm",
    });
    expect(Object.keys(result)).toEqual(["outcome", "text"]);
  });
});

describe("3. speech is a rendering of text already shown", () => {
  it("passes the visible text through unchanged", async () => {
    const provider = ttsProvider();
    const text = "Dad was wondering — are you and Simba able to visit soon?";
    const result = await speakText({ voice: provider }, { text });

    expect(result.outcome).toBe("spoken");
    // Byte-for-byte. A layer that tidied a sentence for speech would make the
    // spoken CareLoop and the written CareLoop two different companions.
    expect(provider.calls).toEqual([text]);
  });

  it("returns the provider's audio and its type", async () => {
    const result = await speakText({ voice: ttsProvider() }, { text: "hello there" });
    expect(result).toMatchObject({ outcome: "spoken", mimeType: "audio/mpeg" });
  });

  it("refuses empty text and text past the ceiling", async () => {
    expect(checkSpeakText("   ")).toMatchObject({ ok: false });
    const long = "a".repeat(VOICE_LIMITS.maxSpeakCharacters + 1);
    expect(checkSpeakText(long)).toMatchObject({ ok: false });
    // Exactly at the limit is fine.
    expect(checkSpeakText("a".repeat(VOICE_LIMITS.maxSpeakCharacters)).ok).toBe(true);

    const provider = ttsProvider();
    await speakText({ voice: provider }, { text: long });
    expect(provider.calls).toEqual([]);
  });

  it("a provider failure is reduced to a name and costs the turn nothing", async () => {
    const boom = new Error("voice id xyz not found for key el-live-9");
    boom.name = "SpeechError";
    const result = await speakText({ voice: ttsProvider(boom) }, { text: "hello there" });
    expect(result).toEqual({ outcome: "provider_failed", errorName: "SpeechError" });
    expect(JSON.stringify(result)).not.toContain("el-live");
  });

  it("there is no second model anywhere on the speech path", () => {
    // The one guarantee that makes "what is heard is what was shown" true.
    const source = code("server/services/voice.ts");
    for (const forbidden of ["streamChat", "extract", "promptRef", "system:", "LlmProvider"]) {
      expect(source, forbidden).not.toContain(forbidden);
    }
  });
});

describe("4. voice decides nothing", () => {
  it("the service touches no memory, consent or detection surface", () => {
    const source = code("server/services/voice.ts");
    for (const forbidden of [
      "consent",
      "opportunit",
      "entities",
      "episodes",
      "messages",
      "repositories",
      "detect",
    ]) {
      expect(source.toLowerCase(), forbidden).not.toContain(forbidden);
    }
  });

  it("the transcribe route runs no pipeline of its own", () => {
    const source = code("app/api/voice/transcribe/route.ts");
    for (const forbidden of ["runIngestionSweep", "runDetectionSweep", "handleTurn", "consent"]) {
      expect(source, forbidden).not.toContain(forbidden);
    }
  });

  it("no raw audio is persisted anywhere", () => {
    // Bytes exist for the duration of one request. Nothing writes them.
    for (const file of [
      "server/services/voice.ts",
      "app/api/voice/transcribe/route.ts",
      "server/adapters/openai/transcription.ts",
    ]) {
      const source = code(file);
      for (const forbidden of ["writeFile", "createWriteStream", "storage", "upload(", "insert("]) {
        expect(source, `${file}: ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it("nothing about the audio reaches a log line", () => {
    const source = code("server/adapters/openai/transcription.ts");
    // The RECORDS themselves, not the file: the file necessarily mentions
    // audio, since that is what it transcribes.
    const records = [...source.matchAll(/logProviderCall\(\{([\s\S]*?)\}\);/g)].map(
      (match) => match[1],
    );
    expect(records.length).toBeGreaterThan(0);
    for (const record of records) {
      for (const forbidden of ["audio", "hashText", "text:", "transcript:"]) {
        expect(record, forbidden).not.toContain(forbidden);
      }
    }
    // A length, which cannot reconstruct a word of what was said.
    expect(source).toContain("transcriptLength: text.length");
  });

  it("an upload SIZE is diagnosable on failure, and invisible on success", () => {
    /**
     * A byte count is not content, but it is close to a duration - and this
     * adapter's comment deliberately excluded durations because they let one
     * utterance be told from another. Debugging the production 502 needs it
     * (an empty upload and a real one have to be distinguishable from a log),
     * so the compromise is asymmetric: a FAILED call records the size, a
     * SUCCESSFUL one records nothing about the recording at all.
     */
    const source = code("server/adapters/openai/transcription.ts");
    const records = [...source.matchAll(/logProviderCall\(\{([\s\S]*?)\}\);/g)].map(
      (match) => match[1],
    );

    const succeeded = records.filter((record) => record.includes('outcome: "ok"'));
    const failed = records.filter((record) => record.includes('outcome: "request_failed"'));
    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(1);

    expect(succeeded[0], "a successful call fingerprinted the recording").not.toContain("uploadBytes");
    expect(failed[0]).toContain("uploadBytes");
  });

  it("speech synthesis is optional — its absence is configuration, not failure", async () => {
    const { isSpeechSynthesisConfigured } = await import("@/server/config");
    expect(isSpeechSynthesisConfigured({})).toBe(false);
    expect(isSpeechSynthesisConfigured({ ELEVENLABS_API_KEY: "k" })).toBe(false);
    expect(isSpeechSynthesisConfigured({ ELEVENLABS_API_KEY: "k", ELEVENLABS_VOICE_ID: "v" })).toBe(
      true,
    );
    expect(
      isSpeechSynthesisConfigured({ ELEVENLABS_API_KEY: "  ", ELEVENLABS_VOICE_ID: "v" }),
    ).toBe(false);

    const source = readFileSync("app/api/voice/speak/route.ts", "utf8");
    // A clean "not set up here", never a 500 — answered by the provider, not
    // by an environment check inside the route.
    expect(source).toContain("speech_unavailable");
    expect(source).toContain("503");
    expect(source).not.toContain("isSpeechSynthesisConfigured");
  });

  it("the adapter exists without credentials, and refuses only when asked", async () => {
    const raw = readFileSync("server/adapters/elevenlabs/voice.ts", "utf8");
    // Still `server-only`: the key must not be reachable from a client bundle.
    expect(raw.startsWith('import "server-only";')).toBe(true);
    expect(raw).toContain("if (!isSpeechSynthesisConfigured(env)) return unavailableVoice();");
    // And it decides BEFORE reading either value.
    const body = raw.slice(raw.indexOf("export function createElevenLabsVoice"));
    expect(body.indexOf("unavailableVoice()")).toBeLessThan(body.indexOf("ELEVENLABS_API_KEY"));

    // A provider that EXISTS and declines, rather than a constructor that
    // throws: an optional capability must not be able to break composition.
    const { unavailableVoice } = await import("@/server/adapters/openai/types");
    const provider = unavailableVoice();
    await expect(provider.synthesize({ text: "hello" })).rejects.toMatchObject({
      name: "SpeechUnavailableError",
    });
  });
});

describe("5. the ports stay narrow", () => {
  it("speech to text takes bytes and returns a string — nothing else", () => {
    const types = readFileSync("server/adapters/openai/types.ts", "utf8");
    const port = types.slice(types.indexOf("export type TranscribeRequest"));
    // No conversation, no history, no entity list, no user id: there is no
    // parameter through which context could arrive.
    for (const forbidden of ["messages", "history", "entities", "userId", "conversationId"]) {
      expect(port, forbidden).not.toContain(forbidden);
    }
  });

  it("text to speech takes text and returns audio — no prompt, no model choice", () => {
    const types = readFileSync("server/adapters/openai/types.ts", "utf8");
    const port = types.slice(types.indexOf("export type SynthesizeRequest"));
    for (const forbidden of ["promptRef", "system", "messages", "instructions"]) {
      expect(port, forbidden).not.toContain(forbidden);
    }
  });

  it("the ElevenLabs adapter sends the text and nothing derived from it", () => {
    const source = code("server/adapters/elevenlabs/voice.ts");
    expect(source).toContain("JSON.stringify({ text, model_id: modelId })");
    // No rewriting, no SSML assembly, no per-sentence splitting.
    for (const forbidden of ["replace(", "split(", "slice(", "toLowerCase"]) {
      expect(source, forbidden).not.toContain(forbidden);
    }
  });
});

describe("6. spoken input lands in the pipeline that already existed", () => {
  /**
   * The M8 contract, with the providers mocked and everything else real.
   *
   * It follows one utterance the whole way: bytes in, transcript out,
   * transcript into the SAME deterministic consent parser a typed answer
   * meets. If a voice-specific approval path ever appears, this is where it
   * shows up — the parser here is the production one, not a stand-in.
   */
  it("an utterance becomes a transcript and nothing more", async () => {
    const provider = sttProvider("I haven't seen John this week.");
    const result = await transcribeTurn({ speechToText: provider }, {
      audio: bytes(8192),
      mimeType: "audio/webm;codecs=opus",
    });

    expect(result).toEqual({ outcome: "transcribed", text: "I haven't seen John this week." });
    // No signal, no opportunity, no memory write. Just a string.
    expect(provider.calls).toBe(1);
  });

  it("a spoken 'yes' reaches the real consent parser, unchanged", async () => {
    const { readConsent } = await import("@/core/consent/decision");

    const heard = await transcribeTurn({ speechToText: sttProvider("  yes  ") }, {
      audio: bytes(4096),
      mimeType: "audio/webm",
    });
    expect(heard).toMatchObject({ outcome: "transcribed", text: "yes" });

    // The production parser, on the transcript, with no voice-aware branch.
    const spoken = readConsent(heard.outcome === "transcribed" ? heard.text : "");
    const typed = readConsent("yes");
    expect(spoken.decision).toBe("approve");
    expect(spoken).toEqual(typed);
  });

  it("a spoken 'no' declines by exactly the same route", async () => {
    const { readConsent } = await import("@/core/consent/decision");
    const heard = await transcribeTurn({ speechToText: sttProvider("no") }, {
      audio: bytes(4096),
      mimeType: "audio/webm",
    });
    const spoken = readConsent(heard.outcome === "transcribed" ? heard.text : "");
    expect(spoken.decision).toBe("decline");
    expect(spoken).toEqual(readConsent("no"));
  });

  it("an ambiguous utterance stays ambiguous — speech grants nothing", async () => {
    const { readConsent } = await import("@/core/consent/decision");
    for (const utterance of ["yes, but maybe later", "hmm", "not yet"]) {
      const heard = await transcribeTurn({ speechToText: sttProvider(utterance) }, {
        audio: bytes(4096),
        mimeType: "audio/webm",
      });
      const decision = readConsent(heard.outcome === "transcribed" ? heard.text : "").decision;
      // Whatever the parser says of the typed form, it says of the spoken one.
      expect(decision, utterance).toBe(readConsent(utterance).decision);
      expect(decision, utterance).not.toBe("approve");
    }
  });

  it("the approved draft may be read aloud, and is unchanged by being read", async () => {
    const { buildOfferBlock } = await import("@/core/share/offer");
    const stored = "Dad was wondering — are you and Simba able to visit soon?";
    const block = buildOfferBlock({ entityName: "John", renderedText: stored });

    const provider = ttsProvider();
    await speakText({ voice: provider }, { text: block });

    // Voice may read the draft. It may not modify it: the bytes handed to the
    // speaker still contain the stored sentence exactly.
    expect(provider.calls[0]).toContain(stored);
    expect(provider.calls[0]).toBe(block);
  });
});

/**
 * Hands-free consent is the same consent (M9).
 *
 * The one thing hands-free must not change. A transcript produced without
 * anybody pressing anything still reaches the same deterministic parser a
 * typed answer does — so the interesting assertions here are about the
 * ABSENCE of a second path, and about ambiguity staying ambiguous when nobody
 * is holding a mouse.
 */
/**
 * A spoken answer is the typed answer (M8, kept).
 *
 * Dictation types a word into the composer and stops. The person still presses
 * Send, and what they send goes to the same deterministic parser a typed
 * answer does - which is why there is no voice consent path to audit.
 */
describe("7. a dictated answer is read by the same parser", () => {
  it("a dictated 'yes' is read by the production parser, unchanged", async () => {
    const { readConsent } = await import("@/core/consent/decision");
    const heard = await transcribeTurn({ speechToText: sttProvider("yes") }, {
      audio: bytes(4096),
      mimeType: "audio/webm",
    });
    if (heard.outcome !== "transcribed") throw new Error("expected a transcript");

    expect(heard.text).toBe("yes");
    expect(readConsent(heard.text).decision).toBe(readConsent("yes").decision);
    expect(readConsent(heard.text).decision).toBe("approve");
  });

  it("dictation does not make an ambiguous answer decisive", async () => {
    const { readConsent } = await import("@/core/consent/decision");
    for (const utterance of ["maybe", "yes, but maybe later", "not sure", "hmm", "later"]) {
      const heard = await transcribeTurn({ speechToText: sttProvider(utterance) }, {
        audio: bytes(4096),
        mimeType: "audio/webm",
      });
      const text = heard.outcome === "transcribed" ? heard.text : "";
      expect(readConsent(text).decision, utterance).not.toBe("approve");
    }
  });

  it("the client voice layer has no way to approve anything", () => {
    // It can put a word in a textarea. It cannot create a grant, resolve an
    // opportunity, or reach the family loop at all.
    for (const file of ["app/_components/voice.ts", "app/_components/speech.ts"]) {
      const source = code(file);
      for (const forbidden of [
        "consent",
        "approve",
        "creategrant",
        "opportunit",
        "family",
        "renderedtext",
      ]) {
        expect(source.toLowerCase(), `${file}: ${forbidden}`).not.toContain(forbidden);
      }
    }
  });
});

describe("8. transcription is told what language to expect", () => {
  it("defaults to English for this POC", async () => {
    const { transcriptionLanguage } = await import("@/server/config");
    const saved = process.env.OPENAI_TRANSCRIPTION_LANGUAGE;
    delete process.env.OPENAI_TRANSCRIPTION_LANGUAGE;
    try {
      expect(transcriptionLanguage()).toBe("en");
    } finally {
      if (saved === undefined) delete process.env.OPENAI_TRANSCRIPTION_LANGUAGE;
      else process.env.OPENAI_TRANSCRIPTION_LANGUAGE = saved;
    }
  });

  it("is configuration, not a constant", async () => {
    const { transcriptionLanguage } = await import("@/server/config");
    const saved = process.env.OPENAI_TRANSCRIPTION_LANGUAGE;
    process.env.OPENAI_TRANSCRIPTION_LANGUAGE = "nl";
    try {
      // The seam where "the deployment's language" becomes "this person's".
      expect(transcriptionLanguage()).toBe("nl");
      process.env.OPENAI_TRANSCRIPTION_LANGUAGE = "  ";
      expect(transcriptionLanguage()).toBe("en");
    } finally {
      if (saved === undefined) delete process.env.OPENAI_TRANSCRIPTION_LANGUAGE;
      else process.env.OPENAI_TRANSCRIPTION_LANGUAGE = saved;
    }
  });

  it("the adapter sends it to the provider", () => {
    // Asserted structurally rather than by naming a language: the point is
    // that SOMETHING is pinned, and that it is the configured value.
    const source = code("server/adapters/openai/transcription.ts");
    expect(source).toContain("const language = transcriptionLanguage();");
    expect(source).toContain(
      "client.audio.transcriptions.create({ file, model, language })",
    );
    // And no prompt-side coercion anywhere near it.
    for (const forbidden of ["prompt:", "Respond in", "in English"]) {
      expect(source, forbidden).not.toContain(forbidden);
    }
  });

  it("the language reaches the log, so a wrong one is diagnosable", () => {
    const source = code("server/adapters/openai/transcription.ts");
    const records = [...source.matchAll(/logProviderCall\(\{([\s\S]*?)\}\);/g)].map((m) => m[1]);
    expect(records.some((record) => record.includes("language"))).toBe(true);
    // Still no transcript, and still no audio.
    for (const record of records) {
      for (const forbidden of ["audio", "text:", "transcript:"]) {
        expect(record, forbidden).not.toContain(forbidden);
      }
    }
  });
});
