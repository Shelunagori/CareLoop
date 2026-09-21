"use client";

/**
 * What CareLoop says when something goes wrong (M12d).
 *
 * THE AUDIT THIS FILE IS THE RESULT OF. Eight failure paths were checked:
 * microphone permission, wake initialization, no speech, transcription,
 * network, chat generation, speech output, and Nora expiry. Three of them
 * were inline string literals in a component, which is where wording goes
 * to drift: the same class of failure had two different tones depending on
 * which branch produced it, and nobody could read the whole set at once.
 *
 * They are one table now, so that a person auditing the recovery voice
 * reads one file. The microphone, wake and speech messages stay with the
 * modules that raise them (`voice.ts`, `nora.ts`, `speech.ts`); this file
 * carries the rest and `tests/ui/recovery-ux.test.tsx` checks all four
 * sources against the same rules.
 *
 * THE RULES, and they are the reason the wording is not a matter of taste:
 *
 *   SHORT AND CALM. One or two sentences, no apology stacked on apology.
 *   ACTIONABLE. Every one names something the person can still do.
 *   NO TECHNICAL WORDS. No status codes, no provider, no "API", no
 *     "transcription service", no stack trace, no "unexpected error".
 *   TRUTHFUL ABOUT DELIVERY. This is the one that is not style. A person
 *     must never be left unsure whether their message reached their family.
 *     Each entry below declares what the application KNOWS happened, and a
 *     failure that could have sent something may never imply it did not.
 */

/** What the application knows about delivery when this is shown. */
export type DeliveryFact =
  /** Nothing left this device. Safe to say so, and the person needs to hear it. */
  | "not_sent"
  /** No send was in play at all. Saying anything about it would be noise. */
  | "not_applicable";

export type RecoveryMessage = {
  readonly text: string;
  readonly delivery: DeliveryFact;
};

export const RECOVERY = {
  /**
   * The transcriber heard nothing. NOT a failure of theirs, and the wording
   * must not suggest they were unclear — the recording was fine, it was
   * empty.
   */
  no_speech: {
    text: "I didn't catch that. Could you try again?",
    delivery: "not_applicable",
  },

  /**
   * The recording itself was unusable. Deliberately different from the one
   * above: telling somebody "I didn't catch that" when OUR capture failed
   * blames their voice for our bug.
   */
  transcription_failed: {
    text: "Sorry, that recording didn't work. Please try again.",
    delivery: "not_applicable",
  },

  /** A wake turn with nothing after it. Says what to do, not what broke. */
  wake_heard_nothing: {
    text: "I didn’t hear anything after that. Say “Hey Nora” when you’re ready.",
    delivery: "not_applicable",
  },

  /** The recorder's own ceiling, reached by a pressed recording. */
  recording_limit: {
    text: "That's as long as I can record at once. Here's what I heard — you can add to it before sending.",
    delivery: "not_applicable",
  },

  /** The same ceiling, reached by a wake turn. */
  listening_limit: {
    text: "That’s as long as I can listen at once. Here’s what I heard — you can add to it before sending.",
    delivery: "not_applicable",
  },

  /**
   * The turn never reached the server, or the server never finished it.
   *
   * THE IMPORTANT ONE. The assistant bubble is removed and nothing was
   * persisted, so the application KNOWS the message did not go anywhere —
   * and it says so, because the alternative is somebody wondering all
   * afternoon whether their family got it. Their words are still in the
   * composer to send again.
   */
  chat_failed: {
    text: "I'm having trouble connecting right now. Your message hasn't been sent — it's still here, so you can try again.",
    delivery: "not_sent",
  },

  /** Speech output failed. Reading aloud is the only thing lost. */
  speech_failed: {
    text: "I couldn't read that aloud, but you can still read it here.",
    delivery: "not_applicable",
  },
} as const satisfies Record<string, RecoveryMessage>;

export type RecoveryKey = keyof typeof RECOVERY;

/** The text alone, for the many call sites that need nothing else. */
export function recoveryText(key: RecoveryKey): string {
  return RECOVERY[key].text;
}
