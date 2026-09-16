import type { Db } from "./db";

/**
 * Durable post-turn work (R8). The row is the commitment; the in-process
 * attempt is an optimisation on top of it.
 */
export type IngestJobPayload = {
  conversationId: string;
  userMessageId: string;
  assistantMessageId: string;
  userId: string;
};

export type JobRecord = {
  id: string;
  key: string;
  payload: IngestJobPayload;
  attempts: number;
};

export type JobsRepo = {
  /** Idempotent on (kind, key): a retried turn cannot create a second job. */
  createIngestJob(key: string, payload: IngestJobPayload): Promise<void>;
  /**
   * Atomically leases up to `limit` runnable jobs, at most one per
   * conversation. Returns [] when there is nothing to do.
   */
  claim(limit: number, leaseSeconds: number): Promise<JobRecord[]>;
  complete(id: string): Promise<void>;
  fail(id: string, message: string, backoffSeconds: number): Promise<void>;
};

export function jobsRepo(db: Db): JobsRepo {
  return {
    async createIngestJob(key, payload) {
      const { error } = await db
        .from("jobs")
        .upsert(
          { kind: "ingest", key, payload },
          { onConflict: "kind,key", ignoreDuplicates: true },
        );
      if (error) throw new Error(`createIngestJob failed: ${error.message}`);
    },

    async claim(limit, leaseSeconds) {
      const { data, error } = await db.rpc("claim_ingest_jobs", {
        p_limit: limit,
        p_lease_seconds: leaseSeconds,
      });
      if (error) throw new Error(`claim_ingest_jobs failed: ${error.message}`);
      return (data ?? []).map((row) => ({
        id: row.id,
        key: row.key,
        // `payload` is jsonb, so the generated type is `Json | null`. This
        // narrowing is a jsonb concern, not a stale-types one: the shape is
        // guaranteed by createIngestJob, which is the only writer.
        payload: row.payload as unknown as IngestJobPayload,
        attempts: row.attempts,
      }));
    },

    async complete(id) {
      const { error } = await db
        .from("jobs")
        .update({ completed_at: new Date().toISOString(), last_error: null })
        .eq("id", id);
      if (error) throw new Error(`completeJob failed: ${error.message}`);
    },

    async fail(id, message, backoffSeconds) {
      const { error } = await db
        .from("jobs")
        .update({
          // Truncated: an error string is diagnostics, not a place for content.
          last_error: message.slice(0, 500),
          run_after: new Date(Date.now() + backoffSeconds * 1000).toISOString(),
        })
        .eq("id", id);
      if (error) throw new Error(`failJob failed: ${error.message}`);
    },
  };
}
