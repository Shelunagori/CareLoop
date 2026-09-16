import { chatConfig } from "@/server/config";
import type { LlmProvider } from "@/server/adapters/openai/types";
import type { ConversationsRepo } from "@/server/repositories/conversations";
import type { JobsRepo } from "@/server/repositories/jobs";
import type { MessagesRepo, StoredMessage } from "@/server/repositories/messages";
import { assembleContext, EMPTY_MEMORY, type MemorySections } from "./context";
import type { ConsentOutcome, OfferResult } from "./consent";
import type { PendingClosure } from "./closure";

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

/**
 * The M5 hooks, injected rather than imported.
 *
 * A small interface instead of the whole consent service keeps this file
 * testable with literal objects, and keeps the hot path from depending on the
 * family loop's repositories. It is optional so an M1-shaped turn - no
 * opportunities, no closures - is byte-identical to what it was.
 */
export type ConsentTurnHooks = {
  readReply(input: {
    userId: string;
    text: string;
    grantingMessageId: string | null;
  }): Promise<ConsentOutcome>;
  prepareOffer(input: {
    userId: string;
    recentMessages: ReadonlyArray<{ role: string; content: string; createdAt: string }>;
  }): Promise<OfferResult>;
  loadClosure(input: { userId: string }): Promise<PendingClosure | null>;
  acknowledgeClosure(input: { closureId: string; messageId: string | null }): Promise<void>;
};

export type ConversationDeps = ConversationDataDeps & {
  llm: LlmProvider;
  jobs: JobsRepo;
  memory: MemoryLoader;
  consent?: ConsentTurnHooks;
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
  /**
   * M5: set when THIS turn approved a send. The route performs the send after
   * the response is flushed, so the outbound leg never delays a reply.
   */
  pendingSendOpportunityId: string | null;
  /** True when the turn was answered without calling the model at all. */
  deterministic: boolean;
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

  // 3. CONSENT FIRST. If exactly one offer is awaiting an answer, this turn
  //    may be that answer, and ordinary chat generation must not get the
  //    chance to swallow or reinterpret it. A clear yes or no is handled
  //    deterministically, with no model call at all.
  if (deps.consent) {
    const answered = await handleConsentTurn(deps, {
      userId: input.userId,
      conversationId: conversation.id,
      userMessageId: userMessage.id,
      text: input.text,
    });
    if (answered) return answered;
  }

  // 4. Bounded recent turns. This query already includes the message persisted
  //    in step 2 — it is the newest row — so it is NOT appended again.
  const recentTurns = await deps.messages.listRecent(
    conversation.id,
    chatConfig.recentTurnLimit,
  );

  // 5. Bounded memory retrieval (M2). A retrieval failure must not cost the
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

  // 6. M5 markers. The closure is news to deliver; the offer is a draft to
  //    show. BOTH are decided here, before the model is called, and both reach
  //    the model as markers only — the family reply's wording and the outbound
  //    draft's bytes are inserted by application code, never by generation.
  let closure: PendingClosure | null = null;
  let offer: OfferResult | null = null;
  if (deps.consent) {
    closure = await deps.consent.loadClosure({ userId: input.userId });
    offer = await deps.consent.prepareOffer({
      userId: input.userId,
      recentMessages: recentTurns,
    });
  }
  const presenting = offer && (offer.outcome === "offered" || offer.outcome === "represented")
    ? offer
    : null;

  // 7. Deterministic assembly.
  const context = assembleContext({
    recentTurns,
    memory: {
      ...memory,
      pendingClosure: closure?.marker ?? null,
      draftedOpportunityMarker: presenting
        ? { entityId: presenting.entityId, entityName: presenting.entityName, status: "drafted" }
        : null,
    },
  });

  // 8. Open the stream. A rejected key, quota error or connectivity failure
  //    rejects HERE, before any HTTP body has been written, so the route can
  //    still answer with a clean status code.
  const deltas = await deps.llm.streamChat({
    promptRef: context.promptRef,
    messages: context.messages,
  });

  return {
    conversationId: conversation.id,
    userMessageId: userMessage.id,
    pendingSendOpportunityId: null,
    deterministic: false,
    stream: persistOnSuccess(deps, deltas, {
      userId: input.userId,
      conversationId: conversation.id,
      userMessageId: userMessage.id,
      closureSentence: closure?.sentence ?? null,
      closureId: closure?.closureId ?? null,
      offerBlock: presenting?.block ?? null,
    }),
  };
}

/**
 * The deterministic consent leg.
 *
 * Returns a finished turn when the person's message was a clear answer to the
 * offer currently on the table, and null when it was not - in which case the
 * offer simply stands and the conversation carries on.
 */
async function handleConsentTurn(
  deps: ConversationDeps,
  input: {
    userId: string;
    conversationId: string;
    userMessageId: string;
    text: string;
  },
): Promise<TurnResult | null> {
  const outcome = await deps.consent!.readReply({
    userId: input.userId,
    text: input.text,
    grantingMessageId: input.userMessageId,
  });

  const reply =
    outcome.outcome === "approved" ||
    outcome.outcome === "declined" ||
    outcome.outcome === "unclear" ||
    outcome.outcome === "expired"
      ? outcome.reply
      : outcome.outcome === "integrity_failure"
        ? "Sorry — I'm not able to send that one. I'll leave it for now."
        : null;

  if (reply === null) return null;

  return {
    conversationId: input.conversationId,
    userMessageId: input.userMessageId,
    // The send runs after the response is flushed. Nothing outbound happens on
    // the hot path, and a notifier outage never costs the person their reply.
    pendingSendOpportunityId:
      outcome.outcome === "approved" ? outcome.opportunityId : null,
    deterministic: true,
    stream: persistOnSuccess(deps, deterministicDeltas(reply), {
      userId: input.userId,
      conversationId: input.conversationId,
      userMessageId: input.userMessageId,
      closureSentence: null,
      closureId: null,
      offerBlock: null,
    }),
  };
}

async function* deterministicDeltas(text: string): AsyncGenerator<string> {
  yield text;
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
  turn: {
    userId: string;
    conversationId: string;
    userMessageId: string;
    /** M5: a factual closure line, stated by the application, not the model. */
    closureSentence: string | null;
    closureId: string | null;
    /** M5: the verbatim offer block, appended after the model has finished. */
    offerBlock: string | null;
  },
): AsyncGenerator<string> {
  let full = "";

  if (turn.closureSentence !== null) {
    const lead = `${turn.closureSentence}\n\n`;
    full += lead;
    yield lead;
  }

  for await (const delta of deltas) {
    full += delta;
    yield delta;
  }

  if (full.trim().length === 0) throw new EmptyCompletionError();

  if (turn.offerBlock !== null) {
    // The exact stored draft, inserted by application code. The model has not
    // seen it and cannot have paraphrased it.
    const block = `\n\n${turn.offerBlock}`;
    full += block;
    yield block;
  }

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

  // Told once. The row records which message told them, so the companion
  // never repeats the news on a later turn.
  if (turn.closureId !== null && deps.consent) {
    await deps.consent.acknowledgeClosure({
      closureId: turn.closureId,
      messageId: assistantMessage.id,
    });
  }
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
