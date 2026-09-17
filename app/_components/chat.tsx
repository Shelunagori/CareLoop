"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Card, CardLabel, QuotedText } from "./ui";
import {
  isRecordingSupported,
  microphoneMessage,
  MicrophoneError,
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
    try {
      await speak(request);
    } catch (error) {
      // Never fatal: the words are already on screen.
      setVoiceNote(
        error instanceof SpeakError ? speakMessage(error.reason) : "I couldn't play that aloud.",
      );
    } finally {
      setSpeaking(false);
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

  const beginRecording = useCallback(async () => {
    setError(null);
    setVoiceNote(null);
    stopSpeaking();
    try {
      recordingRef.current = await startRecording();
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
  }, []);

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
    } catch {
      setVoiceNote("I couldn't understand that recording. Please try again.");
    } finally {
      setVoice("off");
    }
  }, []);

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
        <div className="flex items-end gap-2.5">
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
            placeholder="Write a message…"
            className="min-h-[3.5rem] flex-1 resize-none rounded-xl border-2 border-[var(--color-line)] bg-[var(--color-surface)] px-4 py-3 text-[1rem] leading-normal outline-none disabled:opacity-60"
          />
          <Button
            type="submit"
            disabled={busy || input.trim().length === 0}
            pending={busy && consentPending === null}
            pendingLabel="Sending…"
          >
            Send
          </Button>
        </div>

        <div className="flex flex-wrap items-center gap-2.5 pt-2.5">
          {voice === "recording" ? (
            <Button
              type="button"
              variant="secondary"
              onClick={() => void finishRecording()}
              aria-label="Stop recording"
            >
              <MicIcon /> Stop
            </Button>
          ) : (
            <Button
              type="button"
              variant="secondary"
              onClick={() => void beginRecording()}
              disabled={busy || voice === "transcribing"}
              pending={voice === "transcribing"}
              pendingLabel="Transcribing…"
              aria-label="Speak your message"
            >
              <MicIcon /> Speak
            </Button>
          )}

          {voice === "recording" && (
            <span className="text-[0.95rem] text-[var(--color-muted)]">Listening…</span>
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

/** Decorative: every control that uses it also carries a text label. */
function MicIcon() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="mr-2 h-[1.15rem] w-[1.15rem]"
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
