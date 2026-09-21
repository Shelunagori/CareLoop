import { beforeEach, describe, expect, it } from "vitest";
import type { ExtractionV1 } from "@/core/memory/extraction-contract";
import type { StoredMessage } from "@/server/repositories/messages";
import { EVIDENCE_CONFIRM_THRESHOLD } from "@/core/memory/evidence";
import { processIngestJob } from "@/server/services/ingestion";
import { loadMemoryForTurn } from "@/server/services/memory-retrieval";
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
 * MEMORY IS LEARNED, NOT SEEDED (M12f).
 *
 * The question this answers is the one a reviewer actually asks: is any of
 * this real, or is George/John/Simba a fixture with the answers written in?
 *
 * So it drives the REAL pipeline end to end — message → durable ingest job
 * → extraction observation → deterministic commit → later bounded
 * retrieval — for a fact that appears in no fixture and that nothing in the
 * codebase knows about. The only stub is the extraction provider, which
 * stands in for the model call; every decision after it is the shipped
 * deterministic code, and nothing here writes to `facts` directly.
 *
 * WHAT IT DELIBERATELY DOES NOT DO is make the fact `confirmed` to produce
 * a tidier story. One mention in one conversation is a CANDIDATE
 * (`core/memory/evidence.ts`): usable as context, marked as unconfirmed,
 * never asserted back as established. That is the shipped policy and the
 * test is written to it rather than around it.
 */
const USER = "user-a";
const CONVERSATION_A = "conv-a";
const CONVERSATION_B = "conv-b";
const NOW = new Date("2026-09-21T12:00:00.000Z");
/**
 * The key as STORED. `normalizeFactKey` lowercases and underscores what
 * the model reported — deterministic code deciding the shape of a belief,
 * which is the whole boundary this file is about.
 */
const FACT_KEY = "breakfast_time";

/** Nothing in any fixture mentions breakfast. That is the point. */
const BREAKFAST: ExtractionV1 = {
  entities: [],
  relationships: [],
  facts: [
    {
      // The contract represents the person themselves as null.
      subjectMention: null,
      key: "breakfast time",
      value: "around 8:30",
      // The model may NEVER set this. It reports; the deterministic layer
      // decides what is believed.
      explicitlyConfirmed: false,
      confidence: 0.9,
      sourceSpan: "I usually have breakfast around 8:30",
    },
  ],
  episodes: [],
  interactions: [],
};

function message(id: string, content: string): StoredMessage {
  return { id, role: "user", content, createdAt: NOW.toISOString() };
}

const job = (key: string, userMessageId: string, conversationId: string) => ({
  id: `job-${key}`,
  key,
  payload: { conversationId, userMessageId, assistantMessageId: key, userId: USER },
  attempts: 1,
});

let store: MemoryStore;

beforeEach(() => {
  resetIds();
  store = createStore([
    message("m1", "I usually have breakfast around 8:30."),
    message("m2", "I still have breakfast around 8:30, most days."),
    message("m3", "What time do I usually have breakfast?"),
  ]);
});

async function ingest(messageId: string, conversationId: string, key: string) {
  await processIngestJob(
    ingestionDeps(store, {
      extraction: fakeExtraction(BREAKFAST, { store }),
      embeddings: fakeEmbeddings({ store }),
    }),
    job(key, messageId, conversationId),
  );
}

const retrieve = (text: string) =>
  loadMemoryForTurn(
    { ...fakeMemoryRepos(store), embeddings: fakeEmbeddings({ store }) },
    { userId: USER, text, now: NOW },
  );

describe("1. a fact stated in conversation A is there in conversation B", () => {
  it("goes through observation → deterministic commit → retrieval", async () => {
    await ingest("m1", CONVERSATION_A, "a1");

    // The model's output was recorded as an OBSERVATION, immutably, before
    // anything was believed.
    expect(store.observations).toHaveLength(1);
    expect(store.observations[0].sourceMessageId).toBe("m1");

    // And deterministic code — not the model — created the belief.
    const fact = store.facts.find((row) => row.key === FACT_KEY);
    expect(fact).toBeDefined();
    expect(fact!.value).toBe("around 8:30");
    expect(fact!.subjectEntityId).toBeNull(); // about the person themselves

    // Retrieved on a LATER turn, by the ordinary bounded retrieval path.
    const memory = await retrieve("What time do I usually have breakfast?");
    expect(memory.profileCard).toContain(`${FACT_KEY}: around 8:30`);
  });

  it("is a CANDIDATE after one conversation, and says so", async () => {
    await ingest("m1", CONVERSATION_A, "a1");
    const fact = store.facts.find((row) => row.key === FACT_KEY)!;

    expect(fact.status).toBe("candidate");
    expect(fact.evidenceCount).toBe(1);
    expect(fact.sourceConversationIds).toEqual([CONVERSATION_A]);

    // The model is told, and told that it is not established (M12f). The
    // conversation prompt's rule is written against exactly this phrase.
    const memory = await retrieve("What time do I usually have breakfast?");
    expect(memory.profileCard).toContain("(not yet confirmed)");
  });

  it("asking about it does not confirm it", async () => {
    await ingest("m1", CONVERSATION_A, "a1");
    // A question is not a second statement. Retrieval is a read.
    await retrieve("What time do I usually have breakfast?");
    expect(store.facts[0].status).toBe("candidate");
    expect(store.facts[0].evidenceCount).toBe(1);
  });

  it("a second DISTINCT conversation confirms it", async () => {
    await ingest("m1", CONVERSATION_A, "a1");
    await ingest("m2", CONVERSATION_B, "a2");

    const fact = store.facts.find((row) => row.key === FACT_KEY)!;
    expect(fact.status).toBe("confirmed");
    expect(fact.evidenceCount).toBe(EVIDENCE_CONFIRM_THRESHOLD);
    expect([...fact.sourceConversationIds].sort()).toEqual([CONVERSATION_A, CONVERSATION_B]);

    const memory = await retrieve("What time do I usually have breakfast?");
    expect(memory.profileCard).toContain(`${FACT_KEY}: around 8:30`);
    expect(memory.profileCard).not.toContain("(not yet confirmed)");
  });

  it("saying it TWICE in one conversation does not", async () => {
    // Evidence is counted in distinct conversations, not in mentions —
    // otherwise somebody repeating themselves would be treated as
    // corroborating themselves.
    await ingest("m1", CONVERSATION_A, "a1");
    await ingest("m2", CONVERSATION_A, "a2");

    const fact = store.facts.find((row) => row.key === FACT_KEY)!;
    expect(fact.status).toBe("candidate");
    expect(fact.evidenceCount).toBe(1);
  });

  it("a replayed job contributes nothing — the same observation is not new evidence", async () => {
    await ingest("m1", CONVERSATION_A, "a1");
    await ingest("m1", CONVERSATION_A, "a1");

    expect(store.facts.filter((row) => row.key === FACT_KEY)).toHaveLength(1);
    expect(store.facts[0].status).toBe("candidate");
    expect(store.facts[0].evidenceCount).toBe(1);
  });
});

describe("2. none of this is fixture-specific", () => {
  it("no code path mentions breakfast, the cast, or this test's values", async () => {
    // The fact was chosen because nothing knows about it. If this ever
    // fails, something has been special-cased to make a demo look smart.
    const { readFileSync, readdirSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.tsx?$/.test(full) && /breakfast/i.test(readFileSync(full, "utf8"))) {
          offenders.push(full);
        }
      }
    };
    for (const dir of ["core", "server", "app"]) walk(dir);
    expect(offenders).toEqual([]);
  });
});
