import type { TurnEvent } from "@/server/services/conversation";
import type { LlmChatRequest, LlmProvider } from "@/server/adapters/openai/types";
import type { IngestJobPayload, JobsRepo } from "@/server/repositories/jobs";
import { EMPTY_MEMORY } from "@/server/services/context";
import type { ConversationsRepo } from "@/server/repositories/conversations";
import type { MessagesRepo, StoredMessage } from "@/server/repositories/messages";

/** Ordered record of every dependency call, so we can assert sequencing. */
export type CallLog = string[];

export function fakeRepos(options: {
  log: CallLog;
  ownedConversationIds?: string[];
  existingMessages?: StoredMessage[];
  latestConversationId?: string | null;
}) {
  const owned = new Set(options.ownedConversationIds ?? []);
  const stored: StoredMessage[] = [...(options.existingMessages ?? [])];
  let seq = 0;
  let lastListRecentLimit: number | null = null;

  const conversations: ConversationsRepo = {
    async create(userId) {
      options.log.push(`conversations.create:${userId}`);
      const id = `conv-${++seq}`;
      owned.add(id);
      return { id };
    },
    async findOwned(conversationId, userId) {
      options.log.push(`conversations.findOwned:${conversationId}:${userId}`);
      return owned.has(conversationId) ? { id: conversationId } : null;
    },
    async findLatest(userId) {
      options.log.push(`conversations.findLatest:${userId}`);
      return options.latestConversationId
        ? { id: options.latestConversationId }
        : null;
    },
    async earliestStartedAt() {
      return null;
    },
  };

  const messages: MessagesRepo = {
    async insert({ role, content }) {
      options.log.push(`messages.insert:${role}`);
      const message: StoredMessage = {
        id: `msg-${++seq}`,
        role,
        content,
        createdAt: new Date(2026, 0, 1, 0, 0, seq).toISOString(),
      };
      stored.push(message);
      return message;
    },
    async findById(id) {
      options.log.push(`messages.findById:${id}`);
      return stored.find((m) => m.id === id) ?? null;
    },

    async listRecent(_conversationId, limit) {
      options.log.push(`messages.listRecent:${limit}`);
      lastListRecentLimit = limit;
      return stored.slice(-limit);
    },
  };

  return {
    conversations,
    messages,
    stored,
    get lastListRecentLimit() {
      return lastListRecentLimit;
    },
    assistantMessages: () => stored.filter((m) => m.role === "assistant"),
    userMessages: () => stored.filter((m) => m.role === "user"),
  };
}

export function fakeLlm(options: {
  log: CallLog;
  chunks?: string[];
  failOnRequest?: boolean;
  failMidStream?: boolean;
}): LlmProvider & { lastRequest: () => LlmChatRequest | null } {
  let lastRequest: LlmChatRequest | null = null;

  return {
    lastRequest: () => lastRequest,
    async streamChat(request) {
      lastRequest = request;
      options.log.push("llm.streamChat");
      if (options.failOnRequest) throw new Error("upstream rejected the request");
      const chunks = options.chunks ?? ["Hello", " there."];
      return (async function* () {
        for (const chunk of chunks) yield chunk;
        if (options.failMidStream) throw new Error("connection dropped mid-stream");
      })();
    },
  };
}

/**
 * The assistant text a turn produces, reassembled from its events.
 *
 * Deliberately rebuilds the SAME string the server persists - closure line,
 * blank line, model deltas, blank line, offer block - so every assertion
 * written against the old flat stream still means what it meant. If this
 * reconstruction and `persistOnSuccess` ever disagree, the wire format has
 * started drifting from the stored message, which is the one thing the
 * framing was not allowed to do.
 */
export async function drain(stream: AsyncIterable<TurnEvent>): Promise<string> {
  let text = "";
  for await (const event of stream) {
    if (event.type === "closure") text += `${event.sentence}\n\n`;
    else if (event.type === "delta") text += event.text;
    else if (event.type === "offer") text += `\n\n${event.block}`;
    // `state` carries no message text: it describes the reconnect, not the
    // turn, and nothing about it is persisted into the assistant message.
  }
  return text;
}

/** The typed events themselves, for tests about the wire rather than the text. */
export async function drainEvents(stream: AsyncIterable<TurnEvent>): Promise<TurnEvent[]> {
  const events: TurnEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}


/** Minimal jobs repo: records what was created, claims nothing by default. */
export function fakeJobs(options: { log: CallLog }) {
  const created: Array<{ key: string; payload: IngestJobPayload }> = [];
  const repo: JobsRepo = {
    async createIngestJob(key, payload) {
      options.log.push(`jobs.createIngestJob:${key}`);
      // Idempotent on key, like the real unique index.
      if (!created.some((job) => job.key === key)) created.push({ key, payload });
    },
    async claim() {
      return [];
    },
    async complete() {},
    async fail() {},
  };
  return { repo, created };
}

/** M1 behaviour: a turn with no memory at all. */
export const emptyMemoryLoader = async () => EMPTY_MEMORY;
