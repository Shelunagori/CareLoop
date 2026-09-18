/**
 * ONE-TIME RE-EMBED, for the OpenAI -> BGE-M3 model swap.
 *
 *   npm run reembed:status   READ ONLY. What state the table is in.
 *   npm run reembed:dry      READ ONLY. What the real run would do.
 *   npm run reembed          The real, ordered migration.
 *
 * Run from a trusted machine with the production credentials in the
 * environment. `status` and `dry` classify stored vectors by SHAPE and need no
 * Cloudflare credential at all - only the real backfill calls the provider.
 *
 * WHY A SCRIPT AND NOT A ROUTE. A backfill needs the service-role key and
 * rewrites every user's memory index, which is the last capability that should
 * exist as an HTTP endpoint on a public demo - `/api/dev/*` is deliberately
 * absent from production, and a deployed "re-embed everything" URL would undo
 * that on purpose.
 *
 * It runs under `--conditions=react-server`, which resolves the `server-only`
 * marker package to its own empty module. That marker exists to make an
 * accidental client import a build error; this script is neither a client nor
 * a Next build, and the condition is the escape hatch the package ships for
 * exactly that case. Without it the script cannot even load.
 *
 * It reads and writes `episodes.embedding` and nothing else. No episode,
 * entity, relationship or message is created, altered or deleted. Nothing it
 * prints contains a credential, an episode's text or a vector.
 */
import { createServiceRoleClient } from "@/server/db/client";
import { createCloudflareEmbeddings } from "@/server/adapters/cloudflare/embeddings";
import {
  planReembed,
  reembedAll,
  scanEmbeddingState,
  type ReembedDeps,
  type ScanRow,
} from "@/server/services/reembed";

type Mode = "status" | "dry" | "real";

function parseMode(argv: readonly string[]): Mode {
  if (argv.includes("--status")) return "status";
  if (argv.includes("--dry-run")) return "dry";
  return "real";
}

/** `[0.1,0.2,...]` -> numbers. Throws rather than guessing on a bad literal. */
function parseVector(raw: unknown): number[] | null {
  if (raw === null || raw === undefined) return null;
  if (Array.isArray(raw)) return raw as number[];
  if (typeof raw !== "string") throw new Error(`Unexpected embedding type: ${typeof raw}`);
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) throw new Error("Embedding literal was not an array");
  return parsed as number[];
}

function buildDeps(): ReembedDeps {
  const db = createServiceRoleClient();

  return {
    episodes: {
      /**
       * An ID CURSOR over the whole table. Phase 1 nulls `embedding` while
       * this is running; an offset into a filtered set would shift underneath
       * those writes and skip or repeat rows. Ids do not move.
       */
      async scanAfter(afterId, limit) {
        let query = db
          .from("episodes")
          .select("id, summary, embedding, episode_entities(entities(display_name))")
          .order("id", { ascending: true })
          .limit(limit);
        if (afterId !== null) query = query.gt("id", afterId);

        const { data, error } = await query;
        if (error) throw new Error(`scanAfter: ${error.message}`);

        return (data ?? []).map((row): ScanRow => {
          const members = (row.episode_entities ?? []) as Array<{
            entities: { display_name: string } | null;
          }>;
          return {
            id: row.id,
            summary: row.summary,
            embedding: parseVector(row.embedding),
            // The same participant list ingestion embeds from, so a
            // re-embedded episode is identical to a freshly ingested one.
            participantNames: members
              .map((member) => member.entities?.display_name)
              .filter((name): name is string => Boolean(name)),
          };
        });
      },

      async clearEmbedding(id) {
        const { error } = await db.from("episodes").update({ embedding: null }).eq("id", id);
        if (error) throw new Error(`clearEmbedding(${id}): ${error.message}`);
      },

      async setEmbedding(id, embedding) {
        const { error } = await db
          .from("episodes")
          .update({ embedding: `[${embedding.join(",")}]` })
          .eq("id", id);
        if (error) throw new Error(`setEmbedding(${id}): ${error.message}`);
      },
    },

    /**
     * Constructed lazily. `status` and `dry` must work with no Cloudflare
     * credential present, and this adapter reads its configuration per call,
     * so building it here costs nothing until a real backfill uses it.
     */
    embeddings: createCloudflareEmbeddings(),
  };
}

function emit(record: Record<string, unknown>): void {
  // Counts and states only.
  console.log(JSON.stringify(record));
}

async function main(): Promise<void> {
  const mode = parseMode(process.argv.slice(2));
  const deps = buildDeps();

  if (mode === "status") {
    emit({ event: "reembed.status", ...(await scanEmbeddingState(deps)) });
    return;
  }

  if (mode === "dry") {
    const plan = await planReembed(deps);
    emit({
      event: "reembed.dry_run",
      writesPerformed: 0,
      providerCalls: 0,
      ...plan.status,
      willRetire: plan.willRetire,
      willBackfill: plan.willBackfill,
      totalExpectedWrites: plan.totalExpectedWrites,
    });
    return;
  }

  const result = await reembedAll(deps);
  emit({ event: "reembed.complete", retire: result.retire, backfill: result.backfill });
  emit({ event: "reembed.final_state", ...result.after });

  if (result.after.legacyOrUnknown !== 0) {
    throw new Error(
      `Migration finished with ${result.after.legacyOrUnknown} legacy embedding(s) still stored.`,
    );
  }
  const outstanding = result.after.nullCount - result.after.unembeddable;
  if (outstanding > 0) {
    // Safe but incomplete: no mixed vectors, some episodes unrecallable.
    emit({
      event: "reembed.incomplete",
      outstanding,
      unembeddable: result.after.unembeddable,
      hint: "Rows are still without a vector, most likely the daily Workers AI allocation. Re-run to finish.",
    });
    process.exitCode = 1;
  }
}

/**
 * A message with anything credential-shaped removed.
 *
 * A Supabase or Cloudflare failure can echo a URL, and the URL can carry a
 * key. Errors from here are operator-facing, so they are scrubbed rather than
 * trusted.
 */
function sanitize(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/https?:\/\/[^\s"']+/g, "[url]")
    .replace(/\b(eyJ|sbp_|sk-|rk-)[A-Za-z0-9._-]{8,}/g, "[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

main().catch((error: unknown) => {
  // Never "completed". A failure here says only that it stopped, and where.
  emit({
    event: "reembed.failed",
    errorName: error instanceof Error ? error.name : "UnknownError",
    message: sanitize(error),
  });
  process.exitCode = 1;
});
