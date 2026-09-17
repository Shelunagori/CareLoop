import { chatConfig } from "@/server/config";
import type { LlmProvider } from "@/server/adapters/openai/types";
import type { ConversationsRepo } from "@/server/repositories/conversations";
import type { JobsRepo } from "@/server/repositories/jobs";
import type { MessagesRepo, StoredMessage } from "@/server/repositories/messages";
import { assembleContext, EMPTY_MEMORY, type MemorySections } from "./context";
import type { ConsentOutcome, OfferResult } from "./consent";
import type { PendingClosure } from "./closure";
import type { OpportunitiesRepo } from "@/server/repositories/opportunities";
import type { EntitiesRepo } from "@/server/repositories/entities";
import type { ProfilesRepo } from "@/server/repositories/profiles";
import { buildOfferBlock } from "@/core/share/offer";

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
  /**
   * Read-only extras for the chat page. Optional so the hot path and every
   * existing test can construct this type without them.
   */
  opportunities?: Pick<OpportunitiesRepo, "listOpenForUser">;
  entities?: Pick<EntitiesRepo, "listForUser">;
  profiles?: ProfilesRepo;
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
  /**
   * REQUIRED here, though optional on the read model above.
   *
   * Every turn ends with a `state` event, and the browser treats it as the
   * server's closing word on the reconnect - including `null`, which retires
   * the card. Derived from these two. A turn path without them therefore ends
   * by announcing that nothing is on the table, and the card the same turn
   * just drew disappears a moment later while the opportunity stays open. It
   * was optional, the composition root did not pass it, and that is exactly
   * what happened (M8 regression 1). The type is what stops it recurring.
   */
  opportunities: Pick<OpportunitiesRepo, "listOpenForUser">;
  entities: Pick<EntitiesRepo, "listForUser">;
};

export type TurnInput = {
  /** Always resolved server-side from the session. Never from the request body. */
  userId: string;
  conversationId?: string;
  text: string;
};

/**
 * What a turn emits over the wire.
 *
 * TRANSPORT ONLY. The persisted assistant message is assembled from exactly
 * the same pieces, in exactly the same order, and is byte-identical to what it
 * was before this framing existed - so the M5 chain (stored == shown ==
 * approved == sent) is untouched and historical messages still render.
 *
 * The reason it is typed rather than a flat text stream: the browser must be
 * able to draw a reconnect card without READING the assistant's sentences to
 * work out that one is on the table. Recovering the recipient, the draft or
 * the consent state by parsing "I can send John…" would put the client in the
 * business of deciding policy from natural language, which is exactly the
 * inversion this architecture exists to avoid. The server already knows all
 * three; it now says so in a field.
 */
export type TurnEvent =
  | { type: "delta"; text: string }
  /** A factual closure line, stated by the application and never the model. */
  | { type: "closure"; sentence: string }
  | {
      type: "offer";
      opportunityId: string;
      entityName: string;
      /** The EXACT stored bytes. Never rebuilt, never reformatted. */
      renderedText: string;
      /** The verbatim block as it is persisted into the message text. */
      block: string;
    }
  /**
   * The last event of every turn: what the reconnect looks like NOW.
   *
   * The browser replaces whatever card it was showing with exactly this, so a
   * card cannot outlive the state it describes. Live acceptance found one that
   * did - "Approved - on its way to John" was still on screen after John had
   * replied - because the terminal state lived in the client, where nothing
   * could correct it. It is the server's to say, every turn.
   */
  /**
   * The turn's closing word. `messageId` is the persisted assistant message,
   * which is what text-to-speech refers to: speech names a server-owned
   * object rather than carrying a sentence, so the browser never gets to say
   * what CareLoop said (M8).
   */
  | { type: "state"; pendingOffer: PendingOffer | null; messageId: string };

export type TurnResult = {
  conversationId: string;
  userMessageId: string;
  /** Yields typed turn events; persists the assistant message on success. */
  stream: AsyncIterable<TurnEvent>;
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
      offer: presenting,
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
      offer: null,
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
    /** M5: the offer, appended verbatim after the model has finished. */
    offer: OfferResult & { outcome: "offered" | "represented" } | null;
  },
): AsyncGenerator<TurnEvent> {
  let full = "";

  if (turn.closureSentence !== null) {
    // The persisted text is unchanged - lead sentence, blank line, then the
    // model's reply. The event merely lets the browser show it as an update
    // rather than as the opening words of a paragraph.
    full += `${turn.closureSentence}\n\n`;
    yield { type: "closure", sentence: turn.closureSentence };
  }

  for await (const delta of deltas) {
    full += delta;
    yield { type: "delta", text: delta };
  }

  if (full.trim().length === 0) throw new EmptyCompletionError();

  if (turn.offer !== null) {
    // The exact stored draft, inserted by application code. The model has not
    // seen it and cannot have paraphrased it. The BLOCK still goes into the
    // persisted message byte for byte; the event carries the same bytes in
    // fields so the browser can draw a card instead of a paragraph.
    full += `\n\n${turn.offer.block}`;
    yield {
      type: "offer",
      opportunityId: turn.offer.opportunityId,
      entityName: turn.offer.entityName,
      renderedText: turn.offer.renderedText,
      block: turn.offer.block,
    };
  }

  const assistantMessage = await deps.messages.insert({
    conversationId: turn.conversationId,
    role: "assistant",
    content: full,
  });

  // Read AFTER the turn's own writes, so an approval made moments ago is
  // reflected rather than the state as it was when the turn began.
  yield {
    type: "state",
    pendingOffer: await loadPendingOffer(deps, turn.userId),
    messageId: assistantMessage.id,
  };

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

/**
 * An offer the SERVER says is currently on the table.
 *
 * Derived from the opportunity row, not from the transcript. A reload must
 * show the same card the stream drew, and the only trustworthy source for
 * "is an offer open, for whom, and with which exact words" is the row that
 * `markOffered` wrote.
 */
/**
 * How far along this reconnect is, as the SERVER sees it.
 *
 * `offered`  - waiting for the person's answer. The only actionable state.
 * `sending`  - they approved; the outbound leg runs after the reply is
 *              flushed, so for that moment there is a real thing in flight.
 *
 * There is deliberately no state beyond these two. Once the request is
 * authorized and the opportunity is consumed, the reconnect is no longer
 * something the person can act on or is waiting on in the chat - the
 * conversation itself carries the news, and a card that lingers can only say
 * something that has stopped being true.
 */
export type PendingOfferState = "offered" | "sending";

export type PendingOffer = {
  opportunityId: string;
  entityName: string;
  state: PendingOfferState;
  /** The EXACT stored bytes. */
  renderedText: string;
  /** The verbatim block as it appears at the end of the assistant message. */
  block: string;
};

export type ConversationView = {
  conversationId: string | null;
  messages: StoredMessage[];
  /** null when nothing is awaiting an answer. */
  pendingOffer: PendingOffer | null;
  /** The person's own label, when they have one. Never invented. */
  displayName: string | null;
};

/** Read model for the chat page. */
export async function loadConversationView(
  deps: ConversationDataDeps,
  userId: string,
): Promise<ConversationView> {
  const [conversation, displayName, pendingOffer] = await Promise.all([
    deps.conversations.findLatest(userId),
    loadDisplayName(deps, userId),
    loadPendingOffer(deps, userId),
  ]);

  if (!conversation) {
    return { conversationId: null, messages: [], pendingOffer, displayName };
  }

  const messages = await deps.messages.listRecent(
    conversation.id,
    chatConfig.recentTurnLimit,
  );
  return { conversationId: conversation.id, messages, pendingOffer, displayName };
}

async function loadDisplayName(
  deps: ConversationDataDeps,
  userId: string,
): Promise<string | null> {
  if (!deps.profiles) return null;
  const profile = await deps.profiles.find(userId);
  const name = profile?.displayName?.trim();
  // A greeting with a blank name in it is worse than no greeting.
  return name && name.length > 0 ? name : null;
}

export async function loadPendingOffer(
  deps: ConversationDataDeps,
  userId: string,
): Promise<PendingOffer | null> {
  if (!deps.opportunities || !deps.entities) return null;

  // `listOpenForUser` returns pre-terminal statuses only, which is exactly the
  // window a card may describe. `declined`, `expired` and `consumed` are not
  // open, so a resolved reconnect produces no card at all - including one
  // whose family member has already replied.
  const open = await deps.opportunities.listOpenForUser(
    userId,
    chatConfig.pendingOfferScanLimit,
  );

  // `offered` first: an answer the person still owes outranks one in flight.
  // `drafted` has not been shown to anyone and must not appear as a card.
  const current =
    open.find((row) => row.status === "offered") ?? open.find((row) => row.status === "approved");
  if (!current || current.renderedText === null) return null;

  const entities = await deps.entities.listForUser(userId, chatConfig.pendingOfferScanLimit);
  const entityName = entities.find((row) => row.id === current.entityId)?.displayName;
  if (!entityName) return null;

  return {
    opportunityId: current.id,
    entityName,
    state: current.status === "offered" ? "offered" : "sending",
    renderedText: current.renderedText,
    block: buildOfferBlock({ entityName, renderedText: current.renderedText }),
  };
}
