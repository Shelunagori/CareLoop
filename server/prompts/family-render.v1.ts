import type { LlmMessage } from "@/server/adapters/openai/types";
import { serializeSharePayload, type SharePayload } from "@/core/share/payload";

/**
 * The family-message renderer (docs/04 section 11.4, docs/05 section 14.1 #3).
 *
 * This prompt exists in its own file, with its own version, because it is a
 * different call with a different contract from conversation: it has no
 * history, no memory, no tools, and exactly one job. Bump the version rather
 * than editing in place — a prompt change is a behaviour change, and the ref
 * is logged on every call so a regression is traceable to a diff.
 *
 * The renderer does NOT decide whether to reconnect, whether suppression
 * allows it, what facts may leave, or who the recipient is. All four were
 * settled before this string was built.
 */
export const familyRenderPromptV1 = {
  id: "family-render",
  version: "v1",
  ref: "family-render.v1",
  system: [
    "You turn a small structured record into ONE short, warm message that a",
    "family member will read. You are a renderer, not an author: everything",
    "you may say is already in the record.",
    "",
    "Write:",
    "- One or two short sentences, under 240 characters in total.",
    "- Plain text. No markdown, no links, no greetings by name, no sign-off.",
    "- Warm and ordinary, like a note passed between family.",
    "- End with the question the record asks for, as a real question.",
    "",
    "The record's fields mean:",
    "- fromDisplayName: what to call the person sending it.",
    "- aboutEntityName: someone or something the message may also mention.",
    "- topic: whether the question is about visiting or about a phone call.",
    "- question: ask_if_visiting = ask whether they can visit.",
    "             ask_if_calling  = ask whether they can telephone.",
    "- timeframe: when, if one is given. If absent, do not invent one.",
    "- freeNote: the sender's own words. Include them as written if present.",
    "",
    "Never:",
    "- Say or imply anything about anyone's mood, feelings, loneliness,",
    "  health, memory, wellbeing, or how they are coping.",
    "- Say or imply that contact has been missing, infrequent or overdue.",
    "- Give any number of days, weeks or months, or any date.",
    "- Explain why the message is being sent, or suggest a cause for anything.",
    "- Mention CareLoop, an app, a system, monitoring, or noticing.",
    "- Add any fact that is not in the record.",
    "",
    "Reply with the message text only.",
  ].join("\n"),
} as const;

/**
 * The COMPLETE runtime input to the family renderer.
 *
 * Exported and tested directly, because "the transcript is not in the prompt"
 * has to be an assertion over the actual bytes rather than a claim about the
 * call site. Note the shape: a system message and one user message built by
 * serializeSharePayload, which walks the field whitelist. There is no
 * parameter here through which conversation history could arrive.
 */
export function buildFamilyRenderMessages(payload: SharePayload): LlmMessage[] {
  return [
    { role: "system", content: familyRenderPromptV1.system },
    { role: "user", content: serializeSharePayload(payload) },
  ];
}
