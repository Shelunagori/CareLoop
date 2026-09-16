import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/server/db/types.generated";

type Db = SupabaseClient<Database>;

export type ConversationRef = { id: string };

export type ConversationsRepo = {
  create(userId: string): Promise<ConversationRef>;
  /** Returns null when the conversation does not exist OR is not this user's. */
  findOwned(conversationId: string, userId: string): Promise<ConversationRef | null>;
  findLatest(userId: string): Promise<ConversationRef | null>;
  /** When this account's conversation history begins, or null. */
  earliestStartedAt(userId: string): Promise<string | null>;
};

export function conversationsRepo(db: Db): ConversationsRepo {
  return {
    async create(userId) {
      const { data, error } = await db
        .from("conversations")
        .insert({ user_id: userId })
        .select("id")
        .single();
      if (error) throw new Error(`createConversation failed: ${error.message}`);
      return { id: data.id };
    },

    async findOwned(conversationId, userId) {
      // Ownership is part of the WHERE clause, not a check after the fetch:
      // there is no code path that reads a conversation without scoping it.
      const { data, error } = await db
        .from("conversations")
        .select("id")
        .eq("id", conversationId)
        .eq("user_id", userId)
        .maybeSingle();
      if (error) throw new Error(`findOwned failed: ${error.message}`);
      return data ? { id: data.id } : null;
    },

    async findLatest(userId) {
      const { data, error } = await db
        .from("conversations")
        .select("id")
        .eq("user_id", userId)
        .order("started_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw new Error(`findLatest failed: ${error.message}`);
      return data ? { id: data.id } : null;
    },

    async earliestStartedAt(userId) {
      const { data, error } = await db
        .from("conversations")
        .select("started_at")
        .eq("user_id", userId)
        .order("started_at", { ascending: true })
        .limit(1)
        .maybeSingle();
      if (error) throw new Error(`earliestConversation failed: ${error.message}`);
      return data ? data.started_at : null;
    },
  };
}
