"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
};

type Status = "idle" | "sending";

export function Chat(props: {
  initialConversationId: string | null;
  initialMessages: ChatMessage[];
}) {
  const [conversationId, setConversationId] = useState(props.initialConversationId);
  const [messages, setMessages] = useState<ChatMessage[]>(props.initialMessages);
  const [input, setInput] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || status === "sending") return;

    setError(null);
    setStatus("sending");
    setInput("");

    const userMessage: ChatMessage = {
      id: `local-user-${Date.now()}`,
      role: "user",
      content: text,
    };
    const draftId = `local-assistant-${Date.now()}`;
    setMessages((prev) => [...prev, userMessage]);

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

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        if (!chunk) continue;
        setMessages((prev) =>
          prev.map((m) => (m.id === draftId ? { ...m, content: m.content + chunk } : m)),
        );
      }
    } catch {
      // The assistant turn was never persisted server-side, so showing a
      // partial bubble would be a lie that vanishes on refresh. Drop it.
      setMessages((prev) => prev.filter((m) => m.id !== draftId));
      setError("Sorry — I couldn't answer just then. Please try again.");
    } finally {
      setStatus("idle");
    }
  }, [conversationId, input, status]);

  return (
    <div className="mx-auto flex h-dvh w-full max-w-2xl flex-col px-4">
      <header className="shrink-0 py-5">
        <h1 className="text-xl font-semibold tracking-tight">CareLoop</h1>
      </header>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pb-4" aria-live="polite">
        {messages.length === 0 && (
          <p className="pt-8 text-center text-neutral-500">
            Say hello whenever you&rsquo;re ready.
          </p>
        )}

        {messages.map((message) => (
          <div
            key={message.id}
            className={message.role === "user" ? "flex justify-end" : "flex justify-start"}
          >
            <div
              className={
                message.role === "user"
                  ? "max-w-[85%] rounded-2xl bg-neutral-900 px-4 py-3 text-lg leading-relaxed text-white"
                  : "max-w-[85%] rounded-2xl bg-neutral-100 px-4 py-3 text-lg leading-relaxed text-neutral-900"
              }
            >
              {message.content || (
                <span className="text-neutral-400">…</span>
              )}
            </div>
          </div>
        ))}
        <div ref={endRef} />
      </div>

      {error && (
        <p role="alert" className="pb-3 text-base text-red-700">
          {error}
        </p>
      )}

      <form
        className="shrink-0 pb-6"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <div className="flex items-end gap-2">
          <textarea
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void send();
              }
            }}
            rows={2}
            disabled={status === "sending"}
            placeholder="Type a message…"
            aria-label="Message"
            className="flex-1 resize-none rounded-xl border border-neutral-300 px-4 py-3 text-lg outline-none focus:border-neutral-500 disabled:opacity-60"
          />
          <button
            type="submit"
            disabled={status === "sending" || input.trim().length === 0}
            className="rounded-xl bg-neutral-900 px-5 py-3 text-lg font-medium text-white disabled:opacity-40"
          >
            {status === "sending" ? "Sending…" : "Send"}
          </button>
        </div>
      </form>
    </div>
  );
}
