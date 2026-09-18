import "server-only";

/**
 * Cloudflare Workers AI streams Server-Sent Events. This turns that byte
 * stream into the text deltas the `LlmProvider` port promises.
 *
 * The parsing is small but not trivial, and getting it wrong is invisible
 * rather than loud: a chunk boundary can fall anywhere, including inside a
 * multi-byte character or halfway through a JSON payload, so anything that
 * decodes per-chunk or splits per-chunk will silently drop or mangle text
 * that a reader would only notice as an oddly-worded sentence. Hence a
 * streaming decoder and a carry-over buffer.
 */
export async function* readSseText(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  // `stream: true` keeps a partial UTF-8 sequence across chunk boundaries
  // instead of emitting a replacement character.
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Events are separated by a blank line; a trailing partial event stays
      // in the buffer until the bytes that finish it arrive.
      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const event = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const text = textFromEvent(event);
        if (text !== null) yield text;
        boundary = buffer.indexOf("\n\n");
      }
    }

    // A final event with no trailing blank line.
    const tail = textFromEvent(buffer);
    if (tail !== null) yield tail;
  } finally {
    // Whether the consumer finished, threw, or walked away, the socket is
    // released. An abandoned generator otherwise holds the connection open.
    reader.releaseLock();
  }
}

/** The text in one SSE event, or null if it carries none. */
function textFromEvent(event: string): string | null {
  const parts: string[] = [];

  for (const line of event.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (payload === "" || payload === "[DONE]") continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(payload);
    } catch {
      // A malformed event is skipped rather than thrown: the alternative is
      // failing a turn that is otherwise arriving correctly.
      continue;
    }

    const text = (parsed as { response?: unknown })?.response;
    if (typeof text === "string" && text.length > 0) parts.push(text);
  }

  return parts.length > 0 ? parts.join("") : null;
}
