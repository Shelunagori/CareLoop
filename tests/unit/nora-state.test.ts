import { describe, expect, it } from "vitest";
import {
  noraState,
  noraStateLabel,
  wakeIsArmed,
  type NoraInputs,
  type NoraState,
} from "@/core/nora/state";

/**
 * The invariant: never an unresolved transcript AND an armed wake detector.
 *
 * Found in a real browser. A wake produced "good morning" as an unsent draft
 * and the interface went straight back to listening for the wake word, so a
 * second wake could have overwritten words the person had not finished with.
 *
 * The fix was not a guard at the re-arm call site — it was deleting the
 * re-arm call site. Arming is now derived, and the derivation is this file.
 */
const base: NoraInputs = {
  configured: true,
  available: true,
  enabled: true,
  starting: false,
  recorder: "off",
  wakeTurn: false,
  composerHasText: false,
  draftFromVoice: false,
  sending: false,
  speaking: false,
  inBurst: false,
};

const at = (overrides: Partial<NoraInputs> = {}): NoraState =>
  noraState({ ...base, ...overrides });

const EVERY_STATE: NoraState[] = [
  "off",
  "unavailable",
  "starting",
  "waiting_for_wake",
  "listening",
  "push_to_talk",
  "transcribing",
  "speaking",
  "draft_ready",
  "paused_for_typing",
  "busy",
];

describe("1. exactly one state arms the wake detector", () => {
  it("is armed in waiting_for_wake and nowhere else", () => {
    const armed = EVERY_STATE.filter(wakeIsArmed);
    expect(armed).toEqual(["waiting_for_wake"]);
  });

  it("every state has a name, so none can be silently unhandled", () => {
    for (const state of EVERY_STATE) {
      if (state === "unavailable") {
        // The server's own reason is shown instead, so this one is null on
        // purpose rather than by omission.
        expect(noraStateLabel(state)).toBeNull();
        continue;
      }
      expect(noraStateLabel(state), state).toBeTruthy();
    }
  });
});

describe("2. an unresolved draft is never armed — the bug, written down", () => {
  it("a Nora transcript in the composer is draft_ready, not waiting_for_wake", () => {
    const state = at({ composerHasText: true, draftFromVoice: true });
    expect(state).toBe("draft_ready");
    expect(wakeIsArmed(state)).toBe(false);
  });

  it("the person's own typing also stands Nora down", () => {
    // Same invariant for a different reason: a wake capture would replace
    // text they wrote themselves, which is worse than not waking.
    const state = at({ composerHasText: true, draftFromVoice: false });
    expect(state).toBe("paused_for_typing");
    expect(wakeIsArmed(state)).toBe(false);
  });

  it("clearing the composer re-arms", () => {
    expect(at({ composerHasText: true, draftFromVoice: true })).toBe("draft_ready");
    expect(at({ composerHasText: false, draftFromVoice: false })).toBe("waiting_for_wake");
  });

  it("sending re-arms only once the send has finished", () => {
    expect(at({ sending: true })).toBe("busy");
    expect(wakeIsArmed(at({ sending: true }))).toBe(false);
    expect(at({ sending: false })).toBe("waiting_for_wake");
  });

  it("editing the transcript does not resolve it", () => {
    // Editing changes the text, not its status. Still a draft, still not armed.
    const edited = at({ composerHasText: true, draftFromVoice: true });
    expect(edited).toBe("draft_ready");
    expect(wakeIsArmed(edited)).toBe(false);
  });
});

describe("3. a live microphone outranks everything after it", () => {
  it("a wake turn is listening", () => {
    expect(at({ recorder: "recording", wakeTurn: true })).toBe("listening");
  });

  it("a pressed microphone is push_to_talk, and Nora is not armed", () => {
    const state = at({ recorder: "recording", wakeTurn: false });
    expect(state).toBe("push_to_talk");
    expect(wakeIsArmed(state)).toBe(false);
  });

  it("transcribing is not armed", () => {
    expect(wakeIsArmed(at({ recorder: "transcribing" }))).toBe(false);
  });
});

describe("4. the server outranks the toggle", () => {
  it("an expired answer is unavailable even with the toggle on", () => {
    expect(at({ available: false, enabled: true })).toBe("unavailable");
  });

  it("an unanswered server is not armed — silence is not a yes", () => {
    const state = at({ available: null });
    expect(state).toBe("starting");
    expect(wakeIsArmed(state)).toBe(false);
  });

  it("an unconfigured build is simply off, and asks nothing", () => {
    expect(at({ configured: false, available: true, enabled: true })).toBe("off");
  });

  it("starting is not armed", () => {
    expect(wakeIsArmed(at({ starting: true }))).toBe(false);
  });
});

describe("5. the whole input space, brute-forced", () => {
  /**
   * 2^7 x 3 combinations. Cheap, and it proves the property rather than
   * sampling it: nothing anywhere in the space arms the detector while a
   * recorder is live, a send is in flight, text is waiting, the server has
   * refused or not answered, or the engine is still starting.
   */
  it("never arms while anything is unresolved", () => {
    const bools = [false, true];
    const recorders = ["off", "recording", "transcribing"] as const;
    const availables = [null, false, true];
    let armedCount = 0;
    let total = 0;

    for (const configured of bools)
      for (const available of availables)
        for (const enabled of bools)
          for (const starting of bools)
            for (const recorder of recorders)
              for (const wakeTurn of bools)
                for (const composerHasText of bools)
                  for (const draftFromVoice of bools)
                    for (const sending of bools)
                    for (const speaking of bools)
                    for (const inBurst of bools) {
                      total += 1;
                      const inputs: NoraInputs = {
                        configured, available, enabled, starting,
                        recorder, wakeTurn, composerHasText, draftFromVoice, sending,
                        speaking, inBurst,
                      };
                      if (!wakeIsArmed(noraState(inputs))) continue;
                      armedCount += 1;
                      expect(inputs.configured).toBe(true);
                      expect(inputs.available).toBe(true);
                      expect(inputs.enabled).toBe(true);
                      expect(inputs.starting).toBe(false);
                      expect(inputs.recorder).toBe("off");
                      expect(inputs.composerHasText).toBe(false);
                      expect(inputs.sending).toBe(false);
                      expect(inputs.speaking).toBe(false);
                      /**
                       * M12f. The wake detector is NEVER armed inside a
                       * conversation burst. The burst's own bounded window
                       * owns the microphone, and two ways into it at once
                       * is the thing this file exists to prevent.
                       */
                      expect(inputs.inBurst).toBe(false);
                    }

    expect(total).toBeGreaterThan(1000);
    // And it is reachable — a rule nothing satisfies is not a rule.
    expect(armedCount).toBeGreaterThan(0);
  });
});

describe("5a. CareLoop's own voice must not wake it", () => {
  /**
   * Observed in the browser: "Stop reading" and "Nora is listening for
   * 'Hey Nora'" on screen at the same time. There is no barge-in here — no
   * echo cancellation tuned for it, no tested duplex path — so an armed
   * detector during playback is a microphone pointed at a loudspeaker that
   * is about to say the wake word out loud.
   *
   * Listening and speaking are therefore mutually exclusive, as arithmetic
   * rather than as a promise.
   */
  it("speaking is a state of its own, and it is not armed", () => {
    const state = at({ speaking: true });
    expect(state).toBe("speaking");
    expect(wakeIsArmed(state)).toBe(false);
  });

  it("outranks an idle composer", () => {
    expect(at({ speaking: true, composerHasText: false })).toBe("speaking");
  });

  it("finishing playback returns to armed, when nothing else is pending", () => {
    expect(at({ speaking: false })).toBe("waiting_for_wake");
  });

  it("but not when Nora was switched off while it played", () => {
    expect(at({ speaking: false, enabled: false })).toBe("off");
  });

  it("nor when the server refused while it played", () => {
    expect(at({ speaking: false, available: false })).toBe("unavailable");
  });

  it("nor when a draft is still waiting", () => {
    expect(at({ speaking: false, composerHasText: true, draftFromVoice: true })).toBe("draft_ready");
  });
});

describe("6. nothing in the wording names a vendor", () => {
  it("no label mentions a provider, a quota or an API", () => {
    for (const state of EVERY_STATE) {
      const label = noraStateLabel(state) ?? "";
      for (const leak of [/picovoice/i, /porcupine/i, /quota/i, /api/i, /subscription/i]) {
        expect(label, `${state}: ${leak}`).not.toMatch(leak);
      }
    }
  });

  it("the wake phrase people are told is the one that was trained", () => {
    expect(noraStateLabel("waiting_for_wake")).toContain("Hey Nora");
    expect(noraStateLabel("off")).toContain("Hey Nora");
  });
});
