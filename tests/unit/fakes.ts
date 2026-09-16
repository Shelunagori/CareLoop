import type { LlmChatRequest, LlmProvider } from "@/server/adapters/openai/types";
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

export async function drain(stream: AsyncIterable<string>): Promise<string> {
  let out = "";
  for await (const chunk of stream) out += chunk;
  return out;
}
