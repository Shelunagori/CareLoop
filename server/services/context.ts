import type { LlmMessage } from "@/server/adapters/openai/types";
import type { StoredMessage } from "@/server/repositories/messages";
import { conversationPromptV1 } from "@/server/prompts/conversation.v1";

/**
 * Deterministic context assembly (docs/01 §2.1 step 3). No LLM, no I/O — this
 * is a pure function over already-fetched rows, so what the model sees is
 * reviewable and testable without a database.
 *
 * M1 supplies EMPTY memory. The sections below are the seam M2 fills; they are
 * declared so the shape is fixed now, and deliberately not rendered, because a
 * half-built renderer for data that cannot exist yet is how "prepared" code
 * rots.
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

function isEmpty(memory: MemorySections): boolean {
  return (
    memory.profileCard === null &&
    memory.entityCards.length === 0 &&
    memory.episodes.length === 0 &&
    memory.pendingClosure === null &&
    memory.draftedOpportunityMarker === null
  );
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

  // Fail loudly rather than silently dropping memory a caller supplied. When
  // M2 adds retrieval it must add rendering in the same change.
  if (!isEmpty(memory)) {
    throw new Error(
      "assembleContext: memory rendering is not implemented until M2; " +
        "supplying populated MemorySections would silently drop them.",
    );
  }

  const turns: LlmMessage[] = input.recentTurns
    .filter((turn) => turn.role !== "system")
    .map((turn) => ({
      role: turn.role === "assistant" ? "assistant" : "user",
      content: turn.content,
    }));

  return {
    promptRef: conversationPromptV1.ref,
    messages: [
      { role: "system", content: conversationPromptV1.system },
      ...turns,
    ],
  };
}
