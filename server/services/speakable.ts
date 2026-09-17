import { chatConfig } from "@/server/config";
import {
  loadPendingOffer,
  type ConversationDataDeps,
} from "./conversation";
import { loadClosureById, type ClosureDeps } from "./closure";

/**
 * What text-to-speech is allowed to say (M8, architecture review).
 *
 * The browser is not authoritative about what CareLoop said. If the speak
 * endpoint accepted a string, then "only synthesize text that already exists
 * as user-visible CareLoop output" would be a claim about the client rather
 * than a property of the system - and anyone with a session could use
 * CareLoop's voice to say anything, including a sentence the person never
 * saw and never approved.
 *
 * So the client sends a REFERENCE to a server-owned object. This module
 * resolves it, proves it belongs to the caller, and derives the speakable text
 * from storage. The only strings that can ever reach the provider are ones
 * this file produced from a row.
 *
 * Each source resolves through the read model that already decides what is on
 * the person's screen, rather than a second view of it:
 *
 *   assistant_message - the persisted assistant turn, and only while it is
 *                       still within the visible transcript window.
 *   offer             - whatever `loadPendingOffer` says the card shows right
 *                       now, so a declined, expired or consumed reconnect is
 *                       as unspeakable as it is invisible.
 *   closure           - re-derived through the same deterministic renderer
 *                       that produced the sentence in the first place.
 */
export type SpeakableSource =
  | { type: "assistant_message"; id: string }
  | { type: "offer"; id: string }
  | { type: "closure"; id: string };

export type SpeakableDeps = ConversationDataDeps & ClosureDeps;

export type SpeakableResolution =
  | { outcome: "resolved"; text: string }
  /**
   * One outcome for "no such thing" and "not yours", deliberately. A caller
   * able to tell them apart could enumerate other people's messages.
   */
  | { outcome: "not_found" };

export async function resolveSpeakable(
  deps: SpeakableDeps,
  input: { userId: string; conversationId: string; source: SpeakableSource },
): Promise<SpeakableResolution> {
  // Ownership of the conversation first, always. Nothing below re-checks it,
  // because nothing below runs without it.
  const conversation = await deps.conversations.findOwned(input.conversationId, input.userId);
  if (!conversation) return { outcome: "not_found" };

  const { source } = input;

  if (source.type === "assistant_message") {
    // The window the chat page itself renders. A message too old to be on
    // screen is not "user-visible CareLoop output" any more, and this is the
    // same bounded read the page uses rather than a lookup by id.
    const visible = await deps.messages.listRecent(conversation.id, chatConfig.recentTurnLimit);
    const message = visible.find((row) => row.id === source.id);
    // The person's own words are never spoken back at them, whatever role the
    // client claimed: the role comes from the row.
    if (!message || message.role !== "assistant") return { outcome: "not_found" };
    return { outcome: "resolved", text: message.content };
  }

  if (source.type === "offer") {
    const pending = await loadPendingOffer(deps, input.userId);
    if (!pending || pending.opportunityId !== source.id) return { outcome: "not_found" };
    // The block, byte for byte, containing the stored draft byte for byte.
    // Consent attaches to those bytes; reading them aloud must not change one.
    return { outcome: "resolved", text: pending.block };
  }

  const closure = await loadClosureById(deps, {
    closureId: source.id,
    userId: input.userId,
  });
  return closure ? { outcome: "resolved", text: closure.sentence } : { outcome: "not_found" };
}
