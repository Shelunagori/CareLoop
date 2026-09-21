import type { ClosureMarker } from "@/core/family/closure";
import type { LlmMessage } from "@/server/adapters/openai/types";
import type { StoredMessage } from "@/server/repositories/messages";
import { conversationPromptV6 } from "@/server/prompts/conversation.v6";

/**
 * Deterministic context assembly (docs/01 §2.1 step 3). No LLM, no I/O — this
 * is a pure function over already-fetched rows, so what the model sees is
 * reviewable and testable without a database.
 *
 * M2 fills profileCard, entityCards and episodes with real retrieved memory.
 * M5 fills the last two, and both are deliberately THIN: a closure marker and
 * a drafted-opportunity marker, never the family member's words and never the
 * outbound draft.
 */
export type DraftedOpportunityMarker = {
  entityId: string;
  entityName: string;
  status: "drafted";
};

/**
 * A message was sent and no reply has come. APPLICATION-DERIVED, from a
 * delivered request with no response row.
 *
 * The counterpart to `pendingClosure`, and the one that was missing. Without
 * it the model was told when a reply had arrived and told nothing at all when
 * one had not - so "has John replied?" was answered from silence, and a model
 * answering from silence invents.
 */
export type AwaitingFamilyReplyMarker = {
  entityName: string;
  status: "awaiting_response";
};

export type MemorySections = {
  /** M2: stable user facts, budgeted ~250 tokens. */
  profileCard: string | null;
  /** M2: entities mentioned this turn or active recently. */
  entityCards: readonly string[];
  /**
   * M12d: which of those the person named IN THIS MESSAGE.
   *
   * `selectEntities` has always computed this — it is how mentioned entities
   * get sorted to the front — and then thrown it away, so the model received
   * "John" and "Margaret" in one undifferentiated list and could not tell
   * who had just been brought up from who was merely active last Tuesday.
   *
   * That is why "John called yesterday" got "That's nice to hear.": the card
   * was there, the signal that it MATTERED right now was not.
   *
   * Names only, and only names already in the cards above. It adds no fact,
   * it points at one.
   */
  mentionedNow: readonly string[];
  /** M2: top-k hybrid-scored episodes. */
  episodes: readonly string[];
  /**
   * M5: a family member has replied and the companion is about to say so.
   * A marker, not the reply text — the application states the news itself, in
   * a deterministic factual sentence.
   */
  pendingClosure: ClosureMarker | null;
  /**
   * P0: a sent message with no reply yet. A NAME and a STATE - never the
   * address, the token, the request id, the payload or the message text.
   */
  awaitingFamilyReply: AwaitingFamilyReplyMarker | null;
  /** F1/E1: marker ONLY. Never rendered_text, never the SharePayload. */
  draftedOpportunityMarker: DraftedOpportunityMarker | null;
  /**
   * M12e: the person said IN THIS MESSAGE that they were unwell.
   *
   * A boolean, because that is the whole of what the application knows and
   * the whole of what it is willing to assert. It is set by a deterministic
   * phrase rule over the person's own sentence
   * (`core/wellbeing/self-report.ts`) — never by the model, never by a
   * classifier, and never from tone. There is no severity field, no
   * duration, no symptom and no trend, so there is nowhere for a clinical
   * claim to be written even by accident.
   */
  selfReportedWellbeing: boolean;
};

export const EMPTY_MEMORY: MemorySections = {
  profileCard: null,
  entityCards: [],
  mentionedNow: [],
  episodes: [],
  pendingClosure: null,
  awaitingFamilyReply: null,
  draftedOpportunityMarker: null,
  selfReportedWellbeing: false,
} as const;

function hasMemory(memory: MemorySections): boolean {
  return (
    memory.profileCard !== null ||
    memory.entityCards.length > 0 ||
    memory.episodes.length > 0 ||
    memory.pendingClosure !== null ||
    memory.awaitingFamilyReply !== null ||
    memory.draftedOpportunityMarker !== null ||
    memory.selfReportedWellbeing
  );
}

/**
 * The closure marker (this milestone's section 23).
 *
 * Four fields: who replied, what they answered, and when. Not their sentence,
 * not the request, not the draft. The companion is told the news has ALREADY
 * been stated by the application, so it neither repeats it nor embroiders it.
 */
function renderClosure(marker: ClosureMarker): string[] {
  const answer =
    marker.response === "yes"
      ? "said yes"
      : marker.response === "no"
        ? "said not this time"
        : marker.response === "unsure"
          ? "said they are not sure yet"
          : "replied";
  const when = marker.timeframe ? ` (${marker.timeframe})` : "";
  return [
    "",
    `${marker.entityName} has replied to the message you sent, and ${answer}${when}.`,
    "You have ALREADY told them this, in the first line of your reply. Do not",
    "repeat it, do not add detail, and do not guess how anyone feels about it.",
    "Simply respond warmly to whatever they say about it.",
    // The live failure this exists to stop: the verified update and "I'll let
    // you know when John replies" arriving in the same turn. The marker said a
    // reply had come; it did not say the waiting was therefore over, and a
    // model that has been promising to pass on an answer keeps promising it.
    "This reply has ARRIVED. The waiting is over: nothing is still outstanding",
    `about this message, because ${marker.entityName} has already answered it.`,
    "Do not say you will let them know when there is news, do not say you are",
    "still waiting to hear, and do not say you have not heard yet. All three",
    "are now false.",
  ];
}

/**
 * The awaiting-reply marker.
 *
 * Phrased as a fact and then as an instruction, because the fact alone was not
 * enough: a model that knows a message was sent will happily narrate what came
 * back. The sentence it is allowed to say is spelled out so that answering
 * honestly is the easiest thing to do, not a gap it has to be disciplined out
 * of filling.
 */
function renderAwaitingReply(marker: AwaitingFamilyReplyMarker): string[] {
  return [
    "",
    `A message was sent to ${marker.entityName}. NO reply has been recorded.`,
    `This is the app's own record, and it is complete: if ${marker.entityName}`,
    "had answered, it would say so here. It does not.",
    `So ${marker.entityName} has NOT replied, has NOT said anything, has NOT`,
    "agreed to anything and has NOT declined. If they ask whether there is any",
    "news, tell them warmly that you have not heard back yet. Do not invent a",
    "reply, do not guess what the answer might be, and do not soften the wait",
    "by hinting that one is on its way.",
  ];
}

/**
 * The drafted-opportunity marker (E1, docs/05 section 14.4).
 *
 * The model's job at this point is to judge the moment and optionally write a
 * lead-in sentence — neither of which needs the message body. Handing it the
 * body would create the possibility of paraphrase in the one place where
 * paraphrase breaks consent. Withholding it removes that possibility at every
 * temperature and under any injection in the person's own speech, which an
 * instruction cannot do.
 */
function renderDraftedMarker(marker: DraftedOpportunityMarker): string[] {
  return [
    "",
    `There is a message ready to send to ${marker.entityName}, waiting to be offered.`,
    "It will be shown to them word for word by the app, immediately after your",
    "reply. You have NOT been given its wording and must not invent, quote,",
    "summarize or promise anything about what it says. At most, write one short",
    "natural sentence leading into it.",
  ];
}

/**
 * Curated memory, never raw rows. The framing matters as much as the content:
 * the companion must treat this as background it already knows, and must not
 * read anything into it beyond what it says.
 */
function renderMemory(memory: MemorySections): string {
  const blocks: string[] = [
    "Background you already know about this person. Use it naturally when it",
    "is relevant, the way a friend would. Do not recite it, do not mention",
    "that you have notes, and do not infer anything beyond what is written.",
  ];

  if (memory.profileCard) blocks.push("", memory.profileCard);

  if (memory.entityCards.length > 0) {
    blocks.push("", "People and pets in their life:");
    for (const card of memory.entityCards) blocks.push("", card);
  }

  /**
   * WHO THEY JUST NAMED. One line, and the only positive instruction in this
   * block — everything else here is a boundary.
   *
   * It says who, not what to say about them: the follow-up is the model's to
   * write and the card above is all it has to write from. Nothing is added
   * that the cards do not already contain.
   */
  if (memory.mentionedNow.length > 0) {
    blocks.push(
      "",
      `They have just mentioned ${memory.mentionedNow.join(" and ")} in this message.`,
      "Respond to that as a friend would: acknowledge the person they named,",
      "and if a question is natural, ask ONE about what they told you. Do not",
      "list what you know about them, and do not mention anything above that",
      "they did not bring up.",
    );
  }

  /**
   * NOBODY THEY KNOW WAS NAMED — and that is a fact worth stating.
   *
   * Observed: "Don sent me a message today" got "Did you hear from John?".
   * Don did not exist yet (extraction runs after the turn, so a name's first
   * mention can never have a card), while John did and was sitting in the
   * recently-active cards above. The model was handed a page about John and
   * nothing about Don, and it wrote about John. The cards were background;
   * with nothing else in view they read as an agenda.
   *
   * So the silence is made explicit. This is the mirror of the block above
   * and is emitted only when there ARE cards, because with no cards there is
   * nothing to be pulled towards.
   */
  if (memory.mentionedNow.length === 0 && memory.entityCards.length > 0) {
    blocks.push(
      "",
      "They have NOT named anyone above in this message. Answer what they",
      "actually said. Do not bring up anyone or anything from these notes",
      "that they did not raise — not as a question, not as a change of",
      "subject, not as a way to fill a pause. If they named somebody you",
      "have no note about, that is ordinary: use the name they used, ask",
      "about what they told you, and do not substitute a name you do know.",
    );
  }

  /**
   * THEY SAID THEY WERE UNWELL (M12e).
   *
   * The application has established the fact — deterministically, from their
   * own words — and this tells the model what to DO with it, which is the
   * smallest, most ordinary thing: say you are sorry, ask one gentle
   * question, and stay there.
   *
   * Every line below the first is a boundary, because this is the topic on
   * which a warm model is most likely to overreach: it must not name a
   * condition, estimate severity, offer advice, or decide this is the moment
   * to mention the daughter. The last of those is the observed failure and
   * is also covered by the block above; it is repeated here because a
   * wellbeing turn is exactly when a "helpful" pivot feels most natural.
   */
  if (memory.selfReportedWellbeing) {
    blocks.push(
      "",
      "In this message they have said they were unwell or in pain. Say you",
      "are sorry to hear it, in your own words, and ask ONE gentle question",
      "about it — whether they are feeling better now, or what was bothering",
      "them. Then stop and let them answer.",
      "Stay on what they said. Do not name a condition, do not guess a",
      "cause, do not judge how serious it is, do not give medical or",
      "practical advice, and do not tell them what they must be feeling.",
      "Do not change the subject to anyone in the notes above, and do not",
      "offer to tell anybody — if that is appropriate, this application",
      "asks, not you.",
    );
  }

  if (memory.episodes.length > 0) {
    blocks.push("", "Things they have told you about before:");
    blocks.push(...memory.episodes);
  }

  if (memory.pendingClosure) blocks.push(...renderClosure(memory.pendingClosure));
  /**
   * Never both. A closure means a reply just arrived; saying in the same
   * breath that none has would be the contradiction this whole fix is about.
   * The closure wins, and the repository cannot produce both anyway - an
   * answered request is no longer `delivered`.
   */
  if (!memory.pendingClosure && memory.awaitingFamilyReply) {
    blocks.push(...renderAwaitingReply(memory.awaitingFamilyReply));
  }
  if (memory.draftedOpportunityMarker) {
    blocks.push(...renderDraftedMarker(memory.draftedOpportunityMarker));
  }

  return blocks.join("\n");
}

export type AssembledContext = {
  promptRef: string;
  messages: LlmMessage[];
};

export function assembleContext(input: {
  recentTurns: readonly StoredMessage[];
  memory?: MemorySections;
}): AssembledContext {
  const memory = input.memory ?? EMPTY_MEMORY;

  const turns: LlmMessage[] = input.recentTurns
    .filter((turn) => turn.role !== "system")
    .map((turn) => ({
      role: turn.role === "assistant" ? "assistant" : "user",
      content: turn.content,
    }));

  // The base prompt is never mutated. Memory is appended as a second system
  // message so an empty-memory turn is byte-identical to M1.
  const system: LlmMessage[] = [
    { role: "system", content: conversationPromptV6.system },
  ];
  if (hasMemory(memory)) {
    system.push({ role: "system", content: renderMemory(memory) });
  }

  return {
    promptRef: conversationPromptV6.ref,
    messages: [...system, ...turns],
  };
}
