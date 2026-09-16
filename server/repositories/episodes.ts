import type { Database } from "@/server/db/types.generated";
import type { Db } from "./db";

type TimePrecision = Database["public"]["Enums"]["time_precision"];

export type EpisodeRecord = {
  id: string;
  summary: string;
  occurredAt: string;
  precision: TimePrecision;
  salience: number;
};

export type EpisodeMatch = EpisodeRecord & { similarity: number };

export type EpisodesRepo = {
  /** Replay safety: what this message has already produced. */
  listBySourceMessage(userId: string, messageId: string): Promise<EpisodeRecord[]>;
  listRecent(userId: string, limit: number): Promise<EpisodeRecord[]>;
  create(input: {
    userId: string;
    summary: string;
    occurredAt: string;
    precision: TimePrecision;
    salience: number;
    embedding: number[] | null;
    sourceMessageIds: string[];
  }): Promise<EpisodeRecord>;
  setEmbedding(id: string, embedding: number[]): Promise<void>;
  addMembers(episodeId: string, entityIds: readonly string[]): Promise<void>;
  /** Open-ended episodic recall — the one query vectors genuinely answer. */
  matchByEmbedding(userId: string, embedding: number[], limit: number): Promise<EpisodeMatch[]>;
};

const SELECT = "id, summary, occurred_at, occurred_at_precision, salience";

/** Derived from the generated table Row — no column types restated here. */
type Row = Pick<
  Database["public"]["Tables"]["episodes"]["Row"],
  "id" | "summary" | "occurred_at" | "occurred_at_precision" | "salience"
>;

function toRecord(row: Row): EpisodeRecord {
  return {
    id: row.id,
    summary: row.summary,
    occurredAt: row.occurred_at,
    precision: row.occurred_at_precision,
    salience: Number(row.salience),
  };
}

/** pgvector's text input format. */
function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}

export function episodesRepo(db: Db): EpisodesRepo {
  return {
    async listBySourceMessage(userId, messageId) {
      const { data, error } = await db
        .from("episodes")
        .select(SELECT)
        .eq("user_id", userId)
        .contains("source_message_ids", [messageId]);
      if (error) throw new Error(`listEpisodesBySource failed: ${error.message}`);
      return (data ?? []).map(toRecord);
    },

    async listRecent(userId, limit) {
      const { data, error } = await db
        .from("episodes")
        .select(SELECT)
        .eq("user_id", userId)
        .order("occurred_at", { ascending: false })
        .limit(limit);
      if (error) throw new Error(`listRecentEpisodes failed: ${error.message}`);
      return (data ?? []).map(toRecord);
    },

    async create(input) {
      const { data, error } = await db
        .from("episodes")
        .insert({
          user_id: input.userId,
          summary: input.summary,
          occurred_at: input.occurredAt,
          occurred_at_precision: input.precision,
          salience: input.salience,
          embedding: input.embedding ? toVectorLiteral(input.embedding) : null,
          source_message_ids: input.sourceMessageIds,
        })
        .select(SELECT)
        .single();
      if (error) throw new Error(`createEpisode failed: ${error.message}`);
      return toRecord(data);
    },

    async setEmbedding(id, embedding) {
      const { error } = await db
        .from("episodes")
        .update({ embedding: toVectorLiteral(embedding) })
        .eq("id", id);
      if (error) throw new Error(`setEpisodeEmbedding failed: ${error.message}`);
    },

    async addMembers(episodeId, entityIds) {
      if (entityIds.length === 0) return;
      const rows = [...new Set(entityIds)].map((entityId) => ({
        episode_id: episodeId,
        entity_id: entityId,
      }));
      // Composite PK makes this naturally idempotent on replay.
      const { error } = await db
        .from("episode_entities")
        .upsert(rows, { onConflict: "episode_id,entity_id", ignoreDuplicates: true });
      if (error) throw new Error(`addEpisodeMembers failed: ${error.message}`);
    },

    async matchByEmbedding(userId, embedding, limit) {
      // The user filter is inside the SQL function's predicate, so a vector
      // search can never reach another person's episodes.
      const { data, error } = await db.rpc("match_episodes", {
        p_user_id: userId,
        p_query: toVectorLiteral(embedding),
        p_limit: limit,
      });
      if (error) throw new Error(`match_episodes failed: ${error.message}`);
      return (data ?? []).map((row) => ({
        ...toRecord(row),
        similarity: Number(row.similarity),
      }));
    },
  };
}
