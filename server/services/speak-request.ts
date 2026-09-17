import { z } from "zod";

/**
 * Wire contract for POST /api/voice/speak.
 *
 * Note the absence of a `text` field, and the `.strict()` that makes that
 * absence enforceable rather than decorative. The browser names an OBJECT the
 * server already produced and showed; the server resolves it and derives the
 * words. There is no parameter through which a sentence could arrive, so
 * "CareLoop only speaks what CareLoop said" is a property of the schema rather
 * than a convention the client is trusted to follow.
 *
 * Same reasoning as ChatRequestSchema's missing user_id: the browser cannot
 * name a user, and it cannot name a sentence either.
 */
export const SpeakSourceSchema = z
  .object({
    type: z.enum(["assistant_message", "offer", "closure"]),
    id: z.string().uuid(),
  })
  .strict();

export const SpeakRequestSchema = z
  .object({
    conversationId: z.string().uuid(),
    source: SpeakSourceSchema,
  })
  .strict();

export type SpeakRequest = z.infer<typeof SpeakRequestSchema>;
