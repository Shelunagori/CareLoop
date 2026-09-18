import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  MixedEmbeddingStateError,
  classify,
  planReembed,
  reembedAll,
  retireForeignEmbeddings,
  scanEmbeddingState,
  type ReembedDeps,
  type ScanRow,
} from "@/server/services/reembed";
import {
  EMBEDDING_STORAGE_DIMENSIONS,
  hasStorageBgePadding,
  padToStorageDimensions,
} from "@/core/memory/embedding-dimensions";
import { episodeEmbeddingInput } from "@/core/memory/embedding-input";

/**
 * THE MODEL SWAP, ON DATA THAT ALREADY EXISTS.
 *
 * The column is still 1536 wide, so an OpenAI vector and a padded BGE vector
 * are equally storable and equally comparable - and comparing them returns a
 * number that means nothing. These tests are about the property that the two
 * never coexist in a searchable state, and about the tooling being honest
 * regarding what it did.
 */
const bge = (seed: number) =>
  padToStorageDimensions(Array.from({ length: 1024 }, (_, i) => Math.sin(seed * (i + 1))));

/** 1536 meaningful components: what text-embedding-3-small produced. */
const openAi = (seed: number) =>
  Array.from({ length: EMBEDDING_STORAGE_DIMENSIONS }, (_, i) => Math.cos(seed * (i + 1)));

type Row = ScanRow & { embedding: number[] | null };

type Harness = {
  deps: ReembedDeps;
  rows: Row[];
  writes: { clears: string[]; sets: string[] };
  embedCalls: string[][];
  scans: Array<string | null>;
};

/** Ids are zero-padded so lexical order matches insertion order. */
const id = (n: number) => `ep-${String(n).padStart(4, "0")}`;

function harness(rows: Row[], onEmbed?: () => never): Harness {
  const writes = { clears: [] as string[], sets: [] as string[] };
  const embedCalls: string[][] = [];
  const scans: Array<string | null> = [];

  const deps: ReembedDeps = {
    episodes: {
      async scanAfter(afterId, limit) {
        scans.push(afterId);
        // Exactly what an id-cursor query returns: ordered, filtered, capped.
        return rows
          .filter((row) => afterId === null || row.id > afterId)
          .sort((a, b) => a.id.localeCompare(b.id))
          .slice(0, limit)
          .map((row) => ({ ...row }));
      },
      async clearEmbedding(rowId) {
        writes.clears.push(rowId);
        const row = rows.find((r) => r.id === rowId);
        if (row) row.embedding = null;
      },
      async setEmbedding(rowId, embedding) {
        writes.sets.push(rowId);
        const row = rows.find((r) => r.id === rowId);
        if (row) row.embedding = embedding;
      },
    },
    embeddings: {
      async embed(texts) {
        embedCalls.push([...texts]);
        if (onEmbed) onEmbed();
        return texts.map((_, i) => bge(500 + i));
      },
    },
  };

  return { deps, rows, writes, embedCalls, scans };
}

const row = (n: number, embedding: number[] | null, participantNames: string[] = []): Row => ({
  id: id(n),
  summary: `episode ${n}`,
  participantNames,
  embedding,
});

/** An operator script, exactly as the npm scripts invoke it. */
function runScript(env: Record<string, string>, script = "scripts/reembed.ts", arg = "--status") {
  const result = spawnSync(
    "node",
    ["--conditions=react-server", "--import", "tsx", script, arg],
    { encoding: "utf8", timeout: 60_000, env: { ...process.env, ...env } },
  );
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

describe("classification", () => {
  it("is decided by SHAPE, never by width alone", () => {
    // Both stored forms are 1536 wide - that is exactly why the column needed
    // no migration - so width classifies every legacy vector as current.
    expect(openAi(1)).toHaveLength(EMBEDDING_STORAGE_DIMENSIONS);
    expect(bge(1)).toHaveLength(EMBEDDING_STORAGE_DIMENSIONS);

    expect(classify(bge(1))).toBe("bge_padded");
    expect(classify(openAi(1))).toBe("legacy_or_unknown");
    expect(classify(null)).toBe("null");
  });
});

describe("full-table status", () => {
  it("counts every row and satisfies its invariants", async () => {
    const { deps } = harness([
      row(1, openAi(1)),
      row(2, bge(2)),
      row(3, null),
      row(4, openAi(4)),
      row(5, bge(5)),
    ]);

    const status = await scanEmbeddingState(deps, { batchSize: 2 });

    expect(status.total).toBe(5);
    expect(status.nonNull).toBe(4);
    expect(status.nullCount).toBe(1);
    expect(status.bgePadded).toBe(2);
    expect(status.legacyOrUnknown).toBe(2);
    expect(status.total).toBe(status.nullCount + status.bgePadded + status.legacyOrUnknown);
    expect(status.nonNull).toBe(status.bgePadded + status.legacyOrUnknown);
  });

  it("needs no embedding provider — status works with no Cloudflare token", async () => {
    const { deps } = harness([row(1, openAi(1)), row(2, null)]);
    deps.embeddings = {
      async embed() {
        throw new Error("the provider must not be reached from a status scan");
      },
    };

    await expect(scanEmbeddingState(deps)).resolves.toMatchObject({ total: 2 });
  });

  it("an empty table reports all zeros rather than failing", async () => {
    const { deps, embedCalls } = harness([]);
    const status = await scanEmbeddingState(deps);

    expect(status).toMatchObject({
      total: 0,
      nonNull: 0,
      nullCount: 0,
      bgePadded: 0,
      legacyOrUnknown: 0,
      unembeddable: 0,
    });
    expect(embedCalls).toHaveLength(0);
  });

  it("counts rows that CANNOT be embedded separately from rows that merely are not", async () => {
    // Otherwise phase 2's "no nulls left" gate is satisfied by pretending a
    // row with nothing to embed succeeded.
    const blank: Row = { id: id(9), summary: "   ", participantNames: [], embedding: null };
    const { deps } = harness([row(1, null), blank]);

    const status = await scanEmbeddingState(deps);
    expect(status.nullCount).toBe(2);
    expect(status.unembeddable).toBe(1);
  });
});

describe("pagination covers the whole table", () => {
  const many = () =>
    Array.from({ length: 125 }, (_, i) =>
      row(i + 1, i % 3 === 0 ? openAi(i + 1) : i % 3 === 1 ? bge(i + 1) : null),
    );

  it("125 rows at batchSize 50 are all inspected — three batches, not one", async () => {
    // The original defect: both phases broke after the first batch, so every
    // number was silently capped at 50 and no cutover invariant could be
    // proven over the table.
    const { deps, scans } = harness(many());
    const status = await scanEmbeddingState(deps, { batchSize: 50 });

    expect(status.total).toBe(125);
    expect(status.batches).toBe(3);
    expect(scans).toEqual([null, id(50), id(100)]);
  });

  it("every row is seen exactly once — none skipped, none double-counted", async () => {
    const rows = many();
    const { deps } = harness(rows);
    const seen: string[] = [];

    const inner = deps.episodes.scanAfter.bind(deps.episodes);
    deps.episodes.scanAfter = async (afterId, limit) => {
      const page = await inner(afterId, limit);
      seen.push(...page.map((r) => r.id));
      return page;
    };

    await scanEmbeddingState(deps, { batchSize: 50 });

    expect(seen).toHaveLength(125);
    expect(new Set(seen).size).toBe(125);
    expect(seen).toEqual(rows.map((r) => r.id).sort());
  });

  it("the cursor survives rows being mutated mid-scan", async () => {
    /**
     * Phase 1 nulls `embedding` while the scan is running. An offset into a
     * filtered set would shift underneath those writes; an id cursor cannot,
     * because ids do not move.
     */
    const rows = Array.from({ length: 125 }, (_, i) => row(i + 1, openAi(i + 1)));
    const { deps, writes } = harness(rows);

    const report = await retireForeignEmbeddings(deps, { batchSize: 50 });

    expect(report.inspected).toBe(125);
    expect(report.retired).toBe(125);
    expect(new Set(writes.clears).size).toBe(125);
    expect(rows.every((r) => r.embedding === null)).toBe(true);
  });
});

describe("dry run is READ ONLY", () => {
  it("performs no write and no provider call, and still scans everything", async () => {
    // A dry run that suppressed only the final write while still spending the
    // daily embedding allocation would be a dry run in name.
    const { deps, writes, embedCalls, rows } = harness(
      Array.from({ length: 125 }, (_, i) =>
        row(i + 1, i % 3 === 0 ? openAi(i + 1) : i % 3 === 1 ? bge(i + 1) : null),
      ),
    );
    const before = rows.map((r) => r.embedding);

    const plan = await planReembed(deps, { batchSize: 50 });

    expect(writes.clears).toHaveLength(0);
    expect(writes.sets).toHaveLength(0);
    expect(embedCalls).toHaveLength(0);
    expect(plan.status.total).toBe(125);
    expect(plan.status.batches).toBe(3);
    // Byte-for-byte unchanged.
    expect(rows.map((r) => r.embedding)).toEqual(before);
  });

  it("the plan is the arithmetic the real run will perform", async () => {
    const { deps } = harness([
      row(1, openAi(1)),
      row(2, openAi(2)),
      row(3, bge(3)),
      row(4, null),
    ]);

    const plan = await planReembed(deps);

    expect(plan.willRetire).toBe(2);
    // The two retired, plus the one already null.
    expect(plan.willBackfill).toBe(3);
    expect(plan.totalExpectedWrites).toBe(5);
  });

  it("the plan matches what the real run actually does", async () => {
    const rows = [row(1, openAi(1)), row(2, bge(2)), row(3, null), row(4, openAi(4))];
    const dry = harness(rows.map((r) => ({ ...r })));
    const real = harness(rows.map((r) => ({ ...r })));

    const plan = await planReembed(dry.deps);
    await reembedAll(real.deps);

    expect(real.writes.clears).toHaveLength(plan.willRetire);
    expect(real.writes.sets).toHaveLength(plan.willBackfill);
  });
});

describe("the real migration", () => {
  it("retires everything BEFORE embedding anything", async () => {
    const events: string[] = [];
    const { deps } = harness([row(1, openAi(1)), row(2, null), row(3, openAi(3))]);

    const episodes = deps.episodes;
    const clear = episodes.clearEmbedding.bind(episodes);
    const set = episodes.setEmbedding.bind(episodes);
    episodes.clearEmbedding = async (rowId) => {
      events.push("clear");
      return clear(rowId);
    };
    episodes.setEmbedding = async (rowId, vector) => {
      events.push("set");
      return set(rowId, vector);
    };

    await reembedAll(deps, { batchSize: 2 });

    expect(events.lastIndexOf("clear")).toBeLessThan(events.indexOf("set"));
  });

  it("REFUSES to backfill while a legacy vector survives", async () => {
    /**
     * The gate is a fresh scan, not phase 1's own tally: a phase reporting on
     * itself keeps believing it succeeded after a write that silently failed.
     */
    const { deps, embedCalls } = harness([row(1, openAi(1)), row(2, null)]);
    deps.episodes.clearEmbedding = async () => {
      // A write that reports success and changes nothing.
    };

    await expect(reembedAll(deps)).rejects.toThrow(MixedEmbeddingStateError);
    expect(embedCalls, "the provider was called despite a mixed index").toHaveLength(0);
  });

  it("leaves NO legacy vector searchable alongside a BGE one", async () => {
    const { deps, rows } = harness([
      row(1, openAi(1)),
      row(2, openAi(2)),
      row(3, bge(3)),
      row(4, null),
    ]);

    const result = await reembedAll(deps, { batchSize: 2 });

    expect(result.after.legacyOrUnknown).toBe(0);
    expect(result.after.nullCount).toBe(0);
    for (const stored of rows) {
      expect(hasStorageBgePadding(stored.embedding as number[]), stored.id).toBe(true);
    }
  });

  it("re-embeds from the SAME input the ingestion path uses", async () => {
    const { deps, embedCalls } = harness([row(1, null, ["Mary", "John"])]);
    await reembedAll(deps);

    expect(embedCalls[0][0]).toBe(
      episodeEmbeddingInput({ summary: "episode 1", participantNames: ["Mary", "John"] }),
    );
  });

  it("an empty table completes without touching the provider", async () => {
    const { deps, embedCalls, writes } = harness([]);
    const result = await reembedAll(deps);

    expect(result.after.total).toBe(0);
    expect(embedCalls).toHaveLength(0);
    expect(writes.clears.concat(writes.sets)).toHaveLength(0);
  });
});

describe("interruption and resume", () => {
  it("a provider failure leaves a SAFE state — retired, partly filled, never mixed", async () => {
    const rows = [row(1, openAi(1)), row(2, openAi(2))];
    const { deps } = harness(rows, () => {
      throw new Error("Account limited: Neuron quota");
    });

    const result = await reembedAll(deps, { batchSize: 1 });

    // Incomplete, and safe: nothing legacy survives, so no comparison the
    // database makes can span two models.
    expect(result.after.legacyOrUnknown).toBe(0);
    expect(result.after.nullCount).toBe(2);
    expect(result.backfill.failed).toBeGreaterThan(0);
  });

  it("a rerun finishes the job and does NOT re-embed what is already current", async () => {
    const rows = [row(1, openAi(1)), row(2, openAi(2)), row(3, bge(3))];
    let fail = true;
    const first = harness(rows, () => {
      if (fail) throw new Error("Account limited");
      throw new Error("unreachable");
    });

    await reembedAll(first.deps, { batchSize: 1 });
    expect(rows.filter((r) => r.embedding === null).length).toBeGreaterThan(0);

    fail = false;
    const second = harness(rows);
    const untouched = rows.find((r) => r.id === id(3))?.embedding;
    const result = await reembedAll(second.deps, { batchSize: 1 });

    expect(result.after.nullCount).toBe(0);
    expect(result.after.legacyOrUnknown).toBe(0);
    // The already-current vector was neither cleared nor regenerated.
    expect(rows.find((r) => r.id === id(3))?.embedding).toBe(untouched);
    expect(second.writes.clears).not.toContain(id(3));
    expect(second.writes.sets).not.toContain(id(3));
  });

  it("a completed migration rerun is a no-op", async () => {
    const { deps: first, rows } = harness([row(1, openAi(1)), row(2, null)]);
    await reembedAll(first, { batchSize: 2 });

    const second = harness(rows);
    const result = await reembedAll(second.deps);

    expect(second.writes.clears.concat(second.writes.sets)).toHaveLength(0);
    expect(second.embedCalls).toHaveLength(0);
    expect(result.after.bgePadded).toBe(2);
  });
});

describe("regressions — the three defects that broke the tooling", () => {
  it("A. tsx is a declared devDependency, not something npx happens to fetch", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as {
      devDependencies?: Record<string, string>;
      scripts: Record<string, string>;
    };

    expect(pkg.devDependencies?.tsx, "tsx is referenced by scripts but not declared").toBeTruthy();
    for (const script of [
      "reembed",
      "reembed:dry",
      "reembed:status",
      "cloudflare:smoke",
    ]) {
      expect(pkg.scripts[script], script).toContain("tsx");
    }
  });

  it("B. the script loads — no top-level await under CJS", () => {
    /**
     * The original failed at transform time with "Top-level await is currently
     * not supported with the cjs output format", so it could never run at all.
     * Type-checking would not have caught it and neither would any unit test
     * of the service: only executing the entry point does.
     *
     * A second defect the same test found: both the service and the db client
     * import the `server-only` marker package, which throws outside Next's
     * bundler. `--conditions=react-server` resolves it to its own empty
     * module - the escape hatch that package ships - and is how the npm
     * scripts invoke it.
     *
     * Run with no credentials, so it reaches its own error handler rather than
     * a network call. Success is that it EXECUTES and reports a sanitized
     * failure, not that it migrates anything.
     */
    const run = runScript({
      NEXT_PUBLIC_SUPABASE_URL: "",
      SUPABASE_SERVICE_ROLE_KEY: "",
      CLOUDFLARE_ACCOUNT_ID: "",
      CLOUDFLARE_API_TOKEN: "",
    });
    const output = run.stdout + run.stderr;

    expect(output).not.toContain("Top-level await");
    expect(output).not.toContain("TransformError");
    // Its own handler ran, which means the module loaded and main() was called.
    expect(output).toContain("reembed.failed");
    expect(run.status, "a failing run must exit non-zero").not.toBe(0);
  });

  it("B2. a failure never claims the migration completed, and leaks no credential", () => {
    const run = runScript({
      // Malformed on purpose: the client rejects it at construction, so this
      // test never opens a socket. A reachable-looking URL would make the
      // suite depend on the network and on whatever answers.
      NEXT_PUBLIC_SUPABASE_URL: "not-a-valid-url",
      SUPABASE_SERVICE_ROLE_KEY: "eyJsupersecretservicekey.value.here",
      CLOUDFLARE_ACCOUNT_ID: "",
      CLOUDFLARE_API_TOKEN: "",
    });
    const output = run.stdout + run.stderr;

    // A failure must exit non-zero, or a CI step would pass over it.
    expect(run.status).not.toBe(0);
    expect(output).not.toContain("eyJsupersecretservicekey");
    expect(output).not.toContain("not-a-valid-url");
    expect(output).not.toContain("reembed.complete");
    expect(output).toContain("reembed.failed");
  });

  it("B3. the Cloudflare smoke script loads and fails cleanly without credentials", () => {
    // Same class of defect as B: a script that cannot load is not caught by
    // tsc or by any test of the modules it imports.
    const run = runScript(
      { CLOUDFLARE_ACCOUNT_ID: "", CLOUDFLARE_API_TOKEN: "" },
      "scripts/cloudflare-smoke.ts",
      "",
    );
    const output = run.stdout + run.stderr;

    expect(output).not.toContain("Top-level await");
    expect(output).not.toContain("Server Component");
    expect(output).toContain("Cloudflare smoke test");
    expect(output).toContain("FAIL");
    expect(output).toContain("CLOUDFLARE_ACCOUNT_ID");
    expect(run.status, "a failing smoke run must exit non-zero").not.toBe(0);
  });

  it("C. 125 rows at batchSize 50 produce a complete result, not the first 50", async () => {
    const { deps } = harness(Array.from({ length: 125 }, (_, i) => row(i + 1, openAi(i + 1))));

    const plan = await planReembed(deps, { batchSize: 50 });

    expect(plan.status.total).toBe(125);
    expect(plan.willRetire).toBe(125);
    expect(plan.status.total).toBeGreaterThan(50);
  });
});
