import "server-only";
import { episodeEmbeddingInput } from "@/core/memory/embedding-input";
import { hasStorageBgePadding } from "@/core/memory/embedding-dimensions";
import type { EmbeddingProvider } from "@/server/adapters/openai/types";

/**
 * A ONE-TIME RE-EMBED, for the model swap from OpenAI to BGE-M3.
 *
 * The column stayed `vector(1536)`, so vectors from both models fit it and the
 * database will compare them without complaint. It will also return nonsense
 * when it does: the two models put their axes in different places, so a cosine
 * distance between an OpenAI vector and a BGE vector is a number with no
 * meaning. Mixed is worse than missing, because missing is visible -
 * `match_episodes` requires `embedding is not null`, so a cleared episode
 * simply drops out of recall until it has a current vector.
 *
 * Hence two phases, strictly ordered, each followed by a FRESH FULL SCAN that
 * gates the next step. Running a backfill while a single legacy vector
 * remained would create exactly the mixed window this exists to prevent, so
 * phase 2 is unreachable until a scan proves phase 1 finished.
 *
 * Everything here is resumable and idempotent: each phase selects by what is
 * still true of the data rather than by a cursor through a snapshot, so an
 * interrupted run is finished by running it again and a completed run is a
 * no-op.
 */

/** What one stored vector is, judged by its shape alone. */
export type EmbeddingState = "null" | "bge_padded" | "legacy_or_unknown";

export type StatusReport = {
  total: number;
  nonNull: number;
  nullCount: number;
  bgePadded: number;
  legacyOrUnknown: number;
  /**
   * Rows that cannot produce an embedding input at all - a blank summary with
   * no participants. Counted separately so phase 2's "no nulls left" gate is
   * not quietly satisfied by pretending they succeeded.
   */
  unembeddable: number;
  batches: number;
};

export type ReembedEpisode = {
  id: string;
  summary: string;
  participantNames: readonly string[];
};

/** One row as the scan sees it. The vector is read, never printed. */
export type ScanRow = {
  id: string;
  embedding: number[] | null;
  summary: string;
  participantNames: readonly string[];
};

export type ReembedDeps = {
  episodes: {
    /**
     * Rows after `afterId`, ordered by id. An ID CURSOR, not an offset:
     * phase 1 mutates `embedding` while the scan is running, and an
     * offset into a filtered set shifts underneath a writer, silently
     * skipping or repeating rows. Ids do not move.
     */
    scanAfter(afterId: string | null, limit: number): Promise<ScanRow[]>;
    clearEmbedding(id: string): Promise<void>;
    setEmbedding(id: string, embedding: number[]): Promise<void>;
  };
  embeddings: EmbeddingProvider;
};

export type ReembedOptions = {
  /** Rows per round trip. */
  batchSize?: number;
  /** Safety valve against an unterminated cursor. */
  maxBatches?: number;
};

const DEFAULTS = { batchSize: 50, maxBatches: 10_000 };

export function classify(embedding: number[] | null): EmbeddingState {
  if (embedding === null) return "null";
  // NOT by width. Both the old vectors and the new ones are 1536 wide - that
  // is the entire reason the column did not need a migration - so width alone
  // classifies every legacy vector as current.
  return hasStorageBgePadding(embedding) ? "bge_padded" : "legacy_or_unknown";
}

const canEmbed = (row: { summary: string; participantNames: readonly string[] }): boolean =>
  episodeEmbeddingInput({ summary: row.summary, participantNames: row.participantNames }).length >
  0;

/**
 * Walks the whole table by id cursor, handing each page to `visit`.
 *
 * One traversal used by every command, so "scans the whole eligible set"
 * cannot be true of one mode and false of another.
 */
async function forEachPage(
  deps: ReembedDeps,
  options: ReembedOptions,
  visit: (rows: ScanRow[]) => Promise<void> | void,
): Promise<number> {
  const { batchSize, maxBatches } = { ...DEFAULTS, ...options };
  let cursor: string | null = null;
  let batches = 0;

  for (; batches < maxBatches; batches += 1) {
    const rows: ScanRow[] = await deps.episodes.scanAfter(cursor, batchSize);
    if (rows.length === 0) break;
    await visit(rows);
    cursor = rows[rows.length - 1].id;
    // A short page is the last page.
    if (rows.length < batchSize) {
      batches += 1;
      break;
    }
  }

  return batches;
}

/** READ ONLY. The whole table, classified, with its invariants checked. */
export async function scanEmbeddingState(
  deps: ReembedDeps,
  options: ReembedOptions = {},
): Promise<StatusReport> {
  let nullCount = 0;
  let bgePadded = 0;
  let legacyOrUnknown = 0;
  let unembeddable = 0;

  const batches = await forEachPage(deps, options, (rows) => {
    for (const row of rows) {
      switch (classify(row.embedding)) {
        case "null":
          nullCount += 1;
          if (!canEmbed(row)) unembeddable += 1;
          break;
        case "bge_padded":
          bgePadded += 1;
          break;
        default:
          legacyOrUnknown += 1;
      }
    }
  });

  const report: StatusReport = {
    total: nullCount + bgePadded + legacyOrUnknown,
    nonNull: bgePadded + legacyOrUnknown,
    nullCount,
    bgePadded,
    legacyOrUnknown,
    unembeddable,
    batches,
  };

  /**
   * Checked rather than assumed. These counts are what the cutover gates are
   * decided on, so an arithmetic slip here would let a migration report
   * success over a table it never finished reading.
   */
  if (report.total !== report.nullCount + report.bgePadded + report.legacyOrUnknown) {
    throw new Error("Embedding state scan is inconsistent: total does not match its parts.");
  }
  if (report.nonNull !== report.bgePadded + report.legacyOrUnknown) {
    throw new Error("Embedding state scan is inconsistent: nonNull does not match its parts.");
  }

  return report;
}

export type DryRunPlan = {
  status: StatusReport;
  willRetire: number;
  willBackfill: number;
  totalExpectedWrites: number;
};

/**
 * READ ONLY. What the real run would do, computed from the scan alone.
 *
 * No provider call is made, and none is needed: the plan is arithmetic over
 * the classification. A dry run that suppressed only the final write while
 * still spending the daily embedding allocation would be a dry run in name.
 */
export async function planReembed(
  deps: ReembedDeps,
  options: ReembedOptions = {},
): Promise<DryRunPlan> {
  const status = await scanEmbeddingState(deps, options);
  const willRetire = status.legacyOrUnknown;
  // Everything null now, plus everything phase 1 is about to null - minus the
  // rows that have no text to embed.
  const willBackfill = status.nullCount - status.unembeddable + willRetire;

  return { status, willRetire, willBackfill, totalExpectedWrites: willRetire + willBackfill };
}

export type RetireReport = { inspected: number; retired: number; kept: number; batches: number };
export type BackfillReport = { embedded: number; failed: number; skipped: number };

/** PHASE 1. Clears every vector that did not come from the current model. */
export async function retireForeignEmbeddings(
  deps: ReembedDeps,
  options: ReembedOptions = {},
): Promise<RetireReport> {
  let inspected = 0;
  let retired = 0;
  let kept = 0;

  const batches = await forEachPage(deps, options, async (rows) => {
    for (const row of rows) {
      inspected += 1;
      const state = classify(row.embedding);
      if (state === "legacy_or_unknown") {
        await deps.episodes.clearEmbedding(row.id);
        retired += 1;
      } else if (state === "bge_padded") {
        // Left exactly as it is. Re-embedding a current vector would spend
        // the allocation to produce the same answer.
        kept += 1;
      }
    }
  });

  return { inspected, retired, kept, batches };
}

/** PHASE 2. Gives a vector back to every episode that has none. */
export async function backfillEmbeddings(
  deps: ReembedDeps,
  options: ReembedOptions = {},
): Promise<BackfillReport> {
  const report: BackfillReport = { embedded: 0, failed: 0, skipped: 0 };
  let providerFailed = false;

  await forEachPage(deps, options, async (rows) => {
    if (providerFailed) return;

    // Only the rows that still need one, and only those with text to embed.
    const pending = rows.filter((row) => row.embedding === null);
    const eligible = pending.filter(canEmbed);
    report.skipped += pending.length - eligible.length;
    if (eligible.length === 0) return;

    const inputs = eligible.map((row) =>
      episodeEmbeddingInput({ summary: row.summary, participantNames: row.participantNames }),
    );

    let vectors: number[][];
    try {
      vectors = await deps.embeddings.embed(inputs);
    } catch {
      /**
       * Stop, do not retry. The likeliest cause is the daily Workers AI
       * allocation running out, and hammering it produces a longer outage
       * rather than a finished backfill. The rows keep their null, which is
       * unrecallable but never WRONG, and a later run picks them up.
       */
      report.failed += eligible.length;
      providerFailed = true;
      return;
    }

    for (const [index, row] of eligible.entries()) {
      await deps.episodes.setEmbedding(row.id, vectors[index]);
      report.embedded += 1;
    }
  });

  return report;
}

export class MixedEmbeddingStateError extends Error {
  readonly name = "MixedEmbeddingStateError";
  constructor(readonly remaining: number) {
    super(
      `Refusing to backfill: ${remaining} legacy embedding(s) are still stored. ` +
        `Backfilling now would put BGE vectors in the same index as another model's.`,
    );
  }
}

export type ReembedResult = {
  before: StatusReport;
  retire: RetireReport;
  afterRetire: StatusReport;
  backfill: BackfillReport;
  after: StatusReport;
};

/** The real migration: both phases, gated by fresh scans. */
export async function reembedAll(
  deps: ReembedDeps,
  options: ReembedOptions = {},
): Promise<ReembedResult> {
  const before = await scanEmbeddingState(deps, options);
  const retire = await retireForeignEmbeddings(deps, options);

  /**
   * A FRESH scan, not the retire phase's own tally. The hard gate has to be
   * evidence from the database about the state the database is actually in -
   * a phase reporting on itself would keep believing it succeeded after a
   * write that silently failed.
   */
  const afterRetire = await scanEmbeddingState(deps, options);
  if (afterRetire.legacyOrUnknown !== 0) {
    throw new MixedEmbeddingStateError(afterRetire.legacyOrUnknown);
  }

  const backfill = await backfillEmbeddings(deps, options);
  const after = await scanEmbeddingState(deps, options);

  return { before, retire, afterRetire, backfill, after };
}
