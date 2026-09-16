import type { Database } from "@/server/db/types.generated";
import type { Db } from "./db";

type EntityType = Database["public"]["Enums"]["entity_type"];
type EntityStatus = Database["public"]["Enums"]["entity_status"];

export type EntityRecord = {
  id: string;
  type: EntityType;
  subtype: string | null;
  displayName: string;
  aliases: string[];
  status: EntityStatus;
  lastMentionedAt: string | null;
};

export type EntitiesRepo = {
  /** The user's whole cast of characters. Small by nature; bounded anyway. */
  listForUser(userId: string, limit: number): Promise<EntityRecord[]>;
  listRecentlyMentioned(userId: string, sinceIso: string, limit: number): Promise<EntityRecord[]>;
  create(input: {
    userId: string;
    type: EntityType;
    subtype: string | null;
    displayName: string;
  }): Promise<EntityRecord>;
  addAlias(id: string, alias: string, currentAliases: readonly string[]): Promise<void>;
  touchMention(id: string, at: string): Promise<void>;
  flagNeedsConfirmation(id: string): Promise<void>;
};

const SELECT = "id, type, subtype, display_name, aliases, status, last_mentioned_at";

type Row = {
  id: string;
  type: EntityType;
  subtype: string | null;
  display_name: string;
  aliases: string[] | null;
  status: EntityStatus;
  last_mentioned_at: string | null;
};

function toRecord(row: Row): EntityRecord {
  return {
    id: row.id,
    type: row.type,
    subtype: row.subtype,
    displayName: row.display_name,
    aliases: row.aliases ?? [],
    status: row.status,
    lastMentionedAt: row.last_mentioned_at,
  };
}

export function entitiesRepo(db: Db): EntitiesRepo {
  return {
    async listForUser(userId, limit) {
      const { data, error } = await db
        .from("entities")
        .select(SELECT)
        .eq("user_id", userId)
        .order("first_seen_at", { ascending: true })
        .limit(limit);
      if (error) throw new Error(`listEntities failed: ${error.message}`);
      return (data ?? []).map(toRecord);
    },

    async listRecentlyMentioned(userId, sinceIso, limit) {
      const { data, error } = await db
        .from("entities")
        .select(SELECT)
        .eq("user_id", userId)
        .gte("last_mentioned_at", sinceIso)
        .order("last_mentioned_at", { ascending: false })
        .limit(limit);
      if (error) throw new Error(`listRecentEntities failed: ${error.message}`);
      return (data ?? []).map(toRecord);
    },

    async create(input) {
      const { data, error } = await db
        .from("entities")
        .insert({
          user_id: input.userId,
          type: input.type,
          subtype: input.subtype,
          display_name: input.displayName,
        })
        .select(SELECT)
        .single();
      if (error) throw new Error(`createEntity failed: ${error.message}`);
      return toRecord(data);
    },

    async addAlias(id, alias, currentAliases) {
      const next = [...new Set([...currentAliases, alias])];
      const { error } = await db.from("entities").update({ aliases: next }).eq("id", id);
      if (error) throw new Error(`addAlias failed: ${error.message}`);
    },

    async touchMention(id, at) {
      const { error } = await db.from("entities").update({ last_mentioned_at: at }).eq("id", id);
      if (error) throw new Error(`touchMention failed: ${error.message}`);
    },

    async flagNeedsConfirmation(id) {
      // Never merges. Ambiguity is recorded so it can be asked about later.
      const { error } = await db
        .from("entities")
        .update({ status: "needs_confirmation" })
        .eq("id", id);
      if (error) throw new Error(`flagNeedsConfirmation failed: ${error.message}`);
    },
  };
}
