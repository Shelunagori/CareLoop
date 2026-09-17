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
  type SpeakRequest,
} from "./speech";

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
  devTools?: React.ReactNode;
  demoHint?: React.ReactNode;
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
  const [speaking, setSpeaking] = useState(false);
  const recordingRef = useRef<Recording | null>(null);
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
      await speak(request, { onEnded: done });
    } catch (error) {
      // Never fatal: the words are already on screen.
      setVoiceNote(
        error instanceof SpeakError ? speakMessage(error.reason) : "I couldn't play that aloud.",
      );
      done();
    }
  }, []);

  const send = useCallback(
    async (rawText: string, consent: ConsentPending = null) => {
      const text = rawText.trim();
      if (!text || status === "sending") return;

      setError(null);
      setStatus("sending");
      setConsentPending(consent);
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
        setError("Sorry, I couldn't send that just now. Please try again.");
      } finally {
        setStatus("idle");
        setConsentPending(null);
      }
    },
    [conversationId, status, voiceModeOn, readAloud],
  );

  const finishRecording = useCallback(async () => {
    const recording = recordingRef.current;
    if (!recording) return;
    recordingRef.current = null;
    setVoice("transcribing");

    try {
      const audio = await recording.stop();
      const text = await transcribe(audio);
      // Into the composer, NOT straight down the wire. The person reads what
      // was heard before it becomes a message - a mishearing that turns
      // itself into an irreversible action is the failure this prevents.
      setInput(text);
      composerRef.current?.focus();
    } catch (error) {
      // Two different apologies, because they are two different situations.
      // "I didn't catch that" tells the person to speak again; it must not be
      // said when the recording itself was the problem, or we blame their
      // voice for our bug. Either way nothing is sent and nothing is lost.
      setVoiceNote(
        error instanceof NothingHeardError
          ? "I didn't catch that. Could you try again?"
          : "Sorry, that recording didn't work. Please try again.",
      );
    } finally {
      setVoice("off");
    }
  }, []);

  const beginRecording = useCallback(async () => {
    setError(null);
    setVoiceNote(null);
    stopSpeaking();
    try {
      recordingRef.current = await startRecording({
        // The recorder has a ceiling, and a ceiling that fires while the
        // screen still says "Listening…" is the interface lying about a
        // microphone. The handle has already released it by the time this
        // runs; all that is left is to finish the turn the way the person
        // would have - transcribe, show the words, and wait for Send.
        onLimitReached: () => {
          setVoiceNote("That's as long as I can record at once — here's what I heard.");
          void finishRecording();
        },
      });
      // From here on this person hears replies. Nothing plays before they
      // have asked for voice at least once.
      setVoiceModeOn(true);
      setVoice("recording");
    } catch (error) {
      setVoiceNote(
        error instanceof MicrophoneError
          ? microphoneMessage(error.reason)
          : microphoneMessage("failed"),
      );
      setVoice("off");
    }
  }, [finishRecording]);

  const busy = status === "sending";
  const greeting = props.displayName ? `Hello, ${props.displayName}` : null;

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
        {greeting && (
          <p className="pt-3 text-[1.35rem] font-medium">{greeting}</p>
        )}
      </header>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pb-3">
        {messages.length === 0 && (
          <div className="pt-8 text-center">
            <p className="text-[1.05rem] text-[var(--color-muted)]">
              Say hello whenever you&rsquo;re ready.
            </p>
            {props.demoHint}
          </div>
        )}

        {/*
          One live region for the whole transcript, polite rather than
          assertive, so a screen reader announces the reply when it settles
          instead of stuttering through every delta.
        */}
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
      */}
      <p aria-live="polite" className="sr-only">
        {voice === "recording"
          ? "Recording. Press Stop when you have finished."
          : voice === "transcribing"
            ? "Working out what you said."
            : ""}
      </p>

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
            onChange={(event) => setInput(event.target.value)}
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
              voice === "recording" ? void finishRecording() : void beginRecording()
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
