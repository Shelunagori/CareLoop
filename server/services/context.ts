import type { LlmMessage } from "@/server/adapters/openai/types";
import type { StoredMessage } from "@/server/repositories/messages";
import { conversationPromptV1 } from "@/server/prompts/conversation.v1";

/**
 * Deterministic context assembly (docs/01 §2.1 step 3). No LLM, no I/O — this
 * is a pure function over already-fetched rows, so what the model sees is
 * reviewable and testable without a database.
 *
 * M2 fills profileCard, entityCards and episodes with real retrieved memory.
 * pendingClosure and draftedOpportunityMarker remain unfilled seams for M4/M5
 * and are still refused rather than half-rendered.
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
  /** M5: an outstanding promise that must be surfaced. */
  pendingClosure: string | null;
  /** F1: marker ONLY. Never rendered_text, never the SharePayload. */
  draftedOpportunityMarker: DraftedOpportunityMarker | null;
};

export const EMPTY_MEMORY: MemorySections = {
  profileCard: null,
  entityCards: [],
  episodes: [],
  pendingClosure: null,
  draftedOpportunityMarker: null,
} as const;

/** Sections whose renderer does not exist yet (M4/M5). */
function hasUnimplementedSections(memory: MemorySections): boolean {
  return memory.pendingClosure !== null || memory.draftedOpportunityMarker !== null;
}

function hasMemory(memory: MemorySections): boolean {
  return (
    memory.profileCard !== null ||
    memory.entityCards.length > 0 ||
    memory.episodes.length > 0
  );
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

  // Fail loudly rather than silently dropping a section whose renderer does
  // not exist yet. Whoever adds retrieval for these must add rendering in the
  // same change.
  if (hasUnimplementedSections(memory)) {
    throw new Error(
      "assembleContext: pendingClosure and draftedOpportunityMarker are not " +
        "rendered until M4/M5; supplying them would silently drop them.",
    );
  }

  const turns: LlmMessage[] = input.recentTurns
    .filter((turn) => turn.role !== "system")
    .map((turn) => ({
      role: turn.role === "assistant" ? "assistant" : "user",
      content: turn.content,
    }));

  // The base prompt is never mutated. Memory is appended as a second system
  // message so an empty-memory turn is byte-identical to M1.
  const system: LlmMessage[] = [
    { role: "system", content: conversationPromptV1.system },
  ];
  if (hasMemory(memory)) {
    system.push({ role: "system", content: renderMemory(memory) });
  }

  return {
    promptRef: conversationPromptV1.ref,
    messages: [...system, ...turns],
  };
}
