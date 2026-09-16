import { chatConfig } from "@/server/config";
import type { LlmProvider } from "@/server/adapters/openai/types";
import type { ConversationsRepo } from "@/server/repositories/conversations";
import type { JobsRepo } from "@/server/repositories/jobs";
import type { MessagesRepo, StoredMessage } from "@/server/repositories/messages";
import { assembleContext, EMPTY_MEMORY, type MemorySections } from "./context";

/**
 * Orchestration for one conversational turn. The route handler stays thin:
 * authenticate → parse → call this → stream. Everything about ordering,
 * ownership and persistence semantics lives here, where it can be tested with
 * fakes and no network.
 */

export class ConversationNotFoundError extends Error {
  constructor() {
    super("Conversation not found for this user");
    this.name = "ConversationNotFoundError";
  }
}

export class EmptyCompletionError extends Error {
  constructor() {
    super("Model returned no content");
    this.name = "EmptyCompletionError";
  }
}

export type ConversationDataDeps = {
  conversations: ConversationsRepo;
  messages: MessagesRepo;
};

/**
 * Bounded memory for one turn. Injected rather than imported so the hot path
 * stays testable without a database or an embedding provider.
 */
export type MemoryLoader = (input: {
  userId: string;
  text: string;
}) => Promise<MemorySections>;

export type ConversationDeps = ConversationDataDeps & {
  llm: LlmProvider;
  jobs: JobsRepo;
  memory: MemoryLoader;
};

export type TurnInput = {
  /** Always resolved server-side from the session. Never from the request body. */
  userId: string;
  conversationId?: string;
  text: string;
};

export type TurnResult = {
  conversationId: string;
  userMessageId: string;
  /** Yields assistant text deltas; persists the assistant message on success. */
  stream: AsyncIterable<string>;
};

export async function handleTurn(
  deps: ConversationDeps,
  input: TurnInput,
): Promise<TurnResult> {
  // 1. Resolve the conversation. An id supplied by the browser is only ever
  //    accepted if it belongs to this user; otherwise this is indistinguishable
  //    from "does not exist".
  const conversation = input.conversationId
    ? await deps.conversations.findOwned(input.conversationId, input.userId)
    : await deps.conversations.create(input.userId);

  if (!conversation) throw new ConversationNotFoundError();

  // 2. Persist the user message BEFORE the model is called. If generation
  //    fails, what the person actually said is already safe.
  const userMessage = await deps.messages.insert({
    conversationId: conversation.id,
    role: "user",
    content: input.text,
  });

  // 3. Bounded recent turns. This query already includes the message persisted
  //    in step 2 — it is the newest row — so it is NOT appended again.
  const recentTurns = await deps.messages.listRecent(
    conversation.id,
    chatConfig.recentTurnLimit,
  );

  // 4. Bounded memory retrieval (M2). A retrieval failure must not cost the
  //    person their reply, so the turn degrades to no memory rather than
  //    failing — the same behaviour a brand-new user already gets.
  let memory: MemorySections = EMPTY_MEMORY;
  try {
    memory = await deps.memory({ userId: input.userId, text: input.text });
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "chat.memory_unavailable",
        errorName: error instanceof Error ? error.name : "UnknownError",
      }),
    );
  }

  // 5. Deterministic assembly.
  const context = assembleContext({ recentTurns, memory });

  // 6. Open the stream. A rejected key, quota error or connectivity failure
  //    rejects HERE, before any HTTP body has been written, so the route can
  //    still answer with a clean status code.
  const deltas = await deps.llm.streamChat({
    promptRef: context.promptRef,
    messages: context.messages,
  });

  return {
    conversationId: conversation.id,
    userMessageId: userMessage.id,
    stream: persistOnSuccess(deps, deltas, {
      userId: input.userId,
      conversationId: conversation.id,
      userMessageId: userMessage.id,
    }),
  };
}

/**
 * Relays deltas to the caller while accumulating the exact generated text, and
 * persists the assistant message only after the stream completes cleanly. A
 * mid-stream failure propagates and writes nothing: a partial answer is never
 * recorded as if it were the assistant's turn.
 *
 * The durable ingest job is committed here too, immediately after the
 * assistant message and BEFORE anything attempts ingestion (R8). On a
 * serverless runtime, work scheduled after the response may never run at all,
 * so durability has to be established before the fragile step, not inside its
 * error handler.
 */
async function* persistOnSuccess(
  deps: ConversationDeps,
  deltas: AsyncIterable<string>,
  turn: { userId: string; conversationId: string; userMessageId: string },
): AsyncGenerator<string> {
  let full = "";
  for await (const delta of deltas) {
    full += delta;
    yield delta;
  }

  if (full.trim().length === 0) throw new EmptyCompletionError();

  const assistantMessage = await deps.messages.insert({
    conversationId: turn.conversationId,
    role: "assistant",
    content: full,
  });

  await deps.jobs.createIngestJob(assistantMessage.id, {
    conversationId: turn.conversationId,
    userMessageId: turn.userMessageId,
    assistantMessageId: assistantMessage.id,
    userId: turn.userId,
  });
}

export type ConversationView = {
  conversationId: string | null;
  messages: StoredMessage[];
};

/** Read model for the chat page. */
export async function loadConversationView(
  deps: ConversationDataDeps,
  userId: string,
): Promise<ConversationView> {
  const conversation = await deps.conversations.findLatest(userId);
  if (!conversation) return { conversationId: null, messages: [] };

  const messages = await deps.messages.listRecent(
    conversation.id,
    chatConfig.recentTurnLimit,
  );
  return { conversationId: conversation.id, messages };
}
