import type { Database } from "@/server/db/types.generated";
import type { Db } from "./db";

type EntityType = Database["public"]["Enums"]["entity_type"];
type EntityStatus = Database["public"]["Enums"]["entity_status"];
type EntityOrigin = Database["public"]["Enums"]["entity_origin"];

export type EntityRecord = {
  id: string;
  type: EntityType;
  subtype: string | null;
  displayName: string;
  aliases: string[];
  status: EntityStatus;
  /**
   * WHO CREATED THIS ROW (M12e): the extraction pipeline from the person's
   * own words (`user`), the demo fixture (`demo`), or a development seeding
   * route (`dev`). Read on the presentation path, which refuses `dev`.
   *
   * This is the durable answer to a question `sanitizeLabel` cannot answer:
   * "TestPersonA" is spelled exactly like a name.
   */
  origin: EntityOrigin;
  lastMentionedAt: string | null;
};

export type EntitiesRepo = {
  /**
   * The user's whole cast of characters, INCLUDING development-seeded rows.
   * Small by nature; bounded anyway.
   *
   * Entity RESOLUTION needs this: a mention has to match a row that already
   * exists whatever created it, or ingestion writes a duplicate every turn.
   * Nothing that renders to a person may use it — see
   * `listPresentableForUser`, and the guard in
   * `tests/unit/provenance-scope.test.ts`.
   */
  listForUser(userId: string, limit: number): Promise<EntityRecord[]>;
  /**
   * The same read with development-seeded rows excluded, IN THE QUERY
   * (M12e.3).
   *
   * Filtered in SQL rather than after it, for the reason
   * `listRecentPositive` is: a filter in a query is harder to drop than a
   * filter in a map, and this one is the difference between a reviewer
   * seeing a product and seeing a test fixture. `core/memory/provenance.ts`
   * applies the same rule again in code; neither is redundant, because the
   * unfiltered read above still exists and is still correct for resolution.
   */
  listPresentableForUser(userId: string, limit: number): Promise<EntityRecord[]>;
  listRecentlyMentioned(userId: string, sinceIso: string, limit: number): Promise<EntityRecord[]>;
  create(input: {
    userId: string;
    type: EntityType;
    subtype: string | null;
    displayName: string;
    /**
     * Omitted by the ingestion pipeline, which is the only caller that
     * SHOULD omit it: the column defaults to `user`, so a row created
     * because a person said something is `user` without anyone saying so.
     * Development seeding routes pass `dev` explicitly.
     */
    origin?: EntityOrigin;
  }): Promise<EntityRecord>;
  addAlias(id: string, alias: string, currentAliases: readonly string[]): Promise<void>;
  touchMention(id: string, at: string): Promise<void>;
  flagNeedsConfirmation(id: string): Promise<void>;
};

const SELECT = "id, type, subtype, display_name, aliases, status, origin, last_mentioned_at";

type Row = {
  id: string;
  type: EntityType;
  subtype: string | null;
  display_name: string;
  aliases: string[] | null;
  status: EntityStatus;
  origin: EntityOrigin;
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
    origin: row.origin,
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

    async listPresentableForUser(userId, limit) {
      const { data, error } = await db
        .from("entities")
        .select(SELECT)
        .eq("user_id", userId)
        .neq("origin", "dev")
        .order("first_seen_at", { ascending: true })
        .limit(limit);
      if (error) throw new Error(`listPresentableEntities failed: ${error.message}`);
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
          ...(input.origin === undefined ? {} : { origin: input.origin }),
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
