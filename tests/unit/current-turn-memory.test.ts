import { beforeEach, describe, expect, it } from "vitest";
import type { ExtractionV1 } from "@/core/memory/extraction-contract";
import type { StoredMessage } from "@/server/repositories/messages";
import { processIngestJob } from "@/server/services/ingestion";
import { loadMemoryForTurn } from "@/server/services/memory-retrieval";
import { assembleContext, EMPTY_MEMORY } from "@/server/services/context";
import {
  createStore,
  fakeEmbeddings,
  fakeExtraction,
  fakeMemoryRepos,
  ingestionDeps,
  resetIds,
  type MemoryStore,
} from "./memory-fakes";

/**
 * THE CURRENT TURN OUTRANKS REMEMBERED CONTEXT (M12e).
 *
 * Observed in a real browser: "Don sent me a message today" was answered
 * with a question about John. Don had never been mentioned before, so he
 * had no card; John had, and was sitting in the recently-active cards. The
 * model was handed a page about John and nothing about Don, and wrote about
 * John.
 *
 * Two halves, and both are here: Don has to BECOME something, and John must
 * stop being volunteered on a turn nobody asked about him.
 */
const USER = "user-a";
const NOW = new Date("2026-09-21T12:00:00.000Z");

function message(id: string, content: string, at = "2026-09-21T11:00:00.000Z"): StoredMessage {
  return { id, role: "user", content, createdAt: at };
}

const DON_MESSAGE: ExtractionV1 = {
  entities: [
    {
      mention: "Don",
      canonicalName: "Don",
      type: "person",
      subtype: null,
      confidence: 0.9,
      sourceSpan: "Don sent me a message today",
    },
  ],
  // The person said nothing about WHO Don is, so the extractor claims
  // nothing. This is the shape the fix depends on.
  relationships: [],
  facts: [],
  episodes: [
    {
      summary: "Don sent a message.",
      participantMentions: ["Don"],
      temporal: { expression: "today", absoluteDate: null },
      emotionWords: [],
      confidence: 0.85,
      sourceSpan: "Don sent me a message today",
    },
  ],
  interactions: [],
};

let store: MemoryStore;

beforeEach(() => {
  resetIds();
  store = createStore([message("m1", "Don sent me a message today.")]);
});

const job = (userMessageId: string) => ({
  id: "job-1",
  key: "a1",
  payload: { conversationId: "conv-1", userMessageId, assistantMessageId: "a1", userId: USER },
  attempts: 1,
});

describe("6. an unseen name becomes an entity the next turn can use", () => {
  it("creates it from the person's own words, with no relationship invented", async () => {
    await processIngestJob(
      ingestionDeps(store, {
        extraction: fakeExtraction(DON_MESSAGE, { store }),
        embeddings: fakeEmbeddings({ store }),
      }),
      job("m1"),
    );

    const don = store.entities.find((entity) => entity.displayName === "Don");
    expect(don).toBeDefined();
    expect(don!.type).toBe("person");
    // 8. NO RELATIONSHIP IS INVENTED. Nothing was said about who Don is,
    // so nothing is stored about who Don is — not as a candidate, not as a
    // guess, not as a placeholder.
    expect(store.relationships).toHaveLength(0);
  });

  it("does not create one for a role phrase with no name", async () => {
    store = createStore([message("m1", "My son came round.")]);
    await processIngestJob(
      ingestionDeps(store, {
        extraction: fakeExtraction({
          ...DON_MESSAGE,
          entities: [
            {
              mention: "my son",
              canonicalName: "my son",
              type: "person",
              subtype: null,
              confidence: 0.9,
              sourceSpan: "My son",
            },
          ],
        }, { store }),
        embeddings: fakeEmbeddings({ store }),
      }),
      job("m1"),
    );
    expect(store.entities.filter((e) => e.type === "person")).toHaveLength(0);
  });
});

describe("7/10. an unrelated remembered person is not volunteered", () => {
  function withJohn() {
    const repos = { ...fakeMemoryRepos(store), embeddings: fakeEmbeddings({ store }) };
    store.entities.push({
      id: "entity-john",
      type: "person",
      subtype: null,
      displayName: "John",
      aliases: [],
      status: "active",
      origin: "user",
      lastMentionedAt: "2026-09-20T10:00:00.000Z",
    });
    return repos;
  }

  it("tells the model plainly that nobody it knows was named", async () => {
    const repos = withJohn();
    const memory = await loadMemoryForTurn(repos, {
      userId: USER,
      text: "Don sent me a message today.",
      now: NOW,
    });

    // John still appears as background — he was active yesterday — but he
    // is not spotlighted, and the turn says so.
    expect(memory.mentionedNow).toEqual([]);
    expect(memory.entityCards.join("\n")).toContain("John");

    const rendered = assembleContext({ recentTurns: [], memory }).messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n");
    expect(rendered).toContain("They have NOT named anyone above in this message");
    expect(rendered).toContain("do not substitute a name you do know");
  });

  it("spotlights the person when they ARE named, and drops the negative line", async () => {
    const repos = withJohn();
    const memory = await loadMemoryForTurn(repos, {
      userId: USER,
      text: "John called yesterday.",
      now: NOW,
    });
    expect(memory.mentionedNow).toEqual(["John"]);

    const rendered = assembleContext({ recentTurns: [], memory }).messages
      .filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n");
    expect(rendered).toContain("They have just mentioned John in this message.");
    expect(rendered).not.toContain("They have NOT named anyone above");
  });

  it("says nothing either way when there are no cards to be pulled towards", () => {
    const rendered = assembleContext({
      recentTurns: [],
      memory: { ...EMPTY_MEMORY, selfReportedWellbeing: true },
    })
      .messages.filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n");
    expect(rendered).not.toContain("They have NOT named anyone above");
  });
});

describe("9. an explicit wellbeing statement is answered as one", () => {
  it("asks for one gentle follow-up and forbids every overreach", () => {
    const rendered = assembleContext({
      recentTurns: [],
      memory: { ...EMPTY_MEMORY, selfReportedWellbeing: true },
    })
      .messages.filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n");

    expect(rendered).toContain("said they were unwell or in pain");
    expect(rendered).toContain("ask ONE gentle question");
    expect(rendered).toContain("Do not name a condition");
    expect(rendered).toContain("do not judge how serious it is");
    // The offer to tell somebody is the application's to make, never the
    // model's — that is the whole consent architecture.
    expect(rendered).toContain("offer to tell anybody");
  });

  it("10. still refuses to import unrelated family memory on that turn", async () => {
    const repos = { ...fakeMemoryRepos(store), embeddings: fakeEmbeddings({ store }) };
    store.entities.push({
      id: "entity-john",
      type: "person",
      subtype: null,
      displayName: "John",
      aliases: [],
      status: "active",
      origin: "user",
      lastMentionedAt: "2026-09-20T10:00:00.000Z",
    });
    const memory = await loadMemoryForTurn(repos, {
      userId: USER,
      text: "I was not feeling good today.",
      now: NOW,
    });
    const rendered = assembleContext({
      recentTurns: [],
      memory: { ...memory, selfReportedWellbeing: true },
    })
      .messages.filter((m) => m.role === "system")
      .map((m) => m.content)
      .join("\n");

    expect(memory.mentionedNow).toEqual([]);
    expect(rendered).toContain("They have NOT named anyone above in this message");
    expect(rendered).toContain("Do not change the subject to anyone in the notes above");
  });
});
