"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Card, CardLabel, QuotedText } from "./ui";
import {
  isRecordingSupported,
  microphoneMessage,
  MicrophoneError,
  NothingHeardError,
  startRecording,
  transcribe,
  type Recording,
} from "./voice";
import {
  speak,
  SpeakError,
  speakMessage,
  stopSpeaking,
  SPEECH_RATES,
  type SpeakRequest,
  type SpeechRate,
} from "./speech";
import {
  fetchNoraStatus,
  msUntilExpiry,
  noraBrowserSupported,
  noraMessage,
  NoraError,
  startNora,
  type NoraSession,
  type NoraStatus,
} from "./nora";
import { startEndpointing, type Endpointer } from "./endpoint";
import { recoveryText } from "./recovery";
import { NORA_MODEL_PATH } from "@/core/nora/config";
import type { NoraUnavailableReason } from "@/core/nora/availability";
import { noraState, noraStateHeadline, noraStateLabel, wakeIsArmed } from "@/core/nora/state";
import { autoSendDecision, AUTO_SEND_COUNTDOWN_SECONDS } from "@/core/nora/autosend";
import { composeOpening } from "@/core/opening/greeting";
import { useLocalHour } from "./local-hour";
import { ENDPOINT_BOUNDS, type EndpointOutcome } from "@/core/voice/endpoint";

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
};

/** Exactly what the server says is on the table. Never inferred from prose. */
export type PendingOffer = {
  opportunityId: string;
  entityName: string;
  /** `offered` is actionable; `sending` is in flight and has no actions. */
  state: "offered" | "sending";
  renderedText: string;
  block: string;
};

/** One line of the chat route's newline-delimited JSON body. */
type TurnEvent =
  | { type: "delta"; text: string }
  | { type: "closure"; sentence: string }
  | {
      type: "offer";
      opportunityId: string;
      entityName: string;
      renderedText: string;
      block: string;
      /** Why the offer appeared, decided by the server. Null when unstated. */
      preamble: string | null;
    }
  | { type: "state"; pendingOffer: PendingOffer | null; messageId?: string | null };

type Status = "idle" | "sending";
/** Where the microphone is, if anywhere. */
type VoiceState = "off" | "recording" | "transcribing";
/** Which consent action is in flight, so only that button shows pending. */
type ConsentPending = "approve" | "decline" | null;

/**
 * The words the buttons submit.
 *
 * The buttons are UX. What reaches the server is the same explicit phrase a
 * person would type, down the same chat endpoint, into the same deterministic
 * consent parser. There is no button-only consent path, no second endpoint and
 * no client-side decision about whether the answer counts - which is what keeps
 * "the client never decides policy" true rather than aspirational.
 */
const APPROVE_PHRASE = "yes";
const DECLINE_PHRASE = "no";

export function Chat(props: {
  initialConversationId: string | null;
  initialMessages: ChatMessage[];
  initialPendingOffer?: PendingOffer | null;
  displayName?: string | null;
  /** Development-only affordances. Never rendered in production. */
  /**
   * The one control the PRODUCT offers here: a public-demo visitor
   * restarting their own demo. Developer controls moved to `/dev` in
   * M12e.3 and are never passed in.
   */
  devTools?: React.ReactNode;
  /**
   * M12d: one bounded proactive opening, decided on the server from an
   * event the person themselves reported. `null` whenever there is nothing
   * genuinely useful to open with, which is most of the time.
   */
  openingLine?: string | null;
}) {
  const [conversationId, setConversationId] = useState(props.initialConversationId);
  const [messages, setMessages] = useState<ChatMessage[]>(props.initialMessages);
  const [offer, setOffer] = useState<PendingOffer | null>(props.initialPendingOffer ?? null);
  const [closure, setClosure] = useState<{ id: string; sentence: string } | null>(null);
  const [input, setInput] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [consentPending, setConsentPending] = useState<ConsentPending>(null);
  const [error, setError] = useState<string | null>(null);
  const [voice, setVoice] = useState<VoiceState>("off");
  const [voiceNote, setVoiceNote] = useState<string | null>(null);
  /**
   * Audio is only ever played to someone who has used the microphone this
   * session. A typed-chat user must never suddenly hear a voice, and nothing
   * plays on page load.
   */
  const [voiceModeOn, setVoiceModeOn] = useState(false);
  /**
   * The opening is shown at most once per browser session.
   *
   * Deliberately `sessionStorage` and not a database column: this is a
   * greeting, the worst case of losing the flag is seeing it twice, and a
   * write on page load for a pleasantry is not a trade worth making.
   *
   * Read once during render and written in an effect, so nothing here sets
   * state from an effect just to learn something the browser already knows.
   */
  const openingSeenRef = useRef(false);
  const openingReadRef = useRef(false);
  if (!openingReadRef.current && typeof window !== "undefined") {
    openingReadRef.current = true;
    try {
      openingSeenRef.current =
        window.sessionStorage.getItem("careloop.opening") === (props.openingLine ?? "");
    } catch {
      openingSeenRef.current = false;
    }
  }
  const [openingDismissed, setOpeningDismissed] = useState(false);
  useEffect(() => {
    try {
      // Keyed on the MEMORY line, not on the composed sentence: the
      // greeting changes when the hour rolls over, and an opening that
      // reappeared at five past five would be a new bug (M12f).
      window.sessionStorage.setItem("careloop.opening", props.openingLine ?? "");
    } catch {
      // Private mode, blocked storage. Showing it again is the failure, and
      // it is a small one.
    }
  }, [props.openingLine]);
  const [speaking, setSpeaking] = useState(false);
  /**
   * A CONVERSATION BURST (M12f).
   *
   * True from the moment a VOICE-ORIGINATED turn is sent until the burst
   * ends. While it is true, the reply finishing opens ONE bounded
   * follow-up window so the person can answer without saying "Hey Nora"
   * again.
   *
   * This is not continuous listening and the microphone is not held open
   * between turns: each window is a fresh recording under the same
   * endpointing contract as a wake turn — speech-start timeout, silence
   * finalisation, maximum duration — and the burst ends the moment one of
   * them hears nothing.
   *
   * A ref beside the state because `endBurst` is called from callbacks
   * that must not re-create themselves every render.
   */
  const [inBurst, setInBurst] = useState(false);
  const inBurstRef = useRef(false);
  /**
   * ENDING A BURST ALSO CLOSES ITS MICROPHONE.
   *
   * Every ending routes through here — the toggle, typing, silence, a
   * failure, the End button, unmount — so the release lives in one place
   * rather than being remembered at six call sites. It reads the REFS
   * rather than rendered state: a burst can end in the same tick the
   * recorder opens, and a handler that checked `voice` would be reading a
   * value one render behind the microphone.
   *
   * Idempotent. Callers that also cancel (the no-speech path, teardown)
   * are not a bug; leaving a stream open once is.
   */
  const cancelBurstRecordingRef = useRef<() => void>(() => {});
  const endBurst = useCallback(() => {
    inBurstRef.current = false;
    setInBurst(false);
    cancelBurstRecordingRef.current();
    // Leaving the voice session leaves the countdown with it (M12h).
    // Somebody who has just closed the microphone has not asked for one
    // more message to go out three seconds later.
    cancelCountdownRef.current();
    // The watchdog exists to end this burst. Once it has ended, by any
    // route, there is nothing left for it to do.
    if (burstWatchdogRef.current !== null) {
      clearTimeout(burstWatchdogRef.current);
      burstWatchdogRef.current = null;
    }
  }, []);
  const endBurstRef = useRef(endBurst);
  endBurstRef.current = endBurst;
  const startBurst = useCallback(() => {
    inBurstRef.current = true;
    setInBurst(true);
  }, []);
  /** One follow-up per reply: reset when a burst turn is sent. */
  const followUpOpenedRef = useRef(false);
  /**
   * How fast replies are read out (M12d). Remembered per browser, because
   * somebody who needs it slower needs it slower every time. It changes
   * the PLAYBACK of bytes the server already authorized — nothing is
   * re-synthesized and nothing about the words changes.
   */
  const [speechRate, setSpeechRate] = useState<SpeechRate>("normal");
  const speechRateRef = useRef<SpeechRate>("normal");
  const rateReadRef = useRef(false);
  if (!rateReadRef.current && typeof window !== "undefined") {
    rateReadRef.current = true;
    try {
      if (window.localStorage.getItem("careloop.speech-rate") === "slower") {
        speechRateRef.current = "slower";
      }
    } catch {
      /* private mode: the default speed is a perfectly good default */
    }
  }
  useEffect(() => {
    setSpeechRate(speechRateRef.current);
  }, []);
  const recordingRef = useRef<Recording | null>(null);

  /**
   * THE AUTO-SEND COUNTDOWN (M12h).
   *
   * Seconds remaining, or null when nothing is counting. A spoken sentence
   * sends itself after `AUTO_SEND_COUNTDOWN_SECONDS`; `core/nora/autosend.ts`
   * decides whether it may, and this is the window in which the person can
   * say no.
   *
   * The timer lives in a ref and the number in state, because those are two
   * different things: one is a resource to release, the other is something
   * to render. Every path that releases the timer goes through
   * `cancelCountdownRef`, so there is exactly one place that can leave one
   * running.
   */
  const [countdown, setCountdown] = useState<number | null>(null);
  const countdownTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const cancelCountdownRef = useRef<() => void>(() => {});
  const startCountdownRef = useRef<(text: string) => void>(() => {});
  /**
   * The current offer and the current `send`, mirrored for the timer to
   * read WHEN IT FIRES rather than when it was scheduled.
   *
   * Assigned during render, like `cancelBurstRecordingRef` above. A timer
   * that closed over either would be acting on a three-second-old picture
   * of the page.
   */
  const offerRef = useRef<PendingOffer | null>(null);
  const sendRef = useRef<(text: string) => void>(() => {});

  /**
   * NORA — the optional wake word.
   *
   * Off by default, on every load. `noraOn` is what the person asked for;
   * `noraStatus` is what the SERVER allows, and the two are kept apart on
   * purpose: a remembered preference is not a permission. Nothing listens
   * unless both agree, which is what makes a tab left open across the cutoff
   * — or a `localStorage` flag from last week — harmless.
   */
  const [noraOn, setNoraOn] = useState(false);
  const [noraStarting, setNoraStarting] = useState(false);
  const [noraStatus, setNoraStatus] = useState<NoraStatus | null>(null);
  const [noraNote, setNoraNote] = useState<string | null>(null);
  const noraRef = useRef<NoraSession | null>(null);
  const onWakeRef = useRef<() => void>(() => {});
  const onEndpointRef = useRef<(outcome: EndpointOutcome) => void>(() => {});
  /** The end-of-turn watcher, alive only while a post-wake recording is. */
  const endpointerRef = useRef<Endpointer | null>(null);
  /**
   * THE APPLICATION'S OWN BOUND ON AN OPEN WAKE TURN (M12i).
   *
   * The watcher is an optimisation. This is the promise. `startEndpointing`
   * returns null on a browser with no Web Audio, on an audio graph that
   * will not construct, or on a stream with no usable track — and the
   * recorder swallows an observer's exceptions on purpose, because a
   * convenience must never fail a recording. Both are right. What was
   * wrong is that the interface says "Listening for your reply" and
   * promises a bounded window, and only the watcher was keeping it.
   *
   * Cleared by the same `dropEndpointer` every teardown already calls, and
   * it ends the turn through the SAME `onEndpointRef` path a real decision
   * takes — never a second re-arm path.
   */
  const backstopRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * AND A BOUND ON THE BURST ITSELF (M12j).
   *
   * Recorded on the deployment: the reply finished, "Listening for your
   * reply" appeared, and the composer kept its plain microphone icon
   * instead of the Stop control. Twenty-four seconds like that, until
   * "End voice session" was pressed — after which "Hey Nora" worked at
   * once.
   *
   * The recorder never opened. `beginRecording` awaits `getUserMedia`,
   * and if the follow-up effect re-runs inside that gap its cleanup sets
   * `cancelled`, so the abort check releases the microphone and returns
   * silently: burst live, `followUpOpenedRef` true so nothing retries,
   * wake detector paused because a burst is never armed.
   *
   * The backstop above cannot help, because it is armed AFTER the
   * microphone opens — the thing that never happened. So the bound has to
   * belong to the burst: armed when a window is committed to, cleared
   * when a recording actually opens, and otherwise it ends the burst.
   */
  const burstWatchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * Whether the recording in flight was started by a wake or by a press.
   * A ref AND a state: callbacks read the ref, the state machine reads the
   * state. Keeping them in step in one setter beats a stale closure deciding
   * whether to tear a microphone down.
   */
  const wakeTurnRef = useRef(false);
  const [wakeTurn, setWakeTurn] = useState(false);
  const markWakeTurn = useCallback((value: boolean) => {
    wakeTurnRef.current = value;
    setWakeTurn(value);
  }, []);
  /**
   * Whether what is in the composer came from a TRANSCRIPT.
   *
   * A ref, derived at render, rather than state kept in step by an effect:
   * the one fact it depends on is whether the composer is empty, and that
   * is already on screen. Editing a transcript keeps the flag — an edited
   * draft is still a draft, and the person keeps the Clear button.
   */
  const draftFromVoiceRef = useRef(false);
  /** The arming decision last applied to the engine, so it is applied once. */
  const appliedArmRef = useRef<boolean | null>(null);
  const armedRef = useRef(false);
  /**
   * Forward reference to the teardown, which is defined below the recorder
   * that needs to call it. A ref rather than a reorder: the recorder's
   * callbacks are the ones that must never capture a stale anything.
   */
  const teardownNoraRef = useRef<() => Promise<void>>(async () => {});

  const endRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const micSupported = useRef(false);
  useEffect(() => {
    micSupported.current = isRecordingSupported();
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, offer, closure]);

  const readAloud = useCallback(async (request: SpeakRequest) => {
    setSpeaking(true);
    const done = () => setSpeaking(false);
    try {
      // Resolves when playback BEGINS; `onEnded` is the moment it stops, which
      // is when the Stop control retires and listening may resume.
      await speak(request, { onEnded: done, rate: SPEECH_RATES[speechRateRef.current] });
    } catch (error) {
      // Never fatal: the words are already on screen.
      setVoiceNote(
        error instanceof SpeakError ? speakMessage(error.reason) : recoveryText("speech_failed"),
      );
      done();
    }
  }, []);

  const send = useCallback(
    async (rawText: string, consent: ConsentPending = null) => {
      const text = rawText.trim();
      if (!text || status === "sending") return;

      // A manual Send during a countdown is the person getting there first.
      // Without this the timer would fire into an already-sent turn.
      cancelCountdownRef.current();

      setError(null);
      setOpeningDismissed(true);
      setStatus("sending");
      setConsentPending(consent);
      /**
       * A BURST BEGINS WHEN VOICE WORDS ARE SENT (M12f).
       *
       * Read before the composer is cleared, because clearing resolves
       * `draftFromVoice`. Only a VOICE-originated turn opens one: somebody
       * typing has not asked for a microphone, and must never be handed
       * one because the reply happened to be read aloud.
       *
       * Sending is still explicit, here and for every follow-up. The burst
       * changes who has to say "Hey Nora"; it changes nothing about who
       * presses Send.
       */
      if (consent === null && draftFromVoiceRef.current) {
        startBurst();
        followUpOpenedRef.current = false;
      }
      if (consent === null) setInput("");

      const stamp = Date.now();
      const draftId = `local-assistant-${stamp}`;
      setMessages((prev) => [
        ...prev,
        { id: `local-user-${stamp}`, role: "user", content: text },
      ]);

      try {
        const response = await fetch("/api/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ conversationId: conversationId ?? undefined, text }),
        });

        if (!response.ok || !response.body) {
          throw new Error(`request_failed_${response.status}`);
        }

        const returnedId = response.headers.get("X-Conversation-Id");
        if (returnedId) setConversationId(returnedId);

        setMessages((prev) => [...prev, { id: draftId, role: "assistant", content: "" }]);

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        // What gets read aloud is named, not carried: the id of the assistant
        // message the server persisted for this turn. The browser cannot
        // choose the words, only point at the turn it just displayed.
        let spokenMessageId: string | null = null;

        const handle = (event: TurnEvent) => {
          if (event.type === "delta") {
            setMessages((prev) =>
              prev.map((m) => (m.id === draftId ? { ...m, content: m.content + event.text } : m)),
            );
            return;
          }
          if (event.type === "closure") {
            setClosure({ id: draftId, sentence: event.sentence });
            return;
          }
          if (event.type === "offer") {
            /**
             * WHY the offer appeared, if the server said. It is appended to
             * the bubble rather than drawn on the card, so that the live turn
             * and the persisted message - reply, reason, block - end up
             * reading the same way. The sentence is the server's; nothing
             * here composes or edits it.
             */
            if (event.preamble !== null) {
              const reason = event.preamble;
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === draftId ? { ...m, content: `${m.content}\n\n${reason}` } : m,
                ),
              );
            }
            // An offer arrived as FIELDS. The exact bytes come from the
            // server; nothing here rebuilds or reformats them.
            setOffer({
              opportunityId: event.opportunityId,
              entityName: event.entityName,
              state: "offered",
              renderedText: event.renderedText,
              block: event.block,
            });
            return;
          }
          // The turn's closing word on what the reconnect looks like now -
          // including null, which retires the card. The client holds no
          // terminal state of its own, so it cannot keep showing one that has
          // stopped being true.
          setOffer(event.pendingOffer);
          spokenMessageId = event.messageId ?? null;
        };

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let newline = buffer.indexOf("\n");
          while (newline !== -1) {
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            if (line.length > 0) handle(JSON.parse(line) as TurnEvent);
            newline = buffer.indexOf("\n");
          }
        }
        const tail = buffer.trim();
        if (tail.length > 0) handle(JSON.parse(tail) as TurnEvent);

        // Read the reply aloud only if this person is using voice. What is
        // spoken is whatever the server persisted as this assistant turn -
        // the closure sentence, the model's words and the offer block, exactly
        // as they were written and shown.
        const turnConversationId = returnedId ?? conversationId;
        if (voiceModeOn && spokenMessageId && turnConversationId) {
          void readAloud({
            conversationId: turnConversationId,
            source: { type: "assistant_message", id: spokenMessageId },
          });
        }

      } catch {
        // The assistant turn was never persisted server-side, so showing a
        // partial bubble would be a lie that vanishes on refresh. Drop it.
        setMessages((prev) => prev.filter((m) => m.id !== draftId));
        setError(recoveryText("chat_failed"));
      } finally {
        setStatus("idle");
        setConsentPending(null);
      }
    },
    [conversationId, status, voiceModeOn, readAloud, startBurst],
  );

  /** Releases the end-of-turn watcher. Safe from anywhere, any number of times. */
  const dropEndpointer = useCallback(() => {
    endpointerRef.current?.stop();
    endpointerRef.current = null;
    // The backstop belongs to the same turn as the watcher, so it is
    // released by the same call every teardown already makes.
    if (backstopRef.current !== null) {
      clearTimeout(backstopRef.current);
      backstopRef.current = null;
    }
  }, []);

  /**
   * Stops a countdown, whoever stopped it and for whatever reason.
   *
   * Idempotent, and safe to call when nothing is running — which is why
   * every cancellation path can call it without first asking whether there
   * is anything to cancel.
   */
  const cancelCountdown = useCallback(() => {
    if (countdownTimerRef.current !== null) {
      clearInterval(countdownTimerRef.current);
      countdownTimerRef.current = null;
    }
    setCountdown(null);
  }, []);
  cancelCountdownRef.current = cancelCountdown;
  // Mirrors, assigned every render, so the timer reads the page as it is
  // when it fires rather than as it was when it was scheduled.
  offerRef.current = offer;
  sendRef.current = (text: string) => void send(text);

  /** Releases a running countdown when the page goes away. */
  useEffect(() => cancelCountdown, [cancelCountdown]);

  /**
   * Ends a recording and throws the audio away.
   *
   * The no-speech path. Nothing is transcribed, nothing reaches the
   * composer, and nothing the person had already written is touched — a
   * wake that heard silence must cost them nothing at all.
   */
  const cancelRecording = useCallback(
    (note: string | null) => {
      cancelCountdownRef.current();
      dropEndpointer();
      const recording = recordingRef.current;
      recordingRef.current = null;
      recording?.cancel();
      if (note !== null) setVoiceNote(note);
      setVoice("off");
      markWakeTurn(false);
    },
    [dropEndpointer, markWakeTurn],
  );

  /**
   * Abandon a burst's own recording, if one is open. A PRESSED recording
   * is left alone: the person started that themselves and is holding the
   * Stop button's attention.
   */
  cancelBurstRecordingRef.current = () => {
    if (recordingRef.current !== null && wakeTurnRef.current) cancelRecording(null);
  };

  const finishRecording = useCallback(async () => {
    const recording = recordingRef.current;
    if (!recording) return;
    recordingRef.current = null;
    // Before anything awaits: the turn is over, so the watcher is over. On
    // the automatic path it has already stopped itself; on the Stop-button
    // path this is the only thing that will.
    dropEndpointer();
    const wasWake = wakeTurnRef.current;
    setVoice("transcribing");

    try {
      const audio = await recording.stop();
      const text = await transcribe(audio);
      // Into the composer, NOT straight down the wire. The person reads what
      // was heard before it becomes a message - a mishearing that turns
      // itself into an irreversible action is the failure this prevents.
      setInput(text);
      // The composer now holds something the person has not resolved. Until
      // they do, the wake detector stays down — see core/nora/state.ts.
      // Any transcript, not only a wake one: a pressed recording also
      // leaves words CareLoop heard rather than words they typed.
      draftFromVoiceRef.current = true;
      composerRef.current?.focus();

      /**
       * AND THEN IT MAY SEND ITSELF (M12h).
       *
       * The composer is still filled first, and the focus still moves
       * there: the countdown is an offer to save the person a button, not
       * a refusal to let them have one. Editing a word cancels it, which
       * is why the words have to be there to edit.
       *
       * The rule is in `core/nora/autosend.ts` — no offer on the table, a
       * transcript long enough to trust, and a wake turn rather than a
       * press.
       */
      const decision = autoSendDecision({
        text,
        offerPending: offerRef.current !== null,
        wakeTurn: wasWake,
      });
      if (decision.send) startCountdownRef.current(text);
    } catch (error) {
      // Two different apologies, because they are two different situations.
      // "I didn't catch that" tells the person to speak again; it must not be
      // said when the recording itself was the problem, or we blame their
      // voice for our bug. Either way nothing is sent and nothing is lost.
      // Nothing heard, or the recording failed. Either way the burst stops
      // rather than opening another window at somebody who has just been
      // told CareLoop did not catch them (M12f).
      endBurstRef.current();
      setVoiceNote(
        error instanceof NothingHeardError
          ? recoveryText("no_speech")
          : recoveryText("transcription_failed"),
      );
    } finally {
      setVoice("off");
      markWakeTurn(false);
      /**
       * NOTHING RE-ARMS HERE, ON PURPOSE.
       *
       * This is where the browser bug lived: the turn finished, this line
       * re-armed the wake detector, and "good morning" sat in the composer
       * with a live wake word able to overwrite it. Arming is now a
       * CONSEQUENCE of state rather than a call — the effect below matches
       * the engine to `wakeIsArmed(...)`, which cannot be true while the
       * composer holds anything. Deleting the call is the fix; the state
       * machine is what makes the deletion safe.
       */
    }
  }, [dropEndpointer, markWakeTurn]);

  /**
   * Starts the countdown, and fires the send at the end of it.
   *
   * The tick and the send both happen in the INTERVAL CALLBACK rather than
   * in an effect keyed on the number. An effect that set state on its own
   * output would be the cascade that produced the stuck follow-up window
   * in M12g, and `react-hooks/set-state-in-effect` is right to refuse it.
   *
   * `left` is a local, so the interval does not depend on reading back the
   * state it just set.
   */
  const startCountdown = useCallback(
    (text: string) => {
      cancelCountdownRef.current();
      let left = AUTO_SEND_COUNTDOWN_SECONDS;
      setCountdown(left);
      countdownTimerRef.current = setInterval(() => {
        left -= 1;
        if (left > 0) {
          setCountdown(left);
          return;
        }
        cancelCountdownRef.current();
        /**
         * CHECKED AGAIN, AT THE MOMENT IT MATTERS.
         *
         * Three seconds is long enough for the page to have changed. If a
         * card asking to message somebody's family is on screen now, this
         * is not a turn that may send itself, whatever was true when the
         * timer started. Defence in depth: the server refuses an answer to
         * a card nobody was shown (M12g), and this refuses to send one
         * unasked.
         */
        if (offerRef.current !== null) {
          composerRef.current?.focus();
          return;
        }
        sendRef.current(text);
      }, 1000);
    },
    [],
  );
  startCountdownRef.current = startCountdown;

  /**
   * Arms the application's bound on the turn that has just opened (M12i).
   *
   * Deliberately NOT a decision-maker: everything it concludes is routed
   * through `onEndpointRef`, the one path a real watcher decision takes,
   * so there is still exactly one way a wake turn ends and exactly one
   * thing that re-arms the engine — the state machine.
   */
  const armBackstop = useCallback(() => {
    if (backstopRef.current !== null) clearTimeout(backstopRef.current);

    const finish = (outcome: EndpointOutcome) => {
      backstopRef.current = null;
      // Nothing to end. A watcher decision, a Stop press or a teardown got
      // here first, and each of those already cleared this timer.
      if (recordingRef.current === null) return;
      onEndpointRef.current(outcome);
    };

    backstopRef.current = setTimeout(() => {
      const heard = endpointerRef.current?.inspect().speechStarted ?? false;
      if (!heard) {
        // Silent, or deaf. Either way the window is over, and the person
        // sees the same "I didn't catch that" a watcher would have given
        // them — which is true in both cases.
        finish("no_speech");
        return;
      }
      // Somebody is talking. The watcher owns this turn now, and the only
      // thing left to guarantee is that it cannot run forever.
      backstopRef.current = setTimeout(
        () => finish("max_duration"),
        ENDPOINT_BOUNDS.maxTurnMs - ENDPOINT_BOUNDS.speechStartTimeoutMs,
      );
    }, ENDPOINT_BOUNDS.speechStartTimeoutMs + ENDPOINT_BOUNDS.backstopGraceMs);
  }, []);
  const armBackstopRef = useRef(armBackstop);
  armBackstopRef.current = armBackstop;

  /**
   * Arms the bound on the BURST, from the moment a window is committed to
   * (M12j).
   *
   * This is the one that answers the screen recording. It does not care
   * why no microphone arrived — an aborted open, a permission dialog
   * nobody answered, a `getUserMedia` that never settles — only that the
   * page must not go on saying "Listening for your reply" with nothing
   * behind it. If a recording is open by the deadline, the backstop above
   * owns the turn and this has already been cleared.
   */
  const armBurstWatchdog = useCallback(() => {
    /**
     * Armed once per burst, never extended. A retried window must not be
     * able to push the deadline out in front of itself — the bound is on
     * the BURST, and the whole point is that it cannot be outrun.
     */
    if (burstWatchdogRef.current !== null) return;
    burstWatchdogRef.current = setTimeout(() => {
      burstWatchdogRef.current = null;
      if (!inBurstRef.current) return;
      if (recordingRef.current !== null) return;
      // Silently: nothing was heard because nothing was ever listening,
      // and an apology for a failure the person did not cause and cannot
      // see would only confuse them. The burst ends, the state machine
      // re-arms the wake word, and the page says so.
      endBurstRef.current();
    }, ENDPOINT_BOUNDS.speechStartTimeoutMs + ENDPOINT_BOUNDS.backstopGraceMs);
  }, []);
  const armBurstWatchdogRef = useRef(armBurstWatchdog);
  armBurstWatchdogRef.current = armBurstWatchdog;

  const beginRecording = useCallback(
    async (
      source: "press" | "wake" = "press",
      /**
       * Checked once, AFTER the microphone has actually opened (M12f).
       *
       * `startRecording` awaits a permission prompt and a MediaRecorder,
       * and a person can press "End voice session" inside that gap. Without
       * this the recorder would open into a burst that no longer exists:
       * the state machine would say "Listening", nothing would ever stop
       * it, and the microphone would stay live. Found by a flaky test,
       * which is the honest way to find a race.
       */
      shouldAbort?: () => boolean,
    ) => {
    // A new recording supersedes whatever was about to send itself.
    cancelCountdownRef.current();
    setError(null);
    setVoiceNote(null);
    stopSpeaking();
    markWakeTurn(source === "wake");
    try {
      recordingRef.current = await startRecording({
        // The recorder has a ceiling, and a ceiling that fires while the
        // screen still says "Listening…" is the interface lying about a
        // microphone. The handle has already released it by the time this
        // runs; all that is left is to finish the turn the way the person
        // would have - transcribe, show the words, and wait for Send.
        onLimitReached: () => {
          setVoiceNote(recoveryText("recording_limit"));
          void finishRecording();
        },
        /**
         * AUTOMATIC END OF TURN, AND ONLY AFTER A WAKE.
         *
         * Push-to-talk is untouched: no observer is attached, the person
         * presses Stop exactly as they always have. A wake turn has nobody
         * to press anything, which is the entire point of a wake word, so
         * that one gets a watcher — bounded, attached to this recording's
         * own stream, and released the moment the turn ends.
         */
        onStream:
          source === "wake"
            ? (stream) => {
                endpointerRef.current = startEndpointing({
                  stream,
                  onDecision: (outcome) => {
                    // The watcher has already stopped itself by now.
                    endpointerRef.current = null;
                    onEndpointRef.current(outcome);
                  },
                });
              }
            : undefined,
      });
      if (shouldAbort?.()) {
        // The window closed while it was opening. Release everything and
        // leave no trace — no state, no note, no open stream.
        dropEndpointer();
        const opened = recordingRef.current;
        recordingRef.current = null;
        opened?.cancel();
        markWakeTurn(false);
        /**
         * NOTHING IS RESET HERE, AND THAT IS DELIBERATE (M12j).
         *
         * An earlier draft of this fix cleared `followUpOpenedRef` so a
         * cancelled window could be retried. It was removed because no
         * reachable trigger for it could be constructed: the only
         * dependency of the follow-up effect that can change while the
         * microphone is opening is the composer's contents, and typing
         * already ends the burst by design. Speculative recovery for a
         * path nothing can reach is code that cannot be tested and will
         * not be maintained. The burst watchdog bounds this case either
         * way.
         */
        return;
      }
      /**
       * THE WINDOW IS NOW BOUNDED BY THE APPLICATION (M12i).
       *
       * Armed after the abort check, so a window that closed while the
       * microphone was opening never leaves a timer behind, and only for
       * a wake turn: push-to-talk is bounded by the person's own hand on
       * Stop, and by the recorder's ceiling behind that.
       *
       * The burst watchdog is released in the same breath — a microphone
       * did arrive, which is the only thing it was waiting for.
       */
      if (source === "wake") {
        if (burstWatchdogRef.current !== null) {
          clearTimeout(burstWatchdogRef.current);
          burstWatchdogRef.current = null;
        }
        armBackstopRef.current();
      }

      // From here on this person hears replies. Nothing plays before they
      // have asked for voice at least once.
      setVoiceModeOn(true);
      setVoice("recording");
    } catch (error) {
      dropEndpointer();
      endBurstRef.current();
      setVoiceNote(
        error instanceof MicrophoneError
          ? microphoneMessage(error.reason)
          : microphoneMessage("failed"),
      );
      setVoice("off");
      // A wake turn that cannot open the microphone means the wake engine
      // has lost it too. Nora comes down; typing and the button are
      // unaffected and say so themselves.
      if (source === "wake") {
        markWakeTurn(false);
        void teardownNoraRef.current();
      }
    }
    },
    [finishRecording, dropEndpointer, markWakeTurn],
  );

  /* ---------------------------------------------------------------- */
  /* Nora — the optional wake word                                     */
  /* ---------------------------------------------------------------- */

  /**
   * THE ONE ENDING. Every path that stops Nora comes through here: the
   * person's toggle, an unmount, the cutoff passing, an engine failure, a
   * revalidation that comes back unavailable. `stop()` is itself idempotent,
   * so calling this twice is not a bug — leaving a listener behind once is.
   */
  const teardownNora = useCallback(async () => {
    cancelCountdownRef.current();
    // The burst goes with the engine. Toggling Nora off, the cutoff
    // passing, an engine failure and a revalidation that comes back
    // unavailable all arrive here, and none of them may leave a follow-up
    // window queued behind them (M12f).
    endBurstRef.current();
    // The watcher first: it is the only thing holding an audio graph, and it
    // must not outlive the engine that justified opening one.
    dropEndpointer();
    // A wake turn in flight is abandoned rather than transcribed. Whatever
    // is already in the composer is left exactly as it is — turning Nora off
    // must never cost somebody words they had written or already dictated.
    if (wakeTurnRef.current && recordingRef.current !== null) {
      const recording = recordingRef.current;
      recordingRef.current = null;
      recording.cancel();
      setVoice("off");
    }
    markWakeTurn(false);
    appliedArmRef.current = null;
    const session = noraRef.current;
    noraRef.current = null;
    setNoraOn(false);
    setNoraStarting(false);
    if (session) await session.stop();
  }, [dropEndpointer, markWakeTurn]);

  useEffect(() => {
    teardownNoraRef.current = teardownNora;
  }, [teardownNora]);

  /**
   * Whether this BUILD carries what Nora needs.
   *
   * Not an eligibility check — the server owns that, and this cannot make
   * Nora available. It answers a smaller question: is there any point
   * asking. A deployment with no Picovoice configuration never fetches the
   * status, never renders the control, and is byte-identical to CareLoop
   * before Nora existed, which is also what every deployment becomes again
   * once the keys are removed after the cutoff.
   */
  const noraPossible =
    (process.env.NEXT_PUBLIC_PICOVOICE_ACCESS_KEY ?? "").trim().length > 0 &&
    (process.env.NEXT_PUBLIC_NORA_KEYWORD_PATH ?? "").trim().length > 0;

  /** The toggle turning ON. Server first, credentials second, engine last. */
  const enableNora = useCallback(async () => {
    setNoraNote(null);
    setNoraStarting(true);

    // 1. THE SERVER DECIDES. Asked every time, not read from the value
    //    fetched on load: the answer can have changed since, and this is the
    //    moment a microphone is about to open.
    const status = await fetchNoraStatus();
    setNoraStatus(status);
    if (!status.available) {
      setNoraStarting(false);
      setNoraOn(false);
      setNoraNote(noraMessage(status.reason ?? "initialization_failed"));
      return;
    }

    const accessKey = process.env.NEXT_PUBLIC_PICOVOICE_ACCESS_KEY ?? "";
    const keywordPath = process.env.NEXT_PUBLIC_NORA_KEYWORD_PATH ?? "";
    if (accessKey.length === 0 || keywordPath.length === 0) {
      // The server said configured and the bundle disagrees. Say the same
      // thing either way; a person cannot act on which half is missing.
      setNoraStarting(false);
      setNoraOn(false);
      setNoraNote(noraMessage("not_configured"));
      return;
    }

    try {
      // 2. Only after a successful start is Nora "on". A half-built engine
      //    tears itself down inside startNora and throws; nothing here has
      //    to remember to clean up after it.
      const session = await startNora({
        accessKey,
        keywordPath,
        modelPath: NORA_MODEL_PATH,
        onWake: () => onWakeRef.current(),
        onFailure: (reason: NoraUnavailableReason) => {
          noraRef.current = null;
          setNoraOn(false);
          setNoraNote(noraMessage(reason));
        },
      });
      noraRef.current = session;
      // `startNora` subscribed, so the engine is already armed and the
      // effect below must not immediately re-ask the server for permission
      // it has just been given.
      appliedArmRef.current = true;
      setNoraOn(true);
    } catch (error) {
      setNoraOn(false);
      setNoraNote(noraMessage(error instanceof NoraError ? error.reason : "initialization_failed"));
    } finally {
      setNoraStarting(false);
    }
  }, []);

  const rememberNora = (value: "on" | "off") => {
    try {
      window.localStorage.setItem("careloop.nora", value);
    } catch {
      // Private mode, blocked storage. A convenience, never load-bearing:
      // the preference is not the permission, and losing it costs one click.
    }
  };

  const toggleNora = useCallback(() => {
    if (noraOn || noraRef.current !== null) {
      rememberNora("off");
      void teardownNora();
      return;
    }
    rememberNora("on");
    void enableNora();
  }, [noraOn, enableNora, teardownNora]);

  /**
   * What the end-of-turn watcher decided.
   *
   * Three outcomes, three different things to do, and none of them sends
   * anything:
   *
   *   speech_ended  - the ordinary path. Transcribe and show the words.
   *   max_duration  - the ceiling. Transcribe anyway: discarding a long
   *                   answer because it was long is the rudest failure
   *                   available, and the person can still edit or clear it.
   *   no_speech     - a wake with nothing after it. Throw the audio away
   *                   rather than submit an empty or nonsense transcript,
   *                   and say so plainly so the wake does not look broken.
   */
  useEffect(() => {
    onEndpointRef.current = (outcome) => {
      if (outcome === "no_speech") {
        // Silence is how a conversation ends. The burst closes and the
        // page goes back to waiting for "Hey Nora" (M12f).
        endBurstRef.current();
        cancelRecording(recoveryText("wake_heard_nothing"));
        return;
      }
      if (outcome === "max_duration") {
        setVoiceNote(recoveryText("listening_limit"));
      }
      void finishRecording();
    };
  }, [finishRecording, cancelRecording]);

  /**
   * The wake, as a turn.
   *
   * Wake detection PAUSES for the duration: two microphone streams at once
   * is wasteful, and — worse — a recording that contains the word "Nora"
   * would re-trigger the thing recording it.
   *
   * What it does NOT do is send anything. The transcript lands in the
   * composer as editable text and the person presses Send, exactly as
   * push-to-talk already works. A wake word may save a press; it may not
   * turn a mishearing into an irreversible family action.
   */
  useEffect(() => {
    onWakeRef.current = () => {
      void (async () => {
        // Belt and braces. The effect below should already have stood the
        // detector down in every state but this one; a wake that arrives
        // anyway - a frame already in flight when the state changed - is
        // dropped rather than allowed to open a microphone over a draft.
        if (!armedRef.current) return;
        await noraRef.current?.pause();
        appliedArmRef.current = false;
        await beginRecording("wake");
      })();
    };
  }, [beginRecording]);

  /** The whole session is released when this component goes away. */
  useEffect(() => {
    return () => {
      endBurstRef.current();
      endpointerRef.current?.stop();
      endpointerRef.current = null;
      const session = noraRef.current;
      noraRef.current = null;
      void session?.stop();
    };
  }, []);

  /**
   * THE PAGE LEFT OPEN ACROSS THE CUTOFF.
   *
   * A timer, so the interface changes at the moment it should rather than at
   * the next reload. It is presentation only — the authority is still the
   * server, which is asked again before every re-arm — but a person watching
   * a "Nora is listening" label tick past the end date would be watching a
   * false statement, and the listener behind it would be real.
   */
  useEffect(() => {
    if (!noraOn || noraStatus === null) return;
    const delay = msUntilExpiry(noraStatus.availableUntil, new Date());
    if (delay === null) return;
    const timer = setTimeout(() => {
      void teardownNora();
      setNoraNote(noraMessage("expired"));
    }, delay);
    return () => clearTimeout(timer);
  }, [noraOn, noraStatus, teardownNora]);

  /**
   * What the server says, on load. Fetched even when Nora is off, because it
   * is what decides whether the control may be offered at all.
   *
   * ON BY DEFAULT (M12h). Nora arms itself unless somebody turned it off.
   *
   * It shipped off-by-default because it was an experiment, and an
   * experiment that opens a microphone should be asked for. It is not an
   * experiment now, and the person it is for may never find a toggle: a
   * hands-free companion that has to be switched on by hand every visit
   * is a hands-free companion nobody uses.
   *
   * WHAT DID NOT CHANGE IS WHO DECIDES. The server is still asked here, on
   * every load, and its refusal still ends it. The browser still decides
   * about the microphone, and a refusal there is a normal answer. The
   * toggle is still there and is still remembered. "On by default" is the
   * answer to a question nobody answered — never an override of somebody
   * who did.
   *
   * THE PERMISSION QUERY IS GONE, deliberately. It was here so that
   * restoring a preference could not make a prompt appear at somebody who
   * had just opened a page — but a prompt is now exactly what should
   * happen on a first visit, because the alternative is a wake word that
   * silently does nothing until the person discovers a control. It also
   * closes P4: Safari does not implement the `microphone` permission
   * descriptor, so the query threw there and the preference never
   * restored. We stop asking a question one browser cannot answer.
   *
   * A FAILED AUTO-ARM IS NOT WRITTEN DOWN. Declining the prompt leaves the
   * toggle off with the note explaining it, and nothing in storage — so
   * granting the microphone later is enough on the next load, without
   * having to find the toggle to undo something they never chose.
   */
  useEffect(() => {
    if (!noraPossible) return;
    let cancelled = false;
    void (async () => {
      const status = await fetchNoraStatus();
      if (cancelled) return;
      setNoraStatus(status);
      if (!status.available) return;

      let turnedOff = false;
      try {
        turnedOff = window.localStorage.getItem("careloop.nora") === "off";
      } catch {
        // Blocked storage is not a preference. Default applies.
        turnedOff = false;
      }
      if (turnedOff || !noraBrowserSupported()) return;
      if (!cancelled) void enableNora();
    })();
    return () => {
      cancelled = true;
    };
  }, [enableNora, noraPossible]);

  /* ---------------------------------------------------------------- */
  /* Where Nora is, and therefore whether it may listen                */
  /* ---------------------------------------------------------------- */

  /**
   * One derived value, from a pure function, tested exhaustively in
   * `tests/unit/nora-state.test.ts`. Everything the interface says about
   * Nora and everything the engine is told to do comes from here, so the two
   * cannot disagree — which is what went wrong in the browser: the label
   * said "listening" while a draft sat unresolved beneath it.
   */
  const composerHasText = input.trim().length > 0;
  // An empty composer resolves the draft, whoever emptied it: Send, Clear,
  // or the person selecting all and deleting. Idempotent, so running it on
  // every render is exactly the same as running it once.
  if (!composerHasText) draftFromVoiceRef.current = false;
  const draftFromVoice = draftFromVoiceRef.current;

  const nora = noraState({
    configured: noraPossible,
    available: noraStatus?.available ?? null,
    enabled: noraOn,
    starting: noraStarting,
    recorder: voice,
    wakeTurn,
    composerHasText,
    draftFromVoice,
    sending: status === "sending",
    // No barge-in here, so the wake detector stands down for the whole of
    // playback and comes back through the same revalidating path as every
    // other arm — not through a resume() bolted onto the audio's onended.
    speaking,
    inBurst,
    countdownSeconds: countdown,
  });
  const armed = wakeIsArmed(nora);
  // A pure mirror of a derived value, for the wake callback to read without
  // capturing a render.
  armedRef.current = armed;

  /**
   * THE ENGINE IS MATCHED TO THE STATE, not driven by events.
   *
   * There is no "re-arm" call anywhere any more. This effect subscribes the
   * wake detector when — and only when — the state machine says armed, and
   * unsubscribes it otherwise. A draft appearing in the composer therefore
   * stands the detector down as a matter of arithmetic rather than because
   * some code path remembered to.
   *
   * AVAILABILITY IS REVALIDATED ON EVERY ARM. Not on the value fetched at
   * load: a tab can sit through the cutoff, and the moment before a
   * microphone reopens is exactly when the server should be asked again. A
   * refusal tears the engine down rather than arming it.
   */
  useEffect(() => {
    if (noraRef.current === null) {
      appliedArmRef.current = null;
      return;
    }
    if (appliedArmRef.current === armed) return;
    appliedArmRef.current = armed;

    let cancelled = false;
    void (async () => {
      const session = noraRef.current;
      if (session === null) return;
      if (!armed) {
        await session.pause();
        return;
      }
      const status = await fetchNoraStatus();
      if (cancelled) return;
      setNoraStatus(status);
      if (!status.available) {
        await teardownNoraRef.current();
        setNoraNote(noraMessage(status.reason ?? "expired"));
        return;
      }
      if (!cancelled) await noraRef.current?.resume();
    })();

    return () => {
      cancelled = true;
      // The decision never landed, so it must not count as applied.
      if (appliedArmRef.current === armed) appliedArmRef.current = null;
    };
  }, [armed]);

  /** The one fact the follow-up effect branches on. See its dependency note. */
  const noraAvailable = noraStatus?.available === true;

  /**
   * ONE BOUNDED FOLLOW-UP WINDOW, AFTER THE REPLY (M12f).
   *
   * The conversational gap this closes: today a person says "Hey Nora",
   * speaks, sends, hears the answer — and has to say "Hey Nora" again
   * before they may reply to it. Nobody talks like that.
   *
   * WHAT THIS IS. When a burst is open and the reply has finished being
   * read out, ONE recording opens on its own, under exactly the endpointing
   * contract a wake turn uses: speech-start timeout, silence finalisation,
   * maximum duration, and a `no_speech` outcome that ends the burst. The
   * transcript still lands in the composer, still visible, still editable,
   * and Send is still pressed by a person.
   *
   * WHAT THIS IS NOT. Not continuous listening: the microphone is closed
   * between turns and each window is a fresh, bounded recording. Not
   * barge-in: the window opens only once playback has ENDED. Not
   * auto-send: nothing leaves without a press, so a spoken "yes" is chat
   * input and never an authorization.
   *
   * `followUpOpenedRef` makes it ONE per reply. Without it, clearing the
   * composer mid-burst would open a second window for the same turn, and
   * a microphone that reopens because somebody pressed Clear is a
   * microphone nobody asked for.
   */
  useEffect(() => {
    if (!inBurst) return;
    if (followUpOpenedRef.current) return;
    // Every one of these is a reason the person's attention is elsewhere,
    // or the microphone is already spoken for.
    if (speaking || voice !== "off" || status === "sending") return;
    if (composerHasText) return;
    if (!noraOn || !noraAvailable || noraRef.current === null) return;

    followUpOpenedRef.current = true;
    // Committed. From here the page says "Listening for your reply", so
    // from here something has to guarantee that it stops saying it (M12j).
    armBurstWatchdogRef.current();
    let cancelled = false;
    void (async () => {
      /**
       * REVALIDATED, LIKE EVERY OTHER ARM.
       *
       * A follow-up window opens a microphone, so it asks the server the
       * same question the arming effect asks: is Nora still available?
       * Without this a page left open across the cutoff would keep opening
       * windows inside an existing burst, because `armed` never transitions
       * during one and the arming effect therefore never re-checks.
       *
       * A refusal tears the engine down and ends the burst, which is the
       * same answer the arming path gives.
       */
      const fresh = await fetchNoraStatus();
      if (cancelled) return;
      setNoraStatus(fresh);
      if (!fresh.available) {
        endBurstRef.current();
        await teardownNoraRef.current();
        setNoraNote(noraMessage(fresh.reason ?? "expired"));
        return;
      }
      if (cancelled || !inBurstRef.current) return;
      // The burst may still end while the microphone is opening.
      await beginRecording("wake", () => cancelled || !inBurstRef.current);
    })();
    return () => {
      cancelled = true;
    };
    /**
     * DEPENDENCIES ARE FACTS, NOT OBJECTS (M12g).
     *
     * `noraStatus` used to be in this list, and this effect CALLS
     * `setNoraStatus` with the object the server returned. A fresh object
     * every time meant storing the answer re-ran the effect, and the
     * re-run's cleanup cancelled the window the first run had just opened.
     * `followUpOpenedRef` then stopped the second run from opening another,
     * so the burst sat there saying "Listening for your reply" with no
     * microphone behind it and the wake engine paused — which is exactly
     * how it was reported from the browser.
     *
     * The effect branches on one FACT about the status, so that boolean is
     * the dependency. Re-validating no longer disturbs the thing being
     * validated.
     */
  }, [inBurst, speaking, voice, status, composerHasText, noraOn, noraAvailable, beginRecording]);

  /**
   * TYPING ENDS THE BURST.
   *
   * Someone who reaches for the keyboard has chosen the other input, and
   * leaving a follow-up window queued behind that would open a microphone
   * at somebody who is already typing. A voice TRANSCRIPT in the composer
   * is not typing and does not end anything — that is the burst working.
   */
  useEffect(() => {
    if (inBurst && composerHasText && !draftFromVoice) endBurst();
  }, [inBurst, composerHasText, draftFromVoice, endBurst]);

  const busy = status === "sending";

  /**
   * THE OPENING (M12f).
   *
   * One sentence, said once, by CareLoop — a time-of-day greeting from the
   * BROWSER's clock, plus either the deterministic memory question the
   * server decided was safe or an ordinary "How are you doing?".
   *
   * Null until the hour is known, which is one frame after mount: the
   * server has no business guessing the person's timezone, and rendering a
   * clock-dependent string during SSR is a hydration mismatch by
   * construction. See `useLocalHour`.
   *
   * It is display-only. It is not a message, it is never persisted, it is
   * not sent anywhere, and nothing reads it aloud — `readAloud` only ever
   * speaks a message id the server returned.
   */
  const localHour = useLocalHour();
  const opening =
    localHour === null
      ? null
      : composeOpening({
          hour: localHour,
          displayName: props.displayName,
          openingLine: props.openingLine,
        });

  /**
   * Nora's state, in a sentence. A message produced by a failure outranks
   * the steady-state wording: the last thing that happened is what the
   * person is trying to understand. Nothing here names a provider, a quota
   * or an API — every one of these is a CareLoop product state.
   */
  /**
   * THE ONE DOMINANT LINE.
   *
   * Large, plain, and at most one at a time. `noraStateText` below is the
   * sentence that explains; this is the two or three words somebody can
   * read from across the room. Null means nothing is happening, and then
   * the panel is not rendered at all — an empty state announced loudly is
   * still noise.
   */
  const voiceHeadline = noraStateHeadline(nora, countdown);

  /**
   * The opening survives only until the person says anything.
   *
   * No longer conditional on there BEING a memory question (M12f): the
   * greeting stands on its own, and an empty conversation with nothing in
   * it at all was the placeholder this replaces.
   */
  const showOpening =
    opening !== null &&
    !openingDismissed &&
    !openingSeenRef.current &&
    messages.length === 0 &&
    !composerHasText;

  const noraStateText =
    noraNote ??
    (nora === "unavailable"
      ? noraMessage(noraStatus?.reason ?? "initialization_failed")
      : (noraStateLabel(nora) ?? ""));

  return (
    <div className="mx-auto flex h-dvh w-full max-w-3xl flex-col px-4 sm:px-6">
      <header className="shrink-0 pt-5 pb-3">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
          <div>
            <h1 className="text-[1.7rem] font-semibold tracking-tight">CareLoop</h1>
            <p className="text-[0.95rem] text-[var(--color-muted)]">
              Stay connected with the people who matter.
            </p>
          </div>
          {props.devTools}
        </div>
      </header>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pb-3">
        {/*
          One live region for the whole transcript, polite rather than
          assertive, so a screen reader announces the reply when it settles
          instead of stuttering through every delta.
        */}
        {/*
          THE PROACTIVE OPENING. Decided on the server from an event the
          person themselves reported; rendered here as something CareLoop
          said, because it is. It disappears the moment they reply.
        */}
        {showOpening && (
          <div className="flex justify-start pb-3">
            <div className="max-w-[85%] rounded-2xl rounded-bl-md border border-[var(--color-line)] bg-[var(--color-surface)] px-4 py-3 text-[1rem] leading-normal">
              {opening}
            </div>
          </div>
        )}

        <div aria-live="polite" aria-atomic="false" className="space-y-3">
          {messages.map((message) => (
            <MessageRow
              key={message.id}
              message={message}
              closure={closure?.id === message.id ? closure.sentence : null}
              strip={offer?.block ?? null}
            />
          ))}
        </div>

        {busy && consentPending === null && <TypingIndicator />}

        {offer && (
          <ReconnectCard
            offer={offer}
            pending={consentPending}
            disabled={busy}
            onApprove={() => void send(APPROVE_PHRASE, "approve")}
            onDecline={() => void send(DECLINE_PHRASE, "decline")}
          />
        )}

        <div ref={endRef} />
      </div>

      {error && (
        <p role="alert" className="pb-2.5 text-[0.95rem] text-[#8a2f2f]">
          {error}
        </p>
      )}

      {voiceNote && (
        <p role="status" className="pb-2.5 text-[0.95rem] text-[var(--color-muted)]">
          {voiceNote}
        </p>
      )}

      {/*
        The microphone's state in words, announced politely. Recording is a
        thing a person needs to be certain about, and a colour change is not
        enough to be certain of.

        Sighted people now read this from the panel below; this stays for
        the instruction the panel's headline has no room for.
      */}
      <p aria-live="polite" className="sr-only">
        {voice === "recording" ? "Press Stop when you have finished." : ""}
      </p>

      {/*
        THE VOICE STATE, once, and large.
        A person who cannot tell whether CareLoop is listening will either
        talk to a microphone that is off or assume one is on that is not.
        Both are worse than a plain sentence, and the sentence is the same
        value that decides whether the wake detector is armed — so the
        interface cannot say "listening" while the engine is paused.
      */}
      {/*
        `aria-live` without `role="status"`: the note above is already the
        page's status region, and two of them means a screen reader
        announces the same turn twice and `getByRole("status")` stops being
        able to name either.
      */}
      {voiceHeadline !== null && (
        <div aria-live="polite" className="shrink-0 pb-3">
          <div
            className={`rounded-2xl border px-4 py-3 ${
              nora === "listening" || nora === "push_to_talk"
                ? "border-[var(--color-accent)] bg-[var(--color-surface)]"
                : "border-[var(--color-line)] bg-[var(--color-surface-muted)]"
            }`}
          >
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
              <p className="text-[1.25rem] leading-snug font-semibold">{voiceHeadline}</p>
              {/*
                THE WAY OUT OF AN AUTO-SEND (M12h).

                In the panel rather than beside the composer, because the
                panel is where the countdown is being announced and a
                person should not have to look in two places to stop one
                thing. Full height, so it is reachable without precision.
              */}
              {nora === "sending_shortly" && (
                <button
                  type="button"
                  onClick={cancelCountdown}
                  className="inline-flex min-h-[2.75rem] shrink-0 items-center rounded-xl border-2 border-[var(--color-line)] bg-[var(--color-surface)] px-4 text-[1rem] font-medium hover:bg-[var(--color-surface-muted)] focus-visible:outline-[3px] focus-visible:outline-offset-2 focus-visible:outline-[var(--color-accent)]"
                >
                  Cancel
                </button>
              )}
            </div>
            {noraStateText.length > 0 && !saysTheSame(noraStateText, voiceHeadline) && (
              <p className="pt-1 text-[0.97rem] leading-relaxed text-[var(--color-muted)]">
                {noraStateText}
              </p>
            )}
          </div>
        </div>
      )}

      <form
        className="shrink-0 pb-4"
        onSubmit={(event) => {
          event.preventDefault();
          void send(input);
        }}
      >
        <label htmlFor="chat-input" className="sr-only">
          Write a message to CareLoop
        </label>

        {/*
          WHERE THESE WORDS CAME FROM (M12e).

          The voice pipeline works, and that is exactly the problem on video:
          the transcript lands in the same composer a typed message lands in,
          so a reviewer watching the recording cannot tell speech from typing.
          Nothing about the flow is wrong; it is simply invisible.

          One line, shown only when the text in the box was produced by
          speech-to-text, and gone the moment the box is empty — `send`,
          Clear and a manual delete all resolve `draftFromVoice` through the
          same derivation (see `composerHasText` above), so there is no
          second piece of state to fall out of step.

          It survives EDITING on purpose: correcting a word the transcriber
          misheard does not make the message typed, and a label that
          vanished mid-correction would be lying in the other direction.

          It says "ready to send", never "sending": explicit Send is the
          whole point of showing the transcript, and a caption implying
          otherwise would undo it.
        */}
        {draftFromVoice && composerHasText && (
          <p
            data-voice-origin
            aria-live="polite"
            className="flex items-center gap-1.5 pb-1.5 pl-1 text-[0.9rem] text-[var(--color-muted)]"
          >
            <MicIcon />
            {nora === "sending_shortly"
              ? "Voice transcript — sending shortly"
              : "Voice transcript — check it, then press Send"}
          </p>
        )}

        {/*
          ONE shell, not three controls that happen to sit on the same line.
          The border, the background and the focus ring belong to this div;
          the textarea inside it is transparent and borderless. That is the
          whole trick, and it is why the microphone reads as part of the
          composer rather than as a second thing to decide about.
        */}
        <div
          data-composer
          // The textarea has no box of its own, so the SHELL shows its focus -
          // the same 3px accent outline every other focusable thing in
          // CareLoop gets, around the whole composer. An OUTLINE, not a
          // border, so it never competes with the recording border below.
          // Scoped to the textarea, so the buttons inside keep their own ring
          // instead of lighting up the entire composer when tabbed to.
          className={`flex items-end gap-1.5 rounded-2xl border-2 bg-[var(--color-surface)] p-1.5 transition-colors has-[textarea:focus-visible]:outline-[3px] has-[textarea:focus-visible]:outline-offset-2 has-[textarea:focus-visible]:outline-[var(--color-accent)] ${
            voice === "recording"
              ? "border-[var(--color-accent)]"
              : "border-[var(--color-line)]"
          }`}
        >
          <textarea
            id="chat-input"
            ref={composerRef}
            value={input}
            onChange={(event) => {
              // Correcting a mis-heard word is the commonest reason to stop
              // an auto-send, and the least likely thing to be expressed by
              // finding a Cancel button first (M12h).
              cancelCountdownRef.current();
              setInput(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void send(input);
              }
            }}
            rows={1}
            disabled={busy}
            // Short on purpose. The controls occupy the right end of the
            // composer, and at 375px a longer placeholder wraps to a second
            // line and is clipped. The full wording lives in the label.
            placeholder="Message…"
            // max-h caps the growth so a long message scrolls inside the
            // composer instead of eating the conversation above it.
            className="max-h-40 min-h-[2.75rem] flex-1 resize-none bg-transparent px-2.5 py-2.5 text-[1rem] leading-normal disabled:opacity-60"
          />
          <button
            type="button"
            onClick={() =>
              voice === "recording" ? void finishRecording() : void beginRecording("press")
            }
            disabled={busy || voice === "transcribing"}
            aria-label={voice === "recording" ? "Stop recording" : "Start voice input"}
            aria-pressed={voice === "recording"}
            aria-busy={voice === "transcribing" || undefined}
            // 2.75rem is 47px at the 17px root: past the 44px target, and the
            // same size in all three states so the row never twitches.
            className={`inline-flex h-[2.75rem] w-[2.75rem] shrink-0 items-center justify-center rounded-xl transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
              voice === "recording"
                ? "bg-[var(--color-accent)] text-white"
                : "text-[var(--color-muted)] hover:bg-[var(--color-surface-muted)]"
            }`}
          >
            {voice === "recording" ? (
              <StopIcon />
            ) : voice === "transcribing" ? (
              <SpinnerIcon />
            ) : (
              <MicIcon />
            )}
          </button>
          <Button
            type="submit"
            disabled={busy || input.trim().length === 0}
            pending={busy && consentPending === null}
            pendingLabel="Sending…"
            // The word, not an icon. This product is read by people who should
            // not have to know what a paper aeroplane means.
            className="shrink-0 rounded-xl"
          >
            Send
          </Button>
        </div>

        {/*
          NORA. One row, under the composer rather than inside it: the
          microphone button is the interaction that always works, and an
          experiment must not compete with it for the same space.

          The control is offered only once the server has answered. It stays
          pressable even when the answer was no, because "attempting to turn
          it on tells you why" is a better experience than a dead switch
          nobody can get an explanation out of.
        */}
        {/*
          The voice controls row. Shown when there is a wake word to offer
          OR when this person has used voice at all — a build with no wake
          word still has a reading speed worth setting.
        */}
        {(noraStatus !== null || voiceModeOn) && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 pt-2.5">
            {noraStatus !== null && (
            <button
              type="button"
              onClick={toggleNora}
              disabled={noraStarting}
              role="switch"
              aria-checked={noraOn}
              aria-label="Nora hands-free"
              className={`inline-flex items-center gap-2 rounded-xl border px-3 py-2 text-[0.95rem] transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                noraOn
                  ? "border-[var(--color-accent)] bg-[var(--color-accent)] text-white"
                  : "border-[var(--color-line)] text-[var(--color-muted)] hover:bg-[var(--color-surface-muted)]"
              }`}
            >
              <span>Nora hands-free</span>
              <span aria-hidden="true" className="font-semibold">
                {noraStarting ? "…" : noraOn ? "On" : "Off"}
              </span>
            </button>
            )}
            {/*
              The state itself now lives in the large panel above. This line
              survives for the one case the panel does not cover: Nora is
              simply off, so there is no state to announce — only an
              invitation, or the reason a start failed.
            */}
            {/*
              END VOICE SESSION (M12f).
              Shown only while a burst is open, and the plainest way out of
              one: a person who no longer wants to be listened to should
              not have to work out that silence eventually ends it, or
              that the toggle above would do it. It closes the burst and
              cancels any window already open; Nora itself stays on and
              goes back to waiting for "Hey Nora".
            */}
            {inBurst && (
              <button
                type="button"
                onClick={endBurst}
                className="inline-flex min-h-[2.75rem] items-center rounded-xl border border-[var(--color-line)] px-3 text-[0.95rem] text-[var(--color-muted)] hover:bg-[var(--color-surface-muted)]"
              >
                End voice session
              </button>
            )}
            {/*
              Reading speed. Offered only to somebody who has actually used
              voice this session — a typed-chat user has nothing to set.
              Two choices, not a slider: a slider is a decision to make.
            */}
            {voiceModeOn && (
              <button
                type="button"
                aria-pressed={speechRate === "slower"}
                aria-label="Read replies more slowly"
                onClick={() => {
                  const next: SpeechRate = speechRate === "slower" ? "normal" : "slower";
                  speechRateRef.current = next;
                  setSpeechRate(next);
                  try {
                    window.localStorage.setItem("careloop.speech-rate", next);
                  } catch {
                    /* a convenience, never load-bearing */
                  }
                }}
                className={`rounded-xl border px-3 py-2 text-[0.95rem] transition-colors ${
                  speechRate === "slower"
                    ? "border-[var(--color-accent)] bg-[var(--color-accent)] text-white"
                    : "border-[var(--color-line)] text-[var(--color-muted)] hover:bg-[var(--color-surface-muted)]"
                }`}
              >
                {speechRate === "slower" ? "Reading slower" : "Read slower"}
              </button>
            )}

            {voiceHeadline === null && noraStateText.length > 0 && (
              <p className="text-[0.95rem] text-[var(--color-muted)]">{noraStateText}</p>
            )}
            {/*
              Resolving a draft without sending it. Offered only for a
              transcript Nora produced: text the person typed is theirs, and
              a button that silently discards it would be worse than no
              button. Clearing empties the composer, which is what re-arms
              the wake detector — one action, one consequence.
            */}
            {nora === "draft_ready" && (
              <button
                type="button"
                onClick={() => {
                  setInput("");
                  draftFromVoiceRef.current = false;
                  setVoiceNote(null);
                  composerRef.current?.focus();
                }}
                className="rounded-xl border border-[var(--color-line)] px-3 py-2 text-[0.95rem] text-[var(--color-muted)] transition-colors hover:bg-[var(--color-surface-muted)]"
              >
                Clear
              </button>
            )}
          </div>
        )}

        {(voice !== "off" || speaking) && (
          <div className="flex flex-wrap items-center gap-2.5 pt-2.5">
            {/* In words, never colour alone. */}
            {voice === "recording" && (
              <span className="text-[0.95rem] text-[var(--color-muted)]">Listening…</span>
            )}
            {voice === "transcribing" && (
              <span className="text-[0.95rem] text-[var(--color-muted)]">Transcribing…</span>
            )}

            {speaking && (
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  stopSpeaking();
                  setSpeaking(false);
                }}
                aria-label="Stop reading aloud"
              >
                Stop reading
              </Button>
            )}
          </div>
        )}
      </form>
    </div>
  );
}

/**
 * Whether the explaining sentence is just the headline again.
 *
 * Compared without trailing punctuation or case, because "Speaking" and
 * "Speaking." are the same thing said twice and a person reading the panel
 * should not have to notice the full stop to work that out.
 */
function saysTheSame(sentence: string, headline: string): boolean {
  const strip = (value: string) => value.replace(/[.\s]+$/, "").trim().toLowerCase();
  return strip(sentence) === strip(headline);
}

function MessageRow({
  message,
  closure,
  strip,
}: {
  message: ChatMessage;
  closure: string | null;
  /**
   * The exact offer block currently shown as a card. Removed from the bubble
   * so the draft is not printed twice - an exact string comparison on bytes
   * the SERVER supplied, never a pattern match on what the sentence looks like.
   */
  strip: string | null;
}) {
  const isUser = message.role === "user";
  let body = message.content;

  if (!isUser) {
    if (closure && body.startsWith(`${closure}\n\n`)) body = body.slice(closure.length + 2);
    if (strip && body.endsWith(`\n\n${strip}`)) body = body.slice(0, -(strip.length + 2));
  }

  return (
    <div className="space-y-2">
      {closure && !isUser && <ClosureUpdate sentence={closure} />}
      {body.trim().length > 0 && (
        <div className={isUser ? "flex justify-end" : "flex justify-start"}>
          <div
            className={
              isUser
                ? "max-w-[78%] rounded-2xl rounded-br-md bg-[var(--color-accent)] px-4 py-3 text-[1rem] leading-normal whitespace-pre-wrap break-words text-white"
                : "max-w-[85%] rounded-2xl rounded-bl-md border border-[var(--color-line)] bg-[var(--color-surface)] px-4 py-3 text-[1rem] leading-normal whitespace-pre-wrap break-words"
            }
          >
            {body}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * News from a family member.
 *
 * Distinguished, not alarming: a quiet label and the factual sentence. No
 * colour that reads as a warning, no celebration, and no interpretation - the
 * sentence says what was answered and nothing about what it means.
 */
function ClosureUpdate({ sentence }: { sentence: string }) {
  return (
    <Card className="border-[var(--color-accent)]/25 bg-[var(--color-accent-soft)]">
      <CardLabel>Update</CardLabel>
      <p className="pt-1.5 text-[1rem] leading-normal">{sentence}</p>
    </Card>
  );
}

/** Decorative: the control that uses it carries an accessible label. */
function StopIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="h-[1.1rem] w-[1.1rem]"
      fill="currentColor"
    >
      <rect x="7" y="7" width="10" height="10" rx="2" />
    </svg>
  );
}

/** Decorative: the control that uses it carries an accessible label. */
/** Same box as the microphone, so the composer does not move while it thinks. */
function SpinnerIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="h-[1.3rem] w-[1.3rem] motion-safe:animate-spin"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
    >
      <path d="M12 3a9 9 0 1 0 9 9" />
    </svg>
  );
}

function MicIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="h-[1.3rem] w-[1.3rem]"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
    >
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0" />
      <path d="M12 18v3" />
    </svg>
  );
}

function TypingIndicator() {
  return (
    <div className="flex justify-start" aria-hidden="true">
      <div className="rounded-2xl rounded-bl-md border border-[var(--color-line)] bg-[var(--color-surface)] px-4 py-3.5">
        <span className="flex gap-1.5">
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              className="h-2.5 w-2.5 animate-pulse rounded-full bg-[var(--color-muted)]"
              style={{ animationDelay: `${i * 160}ms` }}
            />
          ))}
        </span>
      </div>
    </div>
  );
}

/**
 * The reconnect offer.
 *
 * Every word of the draft below is the exact stored `rendered_text` the server
 * sent in the offer event. The browser does not compose it, shorten it, or ask
 * anything to rewrite it - if it did, the person would be approving a sentence
 * other than the one that gets delivered, which is the single failure the
 * whole consent design exists to prevent.
 */
function ReconnectCard({
  offer,
  pending,
  disabled,
  onApprove,
  onDecline,
}: {
  offer: PendingOffer;
  pending: ConsentPending;
  disabled: boolean;
  onApprove: () => void;
  onDecline: () => void;
}) {
  return (
    <Card className="border-[var(--color-accent)]/30">
      <CardLabel>Reconnect with {offer.entityName}</CardLabel>

      <p className="pt-2.5 pb-1.5 text-[0.95rem] text-[var(--color-muted)]">
        Message to {offer.entityName}
      </p>
      <QuotedText>{offer.renderedText}</QuotedText>

      {offer.state === "offered" ? (
        <div className="flex flex-col gap-2.5 pt-4 sm:flex-row">
          <Button
            type="button"
            onClick={onApprove}
            disabled={disabled}
            pending={pending === "approve"}
            pendingLabel="Sending…"
          >
            Send message
          </Button>
          <Button
            type="button"
            variant="secondary"
            onClick={onDecline}
            disabled={disabled}
            pending={pending === "decline"}
            pendingLabel="One moment…"
          >
            Not now
          </Button>
        </div>
      ) : (
        // In flight, and nothing to press. Not "sent": delivery happens after
        // this reply is flushed, and the card is retired on the next turn
        // rather than left behind to describe a moment that has passed.
        <p className="pt-4 text-[1rem] text-[var(--color-muted)]">
          Approved — sending to {offer.entityName} now.
        </p>
      )}
    </Card>
  );
}
