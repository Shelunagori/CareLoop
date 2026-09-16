import { z } from "zod";
import {
  CLOSED_RECONNECT_QUESTIONS,
  type ClosedReconnectQuestion,
} from "@/core/detection/proposal";

/**
 * The SharePayload (docs/04 section 11.4).
 *
 * The complete set of fields that may ever leave the private conversation.
 * Not "the fields we currently choose to send" — the fields the type can hold.
 * The family-render call is constructed from this and nothing else, so the
 * transcript is not merely withheld from the prompt, it is not in the reach of
 * the code that builds the prompt.
 *
 * Deliberately absent, and worth naming because each was tempting: the
 * recipient's own name (they know who they are), how many days it has been,
 * the baseline statistics, the signal explanation, the observation, any
 * episode text, any identifier at all.
 */
export type ShareTopic = "visit" | "call";

export type SharePayload = {
  /** The user's chosen label for themselves — "Dad" — not their account name. */
  fromDisplayName: string;
  /** A third party the message may mention, e.g. the dog. */
  aboutEntityName?: string;
  topic: ShareTopic;
  timeframe?: string;
  question: ClosedReconnectQuestion;
  /** ONLY ever the user's own dictated words. Never model output. */
  freeNote?: string;
};

/** The whitelist, as a value. Serialization iterates THIS, not Object.keys. */
export const SHARE_PAYLOAD_FIELDS = [
  "fromDisplayName",
  "aboutEntityName",
  "topic",
  "timeframe",
  "question",
  "freeNote",
] as const satisfies ReadonlyArray<keyof SharePayload>;

/**
 * The exact bytes handed to the renderer.
 *
 * Field-by-field over the whitelist rather than JSON.stringify of the object:
 * if someone later widens the type, or a payload arrives from storage with an
 * extra key, the extra key cannot ride along into the prompt. Stable key
 * order, so the prompt is snapshot-testable.
 */
export function serializeSharePayload(payload: SharePayload): string {
  const lines: string[] = [];
  for (const field of SHARE_PAYLOAD_FIELDS) {
    const value = payload[field];
    if (value === undefined || value === null) continue;
    lines.push(`${field}: ${String(value)}`);
  }
  return lines.join("\n");
}

/**
 * Read-side validation for a stored payload. `.strict()` is the point: a
 * stored object carrying a key outside the whitelist is REJECTED rather than
 * quietly narrowed, because such a key could only have arrived by a code path
 * that bypassed minimize().
 */
export const SharePayloadSchema = z
  .object({
    fromDisplayName: z.string().min(1),
    aboutEntityName: z.string().min(1).optional(),
    topic: z.enum(["visit", "call"]),
    timeframe: z.string().min(1).optional(),
    question: z.enum(CLOSED_RECONNECT_QUESTIONS),
    freeNote: z.string().min(1).optional(),
  })
  .strict();
