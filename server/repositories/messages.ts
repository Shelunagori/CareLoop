import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/server/db/types.generated";

type Db = SupabaseClient<Database>;
type MessageRole = Database["public"]["Enums"]["message_role"];

export type StoredMessage = {
  id: string;
  role: MessageRole;
  content: string;
  createdAt: string;
};

export type MessagesRepo = {
  insert(input: {
    conversationId: string;
    role: MessageRole;
    content: string;
  }): Promise<StoredMessage>;
  /** Oldest-first, capped at `limit` most recent messages. */
  listRecent(conversationId: string, limit: number): Promise<StoredMessage[]>;
  /** Used by post-turn ingestion to load the message a job refers to. */
  findById(id: string): Promise<StoredMessage | null>;
};

export function messagesRepo(db: Db): MessagesRepo {
  return {
    async insert({ conversationId, role, content }) {
      const { data, error } = await db
        .from("messages")
        .insert({ conversation_id: conversationId, role, content })
        .select("id, role, content, created_at")
        .single();
      if (error) throw new Error(`insertMessage failed: ${error.message}`);
      return {
        id: data.id,
        role: data.role,
        content: data.content,
        createdAt: data.created_at,
      };
    },

    async findById(id) {
      const { data, error } = await db
        .from("messages")
        .select("id, role, content, created_at")
        .eq("id", id)
        .maybeSingle();
      if (error) throw new Error(`findMessage failed: ${error.message}`);
      return data
        ? { id: data.id, role: data.role, content: data.content, createdAt: data.created_at }
        : null;
    },

    async listRecent(conversationId, limit) {
      // Newest-first with a LIMIT so the database does the bounding, then
      // reversed here: the model must see the turns in the order they happened.
      const { data, error } = await db
        .from("messages")
        .select("id, role, content, created_at")
        .eq("conversation_id", conversationId)
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(limit);
      if (error) throw new Error(`listRecent failed: ${error.message}`);
      return (data ?? [])
        .map((row) => ({
          id: row.id,
          role: row.role,
          content: row.content,
          createdAt: row.created_at,
        }))
        .reverse();
    },
  };
}
