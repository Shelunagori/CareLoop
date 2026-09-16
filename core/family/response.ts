import { z } from "zod";
import type { ShareTopic } from "@/core/share/payload";

/**
 * The family member's reply.
 *
 * Bounded choices, not free text, for the first slice. That is a privacy and a
 * determinism decision at once: a fixed vocabulary needs no model to interpret
 * it, so there is no call, no prompt and no place for the older adult's
 * conversation to leak into a parse. M5 therefore adds ZERO new LLM calls.
 *
 * The free-text seam is declared below and deliberately not implemented.
 */
/**
 * TOPIC-NEUTRAL by construction.
 *
 * An earlier revision used `visiting` / `not_visiting` and reused them for a
 * phone call, which put visit semantics into a field that is answered for
 * every topic. A family member tapping "yes" to a call request was recorded as
 * `visiting`, and every reader downstream then had to remember that the name
 * lies. The answer is a bare polarity; the TOPIC supplies the verb, once, at
 * render time. Adding a third topic later needs no new intent.
 */
export const FAMILY_REPLY_INTENTS = ["yes", "no", "unsure", "other"] as const;

export type FamilyReplyIntent = (typeof FAMILY_REPLY_INTENTS)[number];

export const FamilyReplySchema = z.object({
  intent: z.enum(FAMILY_REPLY_INTENTS),
  timeframe: z.string().min(1).max(40).optional(),
  shortSummary: z.string().min(1).max(200).optional(),
});

export type FamilyReply = z.infer<typeof FamilyReplySchema>;

export type FamilyReplyChoice = {
  /** Submitted by the form. The only value the endpoint accepts. */
  id: string;
  /** What the family member reads on the button. */
  label: string;
  intent: FamilyReplyIntent;
  timeframe?: string;
};

/**
 * The LABELS are topic-specific, because a family member should read a
 * sentence about the thing they were actually asked. The INTENTS are not: what
 * is stored is the polarity, and the topic on the opportunity supplies the
 * verb when the closure is rendered.
 */
export function replyChoicesFor(topic: ShareTopic): FamilyReplyChoice[] {
  if (topic === "call") {
    return [
      { id: "yes_soon", label: "Yes, I'll give them a call soon.", intent: "yes", timeframe: "soon" },
      { id: "unsure", label: "Not sure yet.", intent: "unsure" },
      { id: "no", label: "Not just now.", intent: "no" },
    ];
  }
  return [
    { id: "yes_weekend", label: "Yes, we're visiting this weekend.", intent: "yes", timeframe: "this weekend" },
    { id: "yes_soon", label: "Yes, we'll visit soon.", intent: "yes", timeframe: "soon" },
    { id: "unsure", label: "Not sure yet.", intent: "unsure" },
    { id: "no", label: "No, not this weekend.", intent: "no" },
  ];
}

export function findReplyChoice(topic: ShareTopic, id: string): FamilyReplyChoice | null {
  return replyChoicesFor(topic).find((choice) => choice.id === id) ?? null;
}

/**
 * The free-text seam (this milestone's section 14). DECLARED, NOT IMPLEMENTED.
 *
 * If free text is ever accepted, an isolated call parses the FAMILY REPLY AND
 * NOTHING ELSE into the schema above - no older-adult transcript, no memory,
 * no baseline in its context - and the deterministic layer still decides every
 * side effect. On a parse failure the fallback is to relay the family member's
 * own words verbatim, which is safe because they wrote them knowing they would
 * be passed on.
 */
export interface FamilyReplyParser {
  parse(input: { reply: string }): Promise<FamilyReply>;
}
