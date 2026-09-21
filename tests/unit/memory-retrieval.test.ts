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

/**
 * The mentioned-this-turn signal (M12d).
 *
 * `selectEntities` has always computed which entities the person named in
 * this message — it is how they get sorted to the front — and for four
 * milestones it discarded that, handing the model one undifferentiated
 * list. "John called yesterday" got "That's nice to hear."
 *
 * Asserted here and not only in the context renderer: a revert of this
 * plumbing produced no reds at all the first time it was proved, which is
 * exactly the coverage gap a revert proof exists to find.
 */
describe("mentionedNow", () => {
  const recent = (days: number) =>
    new Date(NOW.getTime() - days * 86_400_000).toISOString();

  it("names the entity the person just mentioned", async () => {
    const memory = await loadMemoryForTurn(
      deps({ entities: [entity("e1", "Margaret")] }),
      { userId: USER, text: "Margaret came round today", now: NOW },
    );
    expect(memory.mentionedNow).toEqual(["Margaret"]);
  });

  it("is empty when they named nobody", async () => {
    const memory = await loadMemoryForTurn(
      deps({ entities: [entity("e1", "Margaret")] }),
      { userId: USER, text: "it was a lovely morning", now: NOW },
    );
    expect(memory.mentionedNow).toEqual([]);
  });

  it("does NOT include a merely recently-active entity", async () => {
    // The distinction the whole signal exists for: a card is offered for
    // somebody active last Tuesday, but nothing points at them.
    const memory = await loadMemoryForTurn(
      deps({
        entities: [
          entity("e1", "Margaret"),
          entity("e2", "Alan", { lastMentionedAt: recent(1) }),
        ],
      }),
      { userId: USER, text: "Margaret came round today", now: NOW },
    );
    expect(memory.entityCards.join("\n")).toContain("Alan");
    expect(memory.mentionedNow).toEqual(["Margaret"]);
  });

  it("names both when both were mentioned", async () => {
    const memory = await loadMemoryForTurn(
      deps({ entities: [entity("e1", "Margaret"), entity("e2", "Alan")] }),
      { userId: USER, text: "Alan and Margaret were both here", now: NOW },
    );
    expect([...memory.mentionedNow].sort()).toEqual(["Alan", "Margaret"]);
  });

  it("never names somebody with no card — a pointer, not a claim", async () => {
    // Capped at `entityCardLimit`, so a mention beyond the cap has no card
    // and must not be pointed at.
    const many = Array.from({ length: memoryConfig.entityCardLimit + 3 }, (_, i) =>
      entity(`e${i}`, `Person${i}`),
    );
    const text = many.map((e) => e.displayName).join(" and ");
    const memory = await loadMemoryForTurn(deps({ entities: many }), {
      userId: USER,
      text,
      now: NOW,
    });
    expect(memory.mentionedNow.length).toBe(memory.entityCards.length);
    for (const name of memory.mentionedNow) {
      expect(memory.entityCards.join("\n")).toContain(name);
    }
  });
});
