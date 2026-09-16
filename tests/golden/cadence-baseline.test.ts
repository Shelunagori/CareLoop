import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { ExtractionV1Schema, type ExtractionV1 } from "@/core/memory/extraction-contract";
import { computeCadenceThreshold } from "@/core/baseline/compute";
import { processIngestJob } from "@/server/services/ingestion";
import {
  createStore,
  fakeEmbeddings,
  fakeExtraction,
  ingestionDeps,
  resetIds,
  type MemoryStore,
} from "../unit/memory-fakes";

/**
 * M3 golden: utterance + recorded extraction -> interaction events -> baseline.
 *
 * No live model. The recording is the only non-deterministic input, so
 * everything downstream - derivation, day collapse, gaps, median, MAD,
 * threshold - is reproducible byte-for-byte.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

type Turn = {
  conversationId: string;
  messageId: string;
  createdAt: string;
  utterance: string;
  extraction: ExtractionV1;
};

const fixture = JSON.parse(
  readFileSync(
    path.join(root, "fixtures/recorded-extractions/cadence-series.extraction.v1.json"),
    "utf8",
  ),
) as { turns: Turn[] };

const USER = "cadence-user";
/** Anchored so the series is fixed relative to "now". */
const NOW = "2026-09-16T12:00:00.000Z";

function newStore(): MemoryStore {
  resetIds();
  return createStore(
    fixture.turns.map((turn) => ({
      id: turn.messageId,
      role: "user" as const,
      content: turn.utterance,
      createdAt: turn.createdAt,
    })),
  );
}

async function ingest(store: MemoryStore, turn: Turn) {
  await processIngestJob(
    ingestionDeps(
      store,
      {
        extraction: fakeExtraction(turn.extraction, { store }),
        embeddings: fakeEmbeddings({ store }),
      },
      NOW,
    ),
    {
      id: `job-${turn.messageId}`,
      key: `a-${turn.messageId}`,
      payload: {
        conversationId: turn.conversationId,
        userMessageId: turn.messageId,
        assistantMessageId: `a-${turn.messageId}`,
        userId: USER,
      },
      attempts: 1,
    },
  );
}

let store: MemoryStore;

beforeEach(() => {
  store = newStore();
});

describe("the recording satisfies the contract", () => {
  it("every turn parses", () => {
    for (const turn of fixture.turns) {
      expect(ExtractionV1Schema.safeParse(turn.extraction).success).toBe(true);
    }
  });
});

describe("five weekly visits produce an ACTIVE baseline", () => {
  it("derives the series and the statistics end to end", async () => {
    for (const turn of fixture.turns) await ingest(store, turn);

    const visits = store.interactionEvents.filter(
      (e) => e.eventType === "visit" && e.polarity === "positive",
    );
    expect(visits).toHaveLength(5);

    const baseline = [...store.baselines.values()].find((b) => b.eventType === "visit")!;
    expect(baseline.gaps).toEqual([7, 7, 7, 7]);
    expect(baseline.spanDays).toBe(28);
    expect(baseline.medianGapDays).toBe(7);
    expect(baseline.madDays).toBe(0);
    expect(baseline.dispersion).toBe(0);
    expect(baseline.status).toBe("ACTIVE");
    // median 7, MAD 0 -> max(7, 10.5, 11, 7) = 11.
    // Derived on demand; no column holds it.
    expect(computeCadenceThreshold(baseline.medianGapDays!, baseline.madDays!)).toBe(11);
    expect(baseline.methodVersion).toBe("baseline.v1");
  });

  it("the absence assertion is stored but changes no positive statistic", async () => {
    for (const turn of fixture.turns) await ingest(store, turn);

    const absence = store.interactionEvents.filter((e) => e.polarity === "absence");
    expect(absence).toHaveLength(1);
    expect(absence[0].windowStart).not.toBeNull();
    expect(absence[0].windowEnd).not.toBeNull();

    const baseline = [...store.baselines.values()].find((b) => b.eventType === "visit")!;
    expect(baseline.observationCount).toBe(5); // the absence is not counted
    expect(baseline.status).toBe("ACTIVE");
  });

  it("stops at the threshold — no signal or reconnect artefact exists", async () => {
    for (const turn of fixture.turns) await ingest(store, turn);
    // The most recent visit is 2026-09-09; "now" is 2026-09-16, a 7-day gap
    // against a threshold of 11. M3 computes both and compares neither.
    expect(store).not.toHaveProperty("signals");
    expect(store).not.toHaveProperty("reconnectOpportunities");
    expect(store).not.toHaveProperty("consentGrants");
  });
});

describe("MANDATORY: replay idempotency", () => {
  it("running the same observation twice yields ONE interaction event", async () => {
    const turn = fixture.turns[0];
    await ingest(store, turn);
    expect(store.interactionEvents).toHaveLength(1);

    // Force the commit phase to run again against the same observation.
    store.observations[0].processedAt = null;
    await ingest(store, turn);

    expect(store.interactionEvents).toHaveLength(1);
  });

  it("the whole series replayed produces identical events and baseline", async () => {
    for (const turn of fixture.turns) await ingest(store, turn);
    const snapshot = JSON.stringify({
      events: store.interactionEvents,
      baselines: [...store.baselines.entries()],
    });

    for (const observation of store.observations) observation.processedAt = null;
    for (const turn of fixture.turns) await ingest(store, turn);

    expect(
      JSON.stringify({
        events: store.interactionEvents,
        baselines: [...store.baselines.entries()],
      }),
    ).toBe(snapshot);
  });
});

describe("MANDATORY: same-day distinctness", () => {
  it("two calls on one day are TWO events but ONE statistical day", async () => {
    const callTurn = fixture.turns.find((t) => t.messageId === "cm1")!;
    await ingest(store, callTurn);

    const calls = store.interactionEvents.filter((e) => e.eventType === "call");
    expect(calls).toHaveLength(2);
    expect(calls[0].occurredAt).toBe(calls[1].occurredAt);
    expect(calls[0].ingestFingerprint).not.toBe(calls[1].ingestFingerprint);

    const baseline = [...store.baselines.values()].find((b) => b.eventType === "call")!;
    expect(baseline.observationCount).toBe(2);
    expect(baseline.statisticalDayCount).toBe(1);
    // One day cannot be a rhythm.
    expect(baseline.status).toBe("NO_BASELINE");
    expect(baseline.medianGapDays).toBeNull();
  });
});
