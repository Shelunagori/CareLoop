import "server-only";
import { createOpenAiLlm } from "@/server/adapters/openai/llm";
import { createServiceRoleClient } from "@/server/db/client";
import { conversationsRepo } from "@/server/repositories/conversations";
import { messagesRepo } from "@/server/repositories/messages";
import type {
  ConversationDataDeps,
  ConversationDeps,
} from "./conversation";

/**
 * Composition root. Kept apart from conversation.ts so the service — and its
 * tests — never import the OpenAI SDK, the service-role key, or `server-only`.
 */
export function createConversationDataDeps(): ConversationDataDeps {
  const db = createServiceRoleClient();
  return { conversations: conversationsRepo(db), messages: messagesRepo(db) };
}

/** Adds the model. Only request paths that actually generate need this. */
export function createConversationDeps(): ConversationDeps {
  return { ...createConversationDataDeps(), llm: createOpenAiLlm() };
}
