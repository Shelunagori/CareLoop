import { beforeEach, describe, expect, it } from "vitest";
import type { ExtractionV1 } from "@/core/memory/extraction-contract";
import type { StoredMessage } from "@/server/repositories/messages";
import { processIngestJob, runIngestionSweep } from "@/server/services/ingestion";
import {
  createStore,
  fakeEmbeddings,
  fakeExtraction,
  ingestionDeps,
  resetIds,
  type MemoryStore,
} from "./memory-fakes";

const USER = "user-a";
const CONVERSATION_A = "conv-a";
const CONVERSATION_B = "conv-b";

function message(id: string, content: string, at = "2026-09-16T10:00:00.000Z"): StoredMessage {
  return { id, role: "user", content, createdAt: at };
}

/** The demo utterance, but nothing about it is special-cased anywhere. */
const JOHN_AND_SIMBA: ExtractionV1 = {
  entities: [
    {
      mention: "my son John",
      canonicalName: "John",
      type: "person",
      subtype: null,
      confidence: 0.95,
      sourceSpan: "My son John",
    },
    {
      mention: "his dog Simba",
      canonicalName: "Simba",
      type: "pet",
      subtype: "dog",
      confidence: 0.93,
      sourceSpan: "his dog Simba",
    },
  ],
  relationships: [
    {
      fromMention: null,
      toMention: "my son John",
      kind: "son",
      explicitlyConfirmed: false,
      confidence: 0.94,
      sourceSpan: "My son John",
    },
    {
      fromMention: "my son John",
      toMention: "his dog Simba",
      kind: "pet",
      explicitlyConfirmed: false,
      confidence: 0.9,
      sourceSpan: "his dog Simba",
    },
  ],
  facts: [],
  episodes: [
    {
      summary: "John visited with his dog Simba.",
      participantMentions: ["my son John", "his dog Simba"],
      temporal: { expression: "yesterday", absoluteDate: null },
      emotionWords: [],
      confidence: 0.9,
      sourceSpan: "visited yesterday",
    },
  ],
};

function job(store: MemoryStore, key: string, userMessageId: string, conversationId: string) {
  return {
    id: `job-${key}`,
    key,
    payload: { conversationId, userMessageId, assistantMessageId: key, userId: USER },
    attempts: 1,
  };
}

let store: MemoryStore;

beforeEach(() => {
  resetIds();
  store = createStore([message("m1", "My son John visited yesterday with his dog Simba.")]);
});

describe("1. valid extraction creates an observation", () => {
  it("persists the model output verbatim as an append-only provenance record", async () => {
    const deps = ingestionDeps(store, {
      extraction: fakeExtraction(JOHN_AND_SIMBA, { store }),
      embeddings: fakeEmbeddings({ store }),
    });
    await processIngestJob(deps, job(store, "a1", "m1", CONVERSATION_A));

    expect(store.observations).toHaveLength(1);
    expect(store.observations[0].kind).toBe("extraction.v1");
    expect(store.observations[0].payload).toEqual(JOHN_AND_SIMBA);
  });
});

describe("2. observation is persisted before any belief is committed", () => {
  it("writes the audit record first, then derives memory from it", async () => {
    const deps = ingestionDeps(store, {
      extraction: fakeExtraction(JOHN_AND_SIMBA, { store }),
      embeddings: fakeEmbeddings({ store }),
    });
    await processIngestJob(deps, job(store, "a1", "m1", CONVERSATION_A));

    const observationIndex = store.calls.indexOf("observations.insert");
    const firstBelief = store.calls.findIndex((c) => c.startsWith("entities.create"));
    expect(observationIndex).toBeGreaterThanOrEqual(0);
    expect(observationIndex).toBeLessThan(firstBelief);
  });
});

describe("3-5. entity resolution", () => {
  it("3. reuses an entity on an exact name match instead of duplicating", async () => {
    const deps = ingestionDeps(store, {
      extraction: fakeExtraction(JOHN_AND_SIMBA, { store }),
      embeddings: fakeEmbeddings({ store }),
    });
    await processIngestJob(deps, job(store, "a1", "m1", CONVERSATION_A));
    expect(store.entities.map((e) => e.displayName).sort()).toEqual(["John", "Simba"]);

    store.messages.push(message("m2", "John came again."));
    await processIngestJob(
      ingestionDeps(store, {
        extraction: fakeExtraction(
          {
            ...JOHN_AND_SIMBA,
            episodes: [{ ...JOHN_AND_SIMBA.episodes[0], summary: "John came again." }],
          },
          { store },
        ),
        embeddings: fakeEmbeddings({ store }),
      }),
      job(store, "a2", "m2", CONVERSATION_B),
    );

    expect(store.entities).toHaveLength(2);
  });

  it("4. reuses an entity via an alias recorded on a previous turn", async () => {
    store.entities.push({
      id: "e-john",
      type: "person",
      subtype: null,
      displayName: "John",
      aliases: ["Johnny"],
      status: "active",
      lastMentionedAt: null,
    });

    const extraction: ExtractionV1 = {
      entities: [
        {
          mention: "Johnny",
          canonicalName: "Johnny",
          type: "person",
          subtype: null,
          confidence: 0.9,
          sourceSpan: "Johnny",
        },
      ],
      relationships: [],
      facts: [],
      episodes: [],
    };

    await processIngestJob(
      ingestionDeps(store, {
        extraction: fakeExtraction(extraction, { store }),
        embeddings: fakeEmbeddings({ store }),
      }),
      job(store, "a1", "m1", CONVERSATION_A),
    );

    expect(store.entities).toHaveLength(1);
    expect(store.observations[0].processedAt).not.toBeNull();
  });

  it("5. does NOT silently merge when two people share a name", async () => {
    store.entities.push(
      { id: "e-john-1", type: "person", subtype: null, displayName: "John", aliases: [], status: "active", lastMentionedAt: null },
      { id: "e-john-2", type: "person", subtype: null, displayName: "John", aliases: [], status: "active", lastMentionedAt: null },
    );

    const extraction: ExtractionV1 = {
      entities: [
        { mention: "John", canonicalName: "John", type: "person", subtype: null, confidence: 0.9, sourceSpan: "John" },
      ],
      relationships: [
        { fromMention: null, toMention: "John", kind: "son", explicitlyConfirmed: false, confidence: 0.9, sourceSpan: "John" },
      ],
      facts: [],
      episodes: [],
    };

    await processIngestJob(
      ingestionDeps(store, {
        extraction: fakeExtraction(extraction, { store }),
        embeddings: fakeEmbeddings({ store }),
      }),
      job(store, "a1", "m1", CONVERSATION_A),
    );

    // No third John invented, and no relationship attached to a guess.
    expect(store.entities).toHaveLength(2);
    expect(store.relationships).toHaveLength(0);
    const resolution = store.observations[0];
    expect(resolution.processedAt).not.toBeNull();
  });
});

describe("6-7. evidence promotion across conversations", () => {
  it("6. leaves a relationship a candidate after one conversation", async () => {
    await processIngestJob(
      ingestionDeps(store, {
        extraction: fakeExtraction(JOHN_AND_SIMBA, { store }),
        embeddings: fakeEmbeddings({ store }),
      }),
      job(store, "a1", "m1", CONVERSATION_A),
    );

    const son = store.relationships.find((r) => r.kind === "son")!;
    expect(son.status).toBe("candidate");
    expect(son.evidenceCount).toBe(1);
  });

  it("7. confirms it on a second, DISTINCT conversation", async () => {
    await processIngestJob(
      ingestionDeps(store, {
        extraction: fakeExtraction(JOHN_AND_SIMBA, { store }),
        embeddings: fakeEmbeddings({ store }),
      }),
      job(store, "a1", "m1", CONVERSATION_A),
    );

    store.messages.push(message("m2", "John is coming again."));
    await processIngestJob(
      ingestionDeps(store, {
        extraction: fakeExtraction(
          { ...JOHN_AND_SIMBA, episodes: [] },
          { store },
        ),
        embeddings: fakeEmbeddings({ store }),
      }),
      job(store, "a2", "m2", CONVERSATION_B),
    );

    const son = store.relationships.find((r) => r.kind === "son")!;
    expect(son.status).toBe("confirmed");
    expect(son.evidenceCount).toBe(2);
    // The species is on the entity, never on the edge (R1).
    expect(store.relationships.map((r) => r.kind).sort()).toEqual(["pet", "son"]);
    expect(store.entities.find((e) => e.displayName === "Simba")?.subtype).toBe("dog");
  });
});

describe("8. episodes and membership", () => {
  it("creates an episode with resolved time, salience and member rows", async () => {
    await processIngestJob(
      ingestionDeps(store, {
        extraction: fakeExtraction(JOHN_AND_SIMBA, { store }),
        embeddings: fakeEmbeddings({ store }),
      }),
      job(store, "a1", "m1", CONVERSATION_A),
    );

    expect(store.episodes).toHaveLength(1);
    const episode = store.episodes[0];
    expect(episode.summary).toBe("John visited with his dog Simba.");
    // "yesterday" resolved deterministically against the message timestamp.
    expect(episode.occurredAt).toBe("2026-09-15T00:00:00.000Z");
    expect(episode.precision).toBe("day");
    expect(episode.salience).toBeGreaterThan(0.2);
    expect(episode.embedding).not.toBeNull();

    expect(store.episodeMembers).toHaveLength(2);
    const memberNames = store.episodeMembers
      .map((m) => store.entities.find((e) => e.id === m.entityId)?.displayName)
      .sort();
    expect(memberNames).toEqual(["John", "Simba"]);
  });
});

describe("9. embedding failure", () => {
  it("leaves the job retryable and writes no partial episode", async () => {
    const deps = ingestionDeps(store, {
      extraction: fakeExtraction(JOHN_AND_SIMBA, { store }),
      embeddings: fakeEmbeddings({ store, failWith: new Error("embedding upstream down") }),
    });

    await expect(processIngestJob(deps, job(store, "a1", "m1", CONVERSATION_A))).rejects.toThrow(
      /embedding upstream down/,
    );

    expect(store.episodes).toHaveLength(0);
    expect(store.episodeMembers).toHaveLength(0);
    // The observation survives, unprocessed — so a retry does not re-extract.
    expect(store.observations).toHaveLength(1);
    expect(store.observations[0].processedAt).toBeNull();
  });
});

describe("10 & 12. sweep outcomes", () => {
  it("10. marks the job completed on success", async () => {
    store.jobs.push({
      id: "j1",
      key: "a1",
      payload: { conversationId: CONVERSATION_A, userMessageId: "m1", assistantMessageId: "a1", userId: USER },
      attempts: 0,
      completedAt: null,
      lastError: null,
    });

    const results = await runIngestionSweep(
      ingestionDeps(store, {
        extraction: fakeExtraction(JOHN_AND_SIMBA, { store }),
        embeddings: fakeEmbeddings({ store }),
      }),
      { limit: 5 },
    );

    expect(results).toEqual([{ jobId: "j1", outcome: "committed" }]);
    expect(store.jobs[0].completedAt).not.toBeNull();
  });

  it("12. records the attempt and error safely on failure", async () => {
    store.jobs.push({
      id: "j1",
      key: "a1",
      payload: { conversationId: CONVERSATION_A, userMessageId: "m1", assistantMessageId: "a1", userId: USER },
      attempts: 0,
      completedAt: null,
      lastError: null,
    });

    await runIngestionSweep(
      ingestionDeps(store, {
        extraction: fakeExtraction(JOHN_AND_SIMBA, { store, failWith: new Error("upstream 500") }),
        embeddings: fakeEmbeddings({ store }),
      }),
      { limit: 5 },
    );

    expect(store.jobs[0].completedAt).toBeNull();
    expect(store.jobs[0].attempts).toBe(1);
    expect(store.jobs[0].lastError).toContain("upstream 500");
    // No message content leaked into the error field.
    expect(store.jobs[0].lastError).not.toContain("Simba");
  });

  it("rejects schema-invalid extraction without touching memory", async () => {
    store.jobs.push({
      id: "j1",
      key: "a1",
      payload: { conversationId: CONVERSATION_A, userMessageId: "m1", assistantMessageId: "a1", userId: USER },
      attempts: 0,
      completedAt: null,
      lastError: null,
    });

    await runIngestionSweep(
      ingestionDeps(store, {
        extraction: fakeExtraction(JOHN_AND_SIMBA, {
          store,
          rawOverride: { entities: "not an array", relationships: [], facts: [], episodes: [] },
        }),
        embeddings: fakeEmbeddings({ store }),
      }),
      { limit: 5 },
    );

    expect(store.observations).toHaveLength(0);
    expect(store.entities).toHaveLength(0);
    expect(store.jobs[0].lastError).toContain("ExtractionSchemaError");
    expect(store.jobs[0].completedAt).toBeNull();
  });
});

describe("11. replay safety", () => {
  it("produces identical memory when the same job is processed twice", async () => {
    const providers = () => ({
      extraction: fakeExtraction(JOHN_AND_SIMBA, { store }),
      embeddings: fakeEmbeddings({ store }),
    });

    await processIngestJob(ingestionDeps(store, providers()), job(store, "a1", "m1", CONVERSATION_A));

    const snapshot = JSON.stringify({
      entities: store.entities,
      relationships: store.relationships,
      facts: store.facts,
      episodes: store.episodes,
      members: store.episodeMembers,
      observations: store.observations.length,
    });

    const second = fakeExtraction(JOHN_AND_SIMBA, { store });
    const outcome = await processIngestJob(
      ingestionDeps(store, { extraction: second, embeddings: fakeEmbeddings({ store }) }),
      job(store, "a1", "m1", CONVERSATION_A),
    );

    expect(outcome).toBe("already_processed");
    // The extraction model is not called a second time.
    expect(second.calls).toBe(0);
    expect(
      JSON.stringify({
        entities: store.entities,
        relationships: store.relationships,
        facts: store.facts,
        episodes: store.episodes,
        members: store.episodeMembers,
        observations: store.observations.length,
      }),
    ).toBe(snapshot);
  });

  it("does not inflate evidence when the same observation is re-committed", async () => {
    await processIngestJob(
      ingestionDeps(store, {
        extraction: fakeExtraction(JOHN_AND_SIMBA, { store }),
        embeddings: fakeEmbeddings({ store }),
      }),
      job(store, "a1", "m1", CONVERSATION_A),
    );

    // Simulate a crash between committing memory and marking the observation
    // processed: the commit phase runs again against the same observation.
    store.observations[0].processedAt = null;

    await processIngestJob(
      ingestionDeps(store, {
        extraction: fakeExtraction(JOHN_AND_SIMBA, { store }),
        embeddings: fakeEmbeddings({ store }),
      }),
      job(store, "a1", "m1", CONVERSATION_A),
    );

    const son = store.relationships.find((r) => r.kind === "son")!;
    expect(son.evidenceCount).toBe(1);
    expect(son.status).toBe("candidate");
    expect(store.episodes).toHaveLength(1);
    expect(store.entities).toHaveLength(2);
  });
});
