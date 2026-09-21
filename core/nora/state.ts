/**
 * Where Nora is, as one value (M12).
 *
 * THE INVARIANT THIS FILE EXISTS FOR:
 *
 *   there is never both an unresolved transcript in the composer AND a wake
 *   detector able to start another capture.
 *
 * The browser test that prompted it: a wake produced "good morning" as an
 * unsent draft, and the interface went straight back to saying Nora was
 * listening. A second wake could then have overwritten words the person had
 * not finished with. Saying "don't re-arm there" in a comment is not a rule;
 * a total function with one armed state is.
 *
 * Deriving arming from state also removed the imperative re-arm call that
 * caused the bug. Nothing calls "re-arm" any more. The engine is told to
 * match `wakeIsArmed(noraState(...))`, and the only way to become armed is
 * for the composer to be empty and no turn to be in flight.
 *
 * Pure. No React, no timers, no engine. The shell in `chat.tsx` supplies the
 * inputs and applies the answer.
 */

export type NoraState =
  /** The toggle is off, or this build has no wake word at all. */
  | "off"
  /** The server refused: expired, or not configured. */
  | "unavailable"
  /** Initialising. Not armed — nothing is listening yet. */
  | "starting"
  /** ARMED. The only state in which a wake word may fire. */
  | "waiting_for_wake"
  /** A wake fired and the post-wake recording window is open. */
  | "listening"
  /**
   * A BOUNDED FOLLOW-UP WINDOW inside a conversation burst (M12f).
   *
   * Either just about to open or already recording — the same state for
   * both, because from the person's side it is one thing: CareLoop has
   * finished speaking and is waiting for their answer, without them
   * having to say "Hey Nora" again.
   *
   * It is NOT armed. The wake detector stays down for the whole burst;
   * the recorder owns the microphone, bounded by the same endpointing
   * contract every wake turn uses.
   */
  | "listening_for_reply"
  /** The person pressed the microphone button. Nora stands down. */
  | "push_to_talk"
  /** Audio is with the transcriber. */
  | "transcribing"
  /** CareLoop is reading a reply aloud. The wake word must not hear it. */
  | "speaking"
  /** A Nora transcript is in the composer, unresolved by the person. */
  | "draft_ready"
  /** The person's own text is in the composer. Nora does not interrupt it. */
  | "paused_for_typing"
  /**
   * A TRANSCRIPT IS COUNTING DOWN TO SEND ITSELF (M12h).
   *
   * Auto-send gives the person a few seconds to stop it. For those
   * seconds the words are in the composer, which without this state
   * reads as `draft_ready` — "Message ready. Send or clear it to carry
   * on." That sentence becomes false the moment a timer is running:
   * nobody has to send it, and ignoring it will not leave it alone.
   *
   * NOT ARMED, for the same reason `draft_ready` is not: a second wake
   * in the last three seconds would overwrite words already on their
   * way. This is the M12 draft bug with a timer attached.
   */
  | "sending_shortly"
  /** A turn is being sent. */
  | "busy";

export type NoraInputs = {
  /** This build carries an access key and a keyword model. */
  configured: boolean;
  /** The server's answer. `null` before it has been asked. */
  available: boolean | null;
  /** What the person asked for, with the toggle. */
  enabled: boolean;
  /** The engine is starting up. */
  starting: boolean;
  /** The shared recorder, which push-to-talk uses too. */
  recorder: "off" | "recording" | "transcribing";
  /** Whether the recording in flight was started by a wake, not a press. */
  wakeTurn: boolean;
  /**
   * A conversation burst is open (M12f).
   *
   * Set after a voice-originated turn is SENT, cleared by every ending in
   * `chat.tsx`. While it is true the wake detector is never armed: the
   * burst's own bounded window is what listens, and two ways into the
   * microphone at once is the thing this file exists to prevent.
   */
  inBurst: boolean;
  /** Anything at all in the composer, trimmed. */
  composerHasText: boolean;
  /**
   * That text came from a TRANSCRIPT rather than a keyboard — a wake turn
   * or a pressed one, it makes no difference. Both are words CareLoop
   * heard and the person has not yet approved, both stand the wake
   * detector down, and both are worth a Clear button.
   */
  draftFromVoice: boolean;
  /** A chat turn is in flight. */
  sending: boolean;
  /**
   * A reply is being read aloud through the speaker.
   *
   * CareLoop has no barge-in. A wake detector armed while the assistant is
   * talking is a microphone pointed at a loudspeaker playing the words
   * "Hey Nora" would be heard over — and a wake fired by CareLoop's own
   * voice is a turn nobody asked for. Until there is a tested barge-in
   * architecture, speaking and listening are mutually exclusive.
   */
  speaking: boolean;
  /**
   * Seconds left before a transcript sends itself, or null when no
   * countdown is running (M12h).
   *
   * The SHELL owns the timer — this file has no clock and never will. It
   * owns what the countdown means: which state it is, that it outranks a
   * resting draft, and that nothing is armed while it runs.
   */
  countdownSeconds: number | null;
};

/**
 * Precedence is deliberate and reads top to bottom as "what would a person
 * say is going on right now". Reasons the SERVER gave come before reasons the
 * interface invented; a live microphone outranks everything after it; an
 * unresolved draft outranks being idle.
 */
export function noraState(input: NoraInputs): NoraState {
  /**
   * WHAT IS HAPPENING IN THE ROOM COMES FIRST.
   *
   * Recording, transcribing, speaking and sending are true whether or not
   * Nora exists — they are push-to-talk's states too. Checking Nora's
   * configuration before them would report "off" while a microphone was
   * open on a build with no wake word, and the interface would have nothing
   * to say about the thing the person is actually doing.
   *
   * None of these is armed, so moving them above the configuration checks
   * cannot make `wakeIsArmed` true anywhere it was not.
   */
  if (input.recorder === "recording") {
    if (!input.wakeTurn) return "push_to_talk";
    return input.inBurst ? "listening_for_reply" : "listening";
  }
  if (input.recorder === "transcribing") return "transcribing";
  if (input.speaking) return "speaking";
  if (input.sending) return "busy";

  /**
   * A TRANSCRIPT WAITING IS ALSO NOT ABOUT NORA. Words CareLoop heard and
   * the person has not sent yet are a state of the product, on a build
   * with a wake word and on one without — "Message ready" is what a
   * pressed recording leaves behind too.
   *
   * Typed text is different and stays below: on a build with no wake word
   * there is nothing for it to pause, and announcing a pause of something
   * that does not exist is noise.
   */
  /**
   * A COUNTDOWN OUTRANKS THE DRAFT IT IS COUNTING DOWN.
   *
   * Below the recorder and `sending` checks on purpose: those are things
   * happening in the room, and if the shell ever failed to clear a timer
   * when a new recording started, what is actually happening still wins.
   */
  if (typeof input.countdownSeconds === "number") return "sending_shortly";

  if (input.composerHasText && input.draftFromVoice) return "draft_ready";

  if (!input.configured) return "off";
  if (input.available === false) return "unavailable";
  if (!input.enabled) return "off";
  if (input.starting) return "starting";

  // Only their own typing reaches here; a transcript was handled above.
  if (input.composerHasText) return "paused_for_typing";

  /**
   * THE GAP BETWEEN THE REPLY ENDING AND THE MICROPHONE OPENING.
   *
   * Milliseconds, but the person is looking at the screen for exactly
   * these milliseconds. Without this the headline would flash back to
   * "Waiting for Hey Nora" and then to "Listening", which reads as the
   * conversation having dropped them.
   *
   * ABOVE `waiting_for_wake`, so `wakeIsArmed` is false for the whole
   * burst. That is the load-bearing part: the follow-up recorder is about
   * to take the microphone, and a wake detector armed in this window
   * could take it first.
   */
  if (input.inBurst) return "listening_for_reply";

  // Available, enabled, idle, and nothing of the person's is waiting.
  if (input.available === true) return "waiting_for_wake";

  // Enabled but the server has not answered yet. Not armed: an unanswered
  // authority is not a yes.
  return "starting";
}

/**
 * Whether the wake detector may be subscribed to the microphone.
 *
 * Exactly one state. That is the whole point — a second `true` here is the
 * bug this file was written to make impossible.
 */
export function wakeIsArmed(state: NoraState): boolean {
  return state === "waiting_for_wake";
}

/** What the person is told. A CareLoop product state, never a vendor's. */
export function noraStateLabel(state: NoraState): string | null {
  switch (state) {
    case "off":
      return 'Say "Hey Nora" to start a voice turn.';
    case "unavailable":
      return null; // the caller shows the server's reason instead
    case "starting":
      return "Starting Nora…";
    case "waiting_for_wake":
      return 'Nora is listening for "Hey Nora".';
    case "listening":
      return "Listening — stop speaking when you're done.";
    case "listening_for_reply":
      // The HEADLINE already says what state this is. The sentence's job
      // is the thing a person would not guess: they do not have to say
      // the wake word again.
      return "Go ahead — you don't need to say \"Hey Nora\" again.";
    case "push_to_talk":
      return "Recording.";
    case "transcribing":
      return "Working out what you said.";
    case "speaking":
      return "Nora is paused while I'm reading that out.";
    case "draft_ready":
      return "Nora is paused while your message is waiting. Send or clear it to carry on.";
    case "paused_for_typing":
      return "Nora is paused while you have a message waiting.";
    case "sending_shortly":
      // No number here. The headline carries the count; a sentence that
      // also said "three" would be wrong for two of the three seconds.
      return "I'll send this in a moment — press Cancel if you'd rather change it.";
    case "busy":
      return "Sending…";
  }
}

/**
 * THE ONE DOMINANT LINE (M12d).
 *
 * Large, plain, and never more than one at a time. `noraStateLabel` above
 * is the sentence that explains; this is the two or three words a person
 * across the room can read without their glasses on.
 *
 * Nothing here names a wake engine, a transcriber, a provider or a state
 * machine. "Working out what you said" is what transcription is; a person
 * does not need the word.
 */
export function noraStateHeadline(
  state: NoraState,
  /**
   * Seconds left, for the one state that has a number in it. Optional so
   * every other caller is untouched, and null-tolerant because a missing
   * number is a shell bug that must not print "Sending in null…" at
   * somebody.
   */
  countdownSeconds: number | null = null,
): string | null {
  switch (state) {
    case "sending_shortly":
      return countdownSeconds === null
        ? "Sending your message"
        : `Sending in ${countdownSeconds}…`;
    case "waiting_for_wake":
      return 'Waiting for "Hey Nora"';
    case "listening":
      return "Listening";
    case "listening_for_reply":
      return "Listening for your reply";
    case "push_to_talk":
      return "Listening";
    case "transcribing":
      return "Working out what you said";
    case "draft_ready":
      return "Message ready";
    case "busy":
      return "Thinking";
    case "speaking":
      return "Speaking";
    case "paused_for_typing":
      return "Paused while your message is waiting";
    case "unavailable":
      return "Nora unavailable \u2014 microphone still works";
    case "starting":
      return "Starting Nora";
    case "off":
      // Nothing is happening. The panel is not shown at all rather than
      // showing a headline that says so: an empty state announced loudly is
      // still noise.
      return null;
  }
}
