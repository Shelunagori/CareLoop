import type { Db } from "./db";

/**
 * Closures.
 *
 * A closure is the persisted form of "we owe this person an answer". It exists
 * as a row precisely so an unacknowledged promise is queryable rather than
 * something the model is trusted to remember (docs/04 section 12.3).
 *
 * `surfaced_at` is what stops the companion repeating itself: a closure is
 * told once, and the row records that it was.
 */
export type ClosureRecord = {
  id: string;
  opportunityId: string;
  responseId: string;
  surfacedMessageId: string | null;
  surfacedAt: string | null;
  createdAt: string;
};

export type ClosuresRepo = {
  /** Closures for this user that have not yet been told to them. */
  listUnsurfacedForUser(userId: string, limit: number): Promise<ClosureRecord[]>;
  findByResponse(responseId: string): Promise<ClosureRecord | null>;
  /**
   * M8. One closure, scoped to its owner through the opportunity - exactly the
   * join `listUnsurfacedForUser` uses, and exactly what RLS does.
   */
  findOwnedById(id: string, userId: string): Promise<ClosureRecord | null>;
  /** Conditional on it not already having been surfaced. */
  markSurfaced(input: {
    id: string;
    messageId: string | null;
    now: string;
  }): Promise<ClosureRecord | null>;
};

const SELECT = "id, opportunity_id, response_id, surfaced_message_id, surfaced_at, created_at";

type Row = {
  id: string;
  opportunity_id: string;
  response_id: string;
  surfaced_message_id: string | null;
  surfaced_at: string | null;
  created_at: string;
};

const toRecord = (row: Row): ClosureRecord => ({
  id: row.id,
  opportunityId: row.opportunity_id,
  responseId: row.response_id,
  surfacedMessageId: row.surfaced_message_id,
  surfacedAt: row.surfaced_at,
  createdAt: row.created_at,
});

export function closuresRepo(db: Db): ClosuresRepo {
  return {
    async listUnsurfacedForUser(userId, limit) {
      // Ownership is reached through the opportunity, exactly as RLS does.
      const { data, error } = await db
        .from("closures")
        .select(`${SELECT}, reconnect_opportunities!inner(user_id)`)
        .eq("reconnect_opportunities.user_id", userId)
        .is("surfaced_at", null)
        .order("created_at", { ascending: true })
        .limit(limit);
      if (error) throw new Error(`listClosures failed: ${error.message}`);
      return (data ?? []).map((row) => toRecord(row as unknown as Row));
    },

    async findOwnedById(id, userId) {
      const { data, error } = await db
        .from("closures")
        .select(`${SELECT}, reconnect_opportunities!inner(user_id)`)
        .eq("id", id)
        .eq("reconnect_opportunities.user_id", userId)
        .maybeSingle();
      if (error) throw new Error(`findOwnedClosure failed: ${error.message}`);
      return data ? toRecord(data as unknown as Row) : null;
    },

    async findByResponse(responseId) {
      const { data, error } = await db
        .from("closures")
        .select(SELECT)
        .eq("response_id", responseId)
        .maybeSingle();
      if (error) throw new Error(`findClosure failed: ${error.message}`);
      return data ? toRecord(data) : null;
    },

    async markSurfaced({ id, messageId, now }) {
      const { data, error } = await db
        .from("closures")
        .update({ surfaced_at: now, surfaced_message_id: messageId })
        .eq("id", id)
        .is("surfaced_at", null)
        .select(SELECT)
        .maybeSingle();
      if (error) throw new Error(`markClosureSurfaced failed: ${error.message}`);
      return data ? toRecord(data) : null;
    },
  };
}
