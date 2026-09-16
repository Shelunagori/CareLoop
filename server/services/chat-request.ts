import { z } from "zod";
import { chatConfig } from "@/server/config";

/**
 * Wire contract for POST /api/chat.
 *
 * Note the absence of a user_id: the browser cannot name a user. Identity is
 * resolved from the session server-side on every request.
 */
export const ChatRequestSchema = z.object({
  conversationId: z.string().uuid().optional(),
  text: z.string().trim().min(1).max(chatConfig.maxMessageLength),
});

export type ChatRequest = z.infer<typeof ChatRequestSchema>;
