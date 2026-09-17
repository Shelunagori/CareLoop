"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Card, CardLabel, QuotedText } from "./ui";

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
  | { type: "state"; pendingOffer: PendingOffer | null };

type Status = "idle" | "sending";
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
  const endRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, offer, closure]);

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
    [conversationId, status],
  );

  const busy = status === "sending";
  const greeting = props.displayName ? `Hello, ${props.displayName}` : null;

  return (
    <div className="mx-auto flex h-dvh w-full max-w-3xl flex-col px-4 sm:px-6">
      <header className="shrink-0 pt-6 pb-4">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2">
          <div>
            <h1 className="text-[1.6rem] font-semibold tracking-tight">CareLoop</h1>
            <p className="text-[var(--color-muted)]">
              Stay connected with the people who matter.
            </p>
          </div>
          {props.devTools}
        </div>
        {greeting && (
          <p className="pt-4 text-[1.25rem] font-medium">{greeting}</p>
        )}
      </header>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pb-4">
        {messages.length === 0 && (
          <div className="pt-10 text-center">
            <p className="text-[1.15rem] text-[var(--color-muted)]">
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
        <div aria-live="polite" aria-atomic="false" className="space-y-4">
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
        <p role="alert" className="pb-3 text-[1rem] text-[#8a2f2f]">
          {error}
        </p>
      )}

      <form
        className="shrink-0 pb-5"
        onSubmit={(event) => {
          event.preventDefault();
          void send(input);
        }}
      >
        <label htmlFor="chat-input" className="sr-only">
          Write a message to CareLoop
        </label>
        <div className="flex items-end gap-3">
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
            rows={2}
            disabled={busy}
            placeholder="Write a message…"
            className="min-h-[3.5rem] flex-1 resize-none rounded-xl border-2 border-[var(--color-line)] bg-[var(--color-surface)] px-4 py-3 text-[1.1rem] leading-relaxed outline-none disabled:opacity-60"
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
    <div className="space-y-3">
      {closure && !isUser && <ClosureUpdate sentence={closure} />}
      {body.trim().length > 0 && (
        <div className={isUser ? "flex justify-end" : "flex justify-start"}>
          <div
            className={
              isUser
                ? "max-w-[85%] rounded-2xl rounded-br-md bg-[var(--color-accent)] px-5 py-3.5 text-[1.1rem] leading-relaxed whitespace-pre-wrap break-words text-white"
                : "max-w-[85%] rounded-2xl rounded-bl-md border border-[var(--color-line)] bg-[var(--color-surface)] px-5 py-3.5 text-[1.1rem] leading-relaxed whitespace-pre-wrap break-words"
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
      <p className="pt-2 text-[1.1rem] leading-relaxed">{sentence}</p>
    </Card>
  );
}

function TypingIndicator() {
  return (
    <div className="flex justify-start" aria-hidden="true">
      <div className="rounded-2xl rounded-bl-md border border-[var(--color-line)] bg-[var(--color-surface)] px-5 py-4">
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

      <p className="pt-3 pb-2 text-[var(--color-muted)]">
        Message to {offer.entityName}
      </p>
      <QuotedText>{offer.renderedText}</QuotedText>

      {offer.state === "offered" ? (
        <div className="flex flex-col gap-3 pt-5 sm:flex-row">
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
        <p className="pt-5 text-[1.05rem] text-[var(--color-muted)]">
          Approved — sending to {offer.entityName} now.
        </p>
      )}
    </Card>
  );
}
