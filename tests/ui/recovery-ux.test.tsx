import { describe, expect, it } from "vitest";
import { RECOVERY, type RecoveryKey } from "@/app/_components/recovery";
import { microphoneMessage, type MicrophoneFailure } from "@/app/_components/voice";
import { noraMessage } from "@/app/_components/nora";
import { speakMessage, type SpeakFailure } from "@/app/_components/speech";
import type { NoraUnavailableReason } from "@/core/nora/availability";

/**
 * Every way CareLoop can fail, audited as one voice.
 *
 * Eight paths: microphone permission, wake initialization, no speech,
 * transcription, network, chat generation, speech output, Nora expiry.
 * Three of them used to be string literals inside a component, which is
 * where wording drifts — the same class of failure had two tones depending
 * on which branch produced it.
 *
 * The rules below are applied to all four sources at once. One of them —
 * truthfulness about delivery — is not a matter of style: a person must
 * never be left wondering whether their family got the message.
 */
const MIC: MicrophoneFailure[] = ["permission_denied", "no_microphone", "unsupported", "failed"];
const NORA: NoraUnavailableReason[] = [
  "expired", "not_configured", "unsupported_browser", "microphone_denied", "initialization_failed",
];
const SPEAK: SpeakFailure[] = ["unavailable", "failed", "blocked"];

const everyMessage: Array<[string, string]> = [
  ...Object.entries(RECOVERY).map(([key, value]) => [`recovery.${key}`, value.text] as [string, string]),
  ...MIC.map((reason) => [`microphone.${reason}`, microphoneMessage(reason)] as [string, string]),
  ...NORA.map((reason) => [`nora.${reason}`, noraMessage(reason)] as [string, string]),
  ...SPEAK.map((reason) => [`speech.${reason}`, speakMessage(reason)] as [string, string]),
];

describe("1. the audit covers every path", () => {
  it("has a message for all eight failure classes", () => {
    // If a path is added without wording, this count moves and somebody has
    // to decide what CareLoop says before it can ship.
    expect(everyMessage.length).toBe(19);
    for (const [name, text] of everyMessage) {
      expect(text, name).toBeTruthy();
    }
  });
});

describe("2. nothing technical reaches the person", () => {
  it.each(everyMessage)("%s says nothing about how it is built", (name, text) => {
    for (const leak of [
      /\b\d{3}\b/,                       // status codes
      /error|exception|stack|undefined|null/i,
      /api|endpoint|server|token|request|payload/i,
      /picovoice|porcupine|cloudflare|elevenlabs|supabase|openai|brevo/i,
      /transcription service|provider|quota|subscription|sdk|worker/i,
    ]) {
      expect(text, `${name}: ${leak}`).not.toMatch(leak);
    }
  });

  it.each(everyMessage)("%s is short and calm", (name, text) => {
    expect(text.length, name).toBeLessThanOrEqual(140);
    // No stacked apology, and no shouting.
    expect((text.match(/sorry/gi) ?? []).length, name).toBeLessThanOrEqual(1);
    expect(text, name).not.toMatch(/!{1,}/);
  });
});

describe("3. every message leaves the person somewhere to go", () => {
  it.each(everyMessage)("%s names something they can still do", (name, text) => {
    // "can still", "you can", "try again", "press", "type" — one of them.
    expect(text, name).toMatch(
      /\b(you can|still|try again|press|type|say ["“]|when you)\b/i,
    );
  });
});

describe("4. delivery is never implied, only stated", () => {
  /**
   * The rule that is not style. The application knows exactly one thing
   * about a failed turn: nothing was persisted, so nothing was sent.
   */
  it("the network failure says plainly that nothing was sent", () => {
    expect(RECOVERY.chat_failed.delivery).toBe("not_sent");
    expect(RECOVERY.chat_failed.text).toContain("hasn't been sent");
  });

  it("and tells them their words are not lost", () => {
    expect(RECOVERY.chat_failed.text).toMatch(/still here|try again/i);
  });

  it("no other message mentions sending at all", () => {
    // A voice or wake failure has no bearing on delivery. Mentioning it
    // would invite a person to wonder about something that never happened.
    for (const [key, value] of Object.entries(RECOVERY) as Array<[RecoveryKey, typeof RECOVERY[RecoveryKey]]>) {
      if (key === "chat_failed") continue;
      expect(value.delivery, key).toBe("not_applicable");
      expect(value.text, key).not.toMatch(/\bsent\b|\bdelivered\b|\bmessage (has|was)\b/i);
    }
  });

  it("nothing anywhere claims a success", () => {
    // A NEGATED claim is the opposite of the failure being guarded — "hasn't
    // been sent" is the whole point of chat_failed — so the check is for an
    // UNNEGATED one.
    for (const [name, text] of everyMessage) {
      for (const word of ["sent", "delivered", "done", "succeeded", "saved"]) {
        const claimed = new RegExp(
          `(?<!\\b(?:not|never|no|hasn't|haven't|wasn't|isn't|didn't)\\s(?:\\w+\\s){0,2})\\b${word}\\b`,
          "i",
        );
        expect(text, `${name}: ${word}`).not.toMatch(claimed);
      }
    }
  });
});

describe("5. the two transcription failures stay different", () => {
  it("'I didn't catch that' is never used for a broken recording", () => {
    // Blaming somebody's voice for our capture bug. Found in M9, kept
    // separate ever since.
    expect(RECOVERY.no_speech.text).toMatch(/didn't catch that/i);
    expect(RECOVERY.transcription_failed.text).not.toMatch(/didn't catch that/i);
    expect(RECOVERY.transcription_failed.text).toMatch(/recording/i);
  });
});

describe("6. a failed wake never takes push-to-talk down with it", () => {
  it.each(NORA)("nora.%s points at the microphone button or at typing", (reason) => {
    expect(noraMessage(reason)).toMatch(/microphone button|still type|microphone|push-to-talk/i);
  });
});
