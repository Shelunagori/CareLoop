import type { ClosureMarker } from "@/core/family/closure";
import type { LlmMessage } from "@/server/adapters/openai/types";
import type { StoredMessage } from "@/server/repositories/messages";
import { conversationPromptV3 } from "@/server/prompts/conversation.v3";

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

export type MemorySections = {
  /** M2: stable user facts, budgeted ~250 tokens. */
  profileCard: string | null;
  /** M2: entities mentioned this turn or active recently. */
  entityCards: readonly string[];
  /** M2: top-k hybrid-scored episodes. */
  episodes: readonly string[];
  /**
   * M5: a family member has replied and the companion is about to say so.
   * A marker, not the reply text — the application states the news itself, in
   * a deterministic factual sentence.
   */
  pendingClosure: ClosureMarker | null;
  /** F1/E1: marker ONLY. Never rendered_text, never the SharePayload. */
  draftedOpportunityMarker: DraftedOpportunityMarker | null;
};

export const EMPTY_MEMORY: MemorySections = {
  profileCard: null,
  entityCards: [],
  episodes: [],
  pendingClosure: null,
  draftedOpportunityMarker: null,
} as const;

function hasMemory(memory: MemorySections): boolean {
  return (
    memory.profileCard !== null ||
    memory.entityCards.length > 0 ||
    memory.episodes.length > 0 ||
    memory.pendingClosure !== null ||
    memory.draftedOpportunityMarker !== null
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

  if (memory.episodes.length > 0) {
    blocks.push("", "Things they have told you about before:");
    blocks.push(...memory.episodes);
  }

  if (memory.pendingClosure) blocks.push(...renderClosure(memory.pendingClosure));
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
    { role: "system", content: conversationPromptV3.system },
  ];
  if (hasMemory(memory)) {
    system.push({ role: "system", content: renderMemory(memory) });
  }

  return {
    promptRef: conversationPromptV3.ref,
    messages: [...system, ...turns],
  };
}
