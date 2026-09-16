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
 * Golden ingestion test (docs/06 §17, layer 3).
 *
 * A fixed utterance plus recorded extraction output, replayed through the real
 * ingestion pipeline. This exercises the deterministic half at full fidelity
 * with no network and no cost — and it is the same replay mechanism the M6
 * demo fixture will use, which is why the demo can be trusted as evidence.
 *
 * George/John/Simba appear HERE, in a fixture, and nowhere in production code.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

type RecordedTurn = {
  conversationId: string;
  messageId: string;
  createdAt: string;
  utterance: string;
  extraction: ExtractionV1;
};

const recorded = JSON.parse(
  readFileSync(
    path.join(root, "fixtures/recorded-extractions/john-simba.extraction.v1.json"),
    "utf8",
  ),
) as { turns: RecordedTurn[] };

const USER = "golden-user";

describe("golden: two conversations about John and Simba", () => {
  it("the recording still satisfies the extraction contract", () => {
    for (const turn of recorded.turns) {
      expect(ExtractionV1Schema.safeParse(turn.extraction).success).toBe(true);
    }
  });

  it("produces entities, relationships, facts, an episode and membership rows", async () => {
    resetIds();
    const store = createStore(
      recorded.turns.map((turn) => ({
        id: turn.messageId,
        role: "user" as const,
        content: turn.utterance,
        createdAt: turn.createdAt,
      })),
    );

    for (const turn of recorded.turns) {
      await processIngestJob(
        ingestionDeps(store, {
          extraction: fakeExtraction(turn.extraction, { store }),
          embeddings: fakeEmbeddings({ store }),
        }),
        {
          id: `job-${turn.messageId}`,
          key: `assistant-${turn.messageId}`,
          payload: {
            conversationId: turn.conversationId,
            userMessageId: turn.messageId,
            assistantMessageId: `assistant-${turn.messageId}`,
            userId: USER,
          },
          attempts: 1,
        },
      );
    }

    // --- entities: what each thing IS -------------------------------------
    const entities = [...store.entities].sort((a, b) =>
      a.displayName.localeCompare(b.displayName),
    );
    expect(entities.map((e) => e.displayName)).toEqual(["John", "Simba"]);
    expect(entities.map((e) => e.type)).toEqual(["person", "pet"]);
    expect(entities.find((e) => e.displayName === "Simba")?.subtype).toBe("dog");

    const john = entities.find((e) => e.displayName === "John")!;
    const simba = entities.find((e) => e.displayName === "Simba")!;

    // --- relationships: how things RELATE ---------------------------------
    const son = store.relationships.find((r) => r.kind === "son")!;
    expect(son.fromEntityId).toBeNull(); // the user
    expect(son.toEntityId).toBe(john.id);
    // Two distinct conversations of evidence.
    expect(son.evidenceCount).toBe(2);
    expect(son.status).toBe("confirmed");

    const pet = store.relationships.find((r) => r.kind === "pet")!;
    expect(pet.fromEntityId).toBe(john.id);
    expect(pet.toEntityId).toBe(simba.id);
    expect(pet.status).toBe("confirmed");

    // A species is never a relationship kind (R1).
    expect(store.relationships.map((r) => r.kind)).not.toContain("dog");

    // --- facts ------------------------------------------------------------
    const drink = store.facts.find((f) => f.key === "preferred_drink")!;
    expect(drink.subjectEntityId).toBeNull(); // about the user
    expect(drink.value).toBe("tea");
    expect(drink.status).toBe("candidate"); // one conversation only

    // --- episodes ---------------------------------------------------------
    expect(store.episodes).toHaveLength(2);
    const first = store.episodes[0];
    // "yesterday" resolved against the message timestamp, not by the model.
    expect(first.occurredAt).toBe("2026-09-15T00:00:00.000Z");
    expect(first.precision).toBe("day");
    expect(first.embedding).not.toBeNull();

    // The second turn gave no time phrase, so precision is honest about that.
    expect(store.episodes[1].precision).toBe("unknown");

    // --- membership through the join table only (F4) -----------------------
    expect(store.episodeMembers).toHaveLength(4);
    const membersOfFirst = store.episodeMembers
      .filter((m) => m.episodeId === first.id)
      .map((m) => m.entityId)
      .sort();
    expect(membersOfFirst).toEqual([john.id, simba.id].sort());

    // --- scope: M3+ artefacts must not exist -------------------------------
    expect(store).not.toHaveProperty("interactionEvents");
    expect(store).not.toHaveProperty("baselines");
    expect(store).not.toHaveProperty("signals");
  });
});
