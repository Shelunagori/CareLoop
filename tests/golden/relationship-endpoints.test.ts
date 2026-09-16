import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ExtractionV1Schema, type ExtractionV1 } from "@/core/memory/extraction-contract";
import { processIngestJob } from "@/server/services/ingestion";
import {
  createStore,
  fakeEmbeddings,
  fakeExtraction,
  ingestionDeps,
  resetIds,
} from "../unit/memory-fakes";

/**
 * Relationship ENDPOINT regression.
 *
 * Live extraction put the role phrase in fromMention — {kind: "son",
 * fromMention: "my son", toMention: "John"} — which the deterministic layer
 * correctly refused to commit, so the son edge was silently never created.
 * These tests assert where each edge actually lands, not merely that the
 * payload validates: schema validity was never the thing that broke.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

type Case = {
  name: string;
  utterance: string;
  createdAt: string;
  extraction: ExtractionV1;
  expect: {
    entities: Array<[string, string, string | null]>;
    relationships: Array<[string | null, string, string]>;
  };
};

const fixture = JSON.parse(
  readFileSync(
    path.join(root, "fixtures/recorded-extractions/relationship-endpoints.extraction.v1.json"),
    "utf8",
  ),
) as { cases: Case[] };

const USER = "endpoint-user";

async function ingest(extraction: ExtractionV1, utterance: string, createdAt: string) {
  resetIds();
  const store = createStore([
    { id: "m1", role: "user", content: utterance, createdAt },
  ]);
  await processIngestJob(
    ingestionDeps(store, {
      extraction: fakeExtraction(extraction, { store }),
      embeddings: fakeEmbeddings({ store }),
    }),
    {
      id: "job-1",
      key: "a1",
      payload: {
        conversationId: "conv-1",
        userMessageId: "m1",
        assistantMessageId: "a1",
        userId: USER,
      },
      attempts: 1,
    },
  );
  return store;
}

/** Edges as [sourceName | null, targetName, kind] — the thing that regressed. */
function edges(store: Awaited<ReturnType<typeof ingest>>) {
  const nameOf = (id: string | null) =>
    id === null ? null : (store.entities.find((e) => e.id === id)?.displayName ?? "??");
  return store.relationships
    .map((r) => [nameOf(r.fromEntityId), nameOf(r.toEntityId), r.kind] as const)
    .sort((a, b) => `${a[2]}${a[1]}`.localeCompare(`${b[2]}${b[1]}`));
}

describe("relationship endpoints", () => {
  for (const testCase of fixture.cases) {
    describe(testCase.name, () => {
      it("the recorded extraction satisfies the contract", () => {
        expect(ExtractionV1Schema.safeParse(testCase.extraction).success).toBe(true);
      });

      it(`"${testCase.utterance}" lands its edges on the right ends`, async () => {
        const store = await ingest(
          testCase.extraction,
          testCase.utterance,
          testCase.createdAt,
        );

        const actualEntities = [...store.entities]
          .map((e) => [e.displayName, e.type, e.subtype] as const)
          .sort((a, b) => a[0].localeCompare(b[0]));
        expect(actualEntities).toEqual(
          [...testCase.expect.entities].sort((a, b) => a[0].localeCompare(b[0])),
        );

        expect(edges(store)).toEqual(
          [...testCase.expect.relationships].sort((a, b) =>
            `${a[2]}${a[1]}`.localeCompare(`${b[2]}${b[1]}`),
          ),
        );

        // No entity is ever created for the person writing.
        expect(store.entities.map((e) => e.displayName.toLowerCase())).not.toContain("me");
        // A role phrase is never stored as a person.
        for (const name of store.entities.map((e) => e.displayName.toLowerCase())) {
          expect(name.startsWith("my ")).toBe(false);
        }
      });
    });
  }
});

describe("the live failure mode, reproduced", () => {
  /** Exactly what the live model returned before the prompt fix. */
  const buggy: ExtractionV1 = {
    entities: [
      { mention: "John", canonicalName: "John", type: "person", subtype: null, confidence: 0.95, sourceSpan: "My son John" },
      { mention: "Simba", canonicalName: "Simba", type: "pet", subtype: "dog", confidence: 0.93, sourceSpan: "his dog Simba" },
    ],
    relationships: [
      { fromMention: "my son", toMention: "John", kind: "son", explicitlyConfirmed: false, confidence: 0.95, sourceSpan: "My son John" },
      { fromMention: "John", toMention: "Simba", kind: "pet", explicitlyConfirmed: false, confidence: 0.92, sourceSpan: "his dog Simba" },
    ],
    facts: [],
    episodes: [],
  };

  it("is refused rather than mis-attached, and says so in the resolution", async () => {
    const store = await ingest(
      buggy,
      "My son John visited yesterday with his dog Simba.",
      "2026-09-16T10:00:00.000Z",
    );

    // The pet edge still lands; only the malformed one is dropped.
    expect(edges(store)).toEqual([["John", "Simba", "pet"]]);
    // Critically: no edge was invented from a role phrase.
    expect(store.entities.map((e) => e.displayName)).not.toContain("my son");

    const resolution = store.observations[0].resolution as { skipped: string[] } | null;
    expect(resolution?.skipped).toContain("relationship:son:John");
  });
});

describe("self-reference guard (defence in depth)", () => {
  const selfy: ExtractionV1 = {
    entities: [
      { mention: "me", canonicalName: "me", type: "person", subtype: null, confidence: 0.9, sourceSpan: "me" },
      { mention: "Sarah", canonicalName: "Sarah", type: "person", subtype: null, confidence: 0.95, sourceSpan: "My daughter Sarah" },
    ],
    relationships: [
      { fromMention: "me", toMention: "Sarah", kind: "daughter", explicitlyConfirmed: false, confidence: 0.94, sourceSpan: "My daughter Sarah" },
      { fromMention: "Sarah", toMention: "myself", kind: "mother", explicitlyConfirmed: false, confidence: 0.6, sourceSpan: "called me" },
    ],
    facts: [
      { subjectMention: "I", key: "preferred_drink", value: "tea", explicitlyConfirmed: false, confidence: 0.8, sourceSpan: "I have tea" },
    ],
    episodes: [],
  };

  it("treats a bare pronoun as the user, never as an entity", async () => {
    const store = await ingest(selfy, "My daughter Sarah called me.", "2026-09-17T11:00:00.000Z");

    // "me" produced no entity row.
    expect(store.entities.map((e) => e.displayName)).toEqual(["Sarah"]);
    // fromMention "me" became the user (null source), so the edge still lands.
    expect(edges(store)).toEqual([[null, "Sarah", "daughter"]]);
    // An edge pointing AT the user has nowhere to land and is skipped.
    const resolution = store.observations[0].resolution as { skipped: string[] } | null;
    expect(resolution?.skipped).toContain("relationship:mother:self_target");
    // subjectMention "I" became a fact about the user.
    expect(store.facts).toHaveLength(1);
    expect(store.facts[0].subjectEntityId).toBeNull();
    expect(store.facts[0].value).toBe("tea");
  });
});
