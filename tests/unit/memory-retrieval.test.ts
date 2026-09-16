import { describe, expect, it } from "vitest";
import { memoryConfig } from "@/server/config";
import type { EntityRecord } from "@/server/repositories/entities";
import { loadMemoryForTurn, type MemoryRetrievalDeps } from "@/server/services/memory-retrieval";

const NOW = new Date("2026-09-20T10:00:00.000Z");
const USER = "user-a";

function entity(id: string, name: string, extra: Partial<EntityRecord> = {}): EntityRecord {
  return {
    id,
    type: "person",
    subtype: null,
    displayName: name,
    aliases: [],
    status: "active",
    lastMentionedAt: null,
    ...extra,
  };
}

function deps(options: {
  entities?: EntityRecord[];
  episodes?: Array<{ id: string; summary: string; similarity: number }>;
  embedFails?: boolean;
  onMatch?: (userId: string, limit: number) => void;
}): MemoryRetrievalDeps {
  return {
    entities: {
      async listForUser() {
        return options.entities ?? [];
      },
      async listRecentlyMentioned() {
        return [];
      },
      async create() {
        throw new Error("unused");
      },
      async addAlias() {},
      async touchMention() {},
      async flagNeedsConfirmation() {},
    },
    relationships: {
      async listForUser() {
        return [];
      },
      async find() {
        return null;
      },
      async create() {
        throw new Error("unused");
      },
      async updateEvidence() {
        throw new Error("unused");
      },
    },
    facts: {
      async listForSubject() {
        return [];
      },
      async find() {
        return null;
      },
      async create() {
        throw new Error("unused");
      },
      async updateEvidence() {
        throw new Error("unused");
      },
    },
    episodes: {
      async listBySourceMessage() {
        return [];
      },
      async listRecent() {
        return [];
      },
      async create() {
        throw new Error("unused");
      },
      async setEmbedding() {},
      async addMembers() {},
      async matchByEmbedding(userId, _embedding, limit) {
        options.onMatch?.(userId, limit);
        return (options.episodes ?? []).map((e) => ({
          id: e.id,
          summary: e.summary,
          occurredAt: "2026-09-15T00:00:00.000Z",
          precision: "day" as const,
          salience: 0.5,
          similarity: e.similarity,
        }));
      },
    },
    embeddings: {
      async embed(texts) {
        if (options.embedFails) throw new Error("embedding upstream down");
        return texts.map(() => [0.1, 0.2, 0.3]);
      },
    },
  };
}

describe("bounded memory retrieval", () => {
  it("caps entity cards at the configured limit", async () => {
    const many = Array.from({ length: 30 }, (_, i) => entity(`e${i}`, `Person${i}`));
    const memory = await loadMemoryForTurn(deps({ entities: many }), {
      userId: USER,
      text: "hello",
      now: NOW,
    });
    expect(memory.entityCards.length).toBeLessThanOrEqual(memoryConfig.entityCardLimit);
  });

  it("prefers entities actually mentioned in the turn", async () => {
    const memory = await loadMemoryForTurn(
      deps({ entities: [entity("e1", "Margaret"), entity("e2", "Simba")] }),
      { userId: USER, text: "Has Simba been round?", now: NOW },
    );
    expect(memory.entityCards.join("\n")).toContain("Simba");
  });

  it("asks for no more than topK episodes and drops weak matches", async () => {
    let requestedLimit = -1;
    const memory = await loadMemoryForTurn(
      deps({
        episodes: [
          { id: "p1", summary: "John visited with Simba", similarity: 0.85 },
          { id: "p2", summary: "Unrelated musing", similarity: 0.01 },
        ],
        onMatch: (_userId, limit) => {
          requestedLimit = limit;
        },
      }),
      { userId: USER, text: "What do you remember about Simba?", now: NOW },
    );

    expect(requestedLimit).toBe(memoryConfig.episodeTopK);
    expect(memory.episodes).toHaveLength(1);
    expect(memory.episodes[0]).toContain("John visited with Simba");
  });

  it("scopes the vector search to this user", async () => {
    let seenUser = "";
    await loadMemoryForTurn(
      deps({ onMatch: (userId) => { seenUser = userId; } }),
      { userId: USER, text: "anything", now: NOW },
    );
    expect(seenUser).toBe(USER);
  });

  it("degrades to no episodes when embedding fails, rather than failing the turn", async () => {
    const memory = await loadMemoryForTurn(deps({ embedFails: true }), {
      userId: USER,
      text: "hello",
      now: NOW,
    });
    expect(memory.episodes).toEqual([]);
  });

  it("leaves the M4/M5 seams unfilled", async () => {
    const memory = await loadMemoryForTurn(deps({}), {
      userId: USER,
      text: "hello",
      now: NOW,
    });
    expect(memory.pendingClosure).toBeNull();
    expect(memory.draftedOpportunityMarker).toBeNull();
  });
});
