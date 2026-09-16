import { beforeEach, describe, expect, it } from "vitest";
import type { ExtractionV1, InteractionClaim } from "@/core/memory/extraction-contract";
import { baselineConfig } from "@/core/baseline/config";
import { processIngestJob } from "@/server/services/ingestion";
import {
  createStore,
  fakeEmbeddings,
  fakeExtraction,
  ingestionDeps,
  resetIds,
  type MemoryStore,
} from "./memory-fakes";

const USER = "user-a";
const CONVERSATION = "conv-a";
const SENT_AT = "2026-09-16T10:00:00.000Z"; // a Wednesday

function interaction(over: Partial<InteractionClaim> = {}): InteractionClaim {
  return {
    participantMention: "John",
    eventType: "visit",
    polarity: "positive",
    temporal: { expression: "yesterday", absoluteDate: null },
    certainty: 0.9,
    sourceSpan: "John visited yesterday",
    ...over,
  };
}

function extraction(interactions: InteractionClaim[]): ExtractionV1 {
  return {
    entities: [
      {
        mention: "John",
        canonicalName: "John",
        type: "person",
        subtype: null,
        confidence: 0.95,
        sourceSpan: "John",
      },
    ],
    relationships: [],
    facts: [],
    episodes: [],
    interactions,
  };
}

function job(messageId = "m1") {
  return {
    id: `job-${messageId}`,
    key: `a-${messageId}`,
    payload: {
      conversationId: CONVERSATION,
      userMessageId: messageId,
      assistantMessageId: `a-${messageId}`,
      userId: USER,
    },
    attempts: 1,
  };
}

let store: MemoryStore;

async function run(interactions: InteractionClaim[], messageId = "m1") {
  await processIngestJob(
    ingestionDeps(store, {
      extraction: fakeExtraction(extraction(interactions), { store }),
      embeddings: fakeEmbeddings({ store }),
    }),
    job(messageId),
  );
}

beforeEach(() => {
  resetIds();
  store = createStore([
    { id: "m1", role: "user", content: "John visited yesterday.", createdAt: SENT_AT },
    { id: "m2", role: "user", content: "John called again.", createdAt: SENT_AT },
  ]);
});

describe("1-2. positive derivation", () => {
  it("derives a visit", async () => {
    await run([interaction()]);
    expect(store.interactionEvents).toHaveLength(1);
    expect(store.interactionEvents[0].eventType).toBe("visit");
    expect(store.interactionEvents[0].polarity).toBe("positive");
  });

  it("derives a call", async () => {
    await run([
      interaction({
        eventType: "call",
        temporal: { expression: "this morning", absoluteDate: null },
      }),
    ]);
    expect(store.interactionEvents[0].eventType).toBe("call");
  });
});

describe("3. absence derivation", () => {
  it("stores an absence with the window the person's own phrase supports", async () => {
    await run([
      interaction({
        polarity: "absence",
        temporal: { expression: "this week", absoluteDate: null },
        sourceSpan: "I haven't seen John this week",
      }),
    ]);

    const event = store.interactionEvents[0];
    expect(event.polarity).toBe("absence");
    expect(event.windowStart).not.toBeNull();
    expect(event.windowEnd).not.toBeNull();
    // "this week" runs from its start up to the moment they said it.
    expect(event.windowEnd).toBe(SENT_AT);
  });

  it("refuses to invent a window when the phrase does not support one", async () => {
    await run([
      interaction({
        polarity: "absence",
        temporal: { expression: "at some point", absoluteDate: null },
      }),
    ]);

    expect(store.interactionEvents).toHaveLength(0);
    const resolution = store.observations[0].resolution as { skipped: string[] };
    expect(resolution.skipped).toContain("interaction:John:absence_window_underivable");
  });
});

describe("4. occurred_at vs reported_at", () => {
  it("anchors the event to when it HAPPENED, not when it was mentioned", async () => {
    await run([interaction({ temporal: { expression: "yesterday", absoluteDate: null } })]);

    const event = store.interactionEvents[0];
    expect(event.reportedAt).toBe(SENT_AT); // 2026-09-16 10:00
    expect(event.occurredAt).toBe("2026-09-15T00:00:00.000Z"); // the day before
    expect(event.occurredAtPrecision).toBe("day");
  });

  it("resolves a weekday phrase to the most recent past occurrence", async () => {
    await run([interaction({ temporal: { expression: "last Sunday", absoluteDate: null } })]);
    expect(store.interactionEvents[0].occurredAt).toBe("2026-09-13T00:00:00.000Z");
  });
});

describe("5. certainty gate", () => {
  it("keeps a low-certainty claim out of the event spine", async () => {
    await run([interaction({ certainty: baselineConfig.minCertainty - 0.01 })]);

    expect(store.interactionEvents).toHaveLength(0);
    // The claim still exists in the observation - it is what the model said.
    const payload = store.observations[0].payload as ExtractionV1;
    expect(payload.interactions).toHaveLength(1);
    const resolution = store.observations[0].resolution as { skipped: string[] };
    expect(resolution.skipped).toContain("interaction:John:below_certainty");
  });

  it("admits a claim exactly at the gate", async () => {
    await run([interaction({ certainty: baselineConfig.minCertainty })]);
    expect(store.interactionEvents).toHaveLength(1);
  });

  it("never attaches an event to an unresolved participant", async () => {
    await run([interaction({ participantMention: "somebody" })]);
    expect(store.interactionEvents).toHaveLength(0);
    const resolution = store.observations[0].resolution as { skipped: string[] };
    expect(resolution.skipped).toContain("interaction:somebody:unresolved_participant");
  });
});

describe("6. replay idempotency", () => {
  it("processing the same observation twice yields ONE event", async () => {
    await run([interaction()]);
    expect(store.interactionEvents).toHaveLength(1);

    // Simulate a crash between committing memory and marking processed, so the
    // whole commit phase runs again against the same observation.
    store.observations[0].processedAt = null;
    await run([interaction()]);

    expect(store.interactionEvents).toHaveLength(1);
  });

  it("gives the same fingerprint on both passes", async () => {
    await run([interaction()]);
    const first = store.interactionEvents[0].ingestFingerprint;
    store.observations[0].processedAt = null;
    await run([interaction()]);
    expect(store.interactionEvents[0].ingestFingerprint).toBe(first);
  });
});

describe("7. same-day distinctness — the critical one", () => {
  it("two genuine calls on one day are TWO stored events", async () => {
    await run([
      interaction({
        eventType: "call",
        temporal: { expression: "this morning", absoluteDate: null },
        sourceSpan: "John called this morning",
      }),
      interaction({
        eventType: "call",
        temporal: { expression: "this evening", absoluteDate: null },
        sourceSpan: "John called again this evening",
      }),
    ]);

    expect(store.interactionEvents).toHaveLength(2);
    // Same calendar day...
    expect(store.interactionEvents[0].occurredAt).toBe(store.interactionEvents[1].occurredAt);
    // ...but distinct evidence, so distinct fingerprints.
    expect(store.interactionEvents[0].ingestFingerprint).not.toBe(
      store.interactionEvents[1].ingestFingerprint,
    );
  });

  it("stays distinct even when the evidence text is IDENTICAL", async () => {
    // The hard case: same day, same type, same wording. Everything the
    // fingerprint derives from the world is identical, so the claim's position
    // in the observation payload is the only thing left to tell them apart -
    // and the payload is immutable, so that position is stable on replay.
    await run([
      interaction({
        eventType: "call",
        temporal: { expression: "today", absoluteDate: null },
        sourceSpan: "John called",
      }),
      interaction({
        eventType: "call",
        temporal: { expression: "today", absoluteDate: null },
        sourceSpan: "John called",
      }),
    ]);

    expect(store.interactionEvents).toHaveLength(2);
    expect(store.interactionEvents[0].ingestFingerprint).not.toBe(
      store.interactionEvents[1].ingestFingerprint,
    );

    // ...and replaying still yields exactly two, not four.
    store.observations[0].processedAt = null;
    await run([
      interaction({ eventType: "call", temporal: { expression: "today", absoluteDate: null }, sourceSpan: "John called" }),
      interaction({ eventType: "call", temporal: { expression: "today", absoluteDate: null }, sourceSpan: "John called" }),
    ]);
    expect(store.interactionEvents).toHaveLength(2);
  });

  it("but the baseline counts that day once", async () => {
    await run([
      interaction({ eventType: "call", temporal: { expression: "this morning", absoluteDate: null }, sourceSpan: "a" }),
      interaction({ eventType: "call", temporal: { expression: "this evening", absoluteDate: null }, sourceSpan: "b" }),
    ]);

    const baseline = [...store.baselines.values()].find((b) => b.eventType === "call")!;
    expect(baseline.observationCount).toBe(2);
    expect(baseline.statisticalDayCount).toBe(1);
  });
});

describe("8. absence is excluded from positive cadence", () => {
  it("stores the absence but leaves the positive statistics untouched", async () => {
    // Four weekly visits, then an absence assertion.
    const messages = [0, 7, 14, 21].map((offset, index) => ({
      id: `h${index}`,
      role: "user" as const,
      content: "John visited",
      createdAt: new Date(Date.parse("2026-08-19T10:00:00.000Z") + offset * 86_400_000).toISOString(),
    }));
    store = createStore([...messages, { id: "abs", role: "user", content: "not seen him", createdAt: SENT_AT }]);

    for (const message of messages) {
      await run([interaction({ temporal: { expression: "today", absoluteDate: null } })], message.id);
    }

    const before = [...store.baselines.values()][0];
    expect(before.status).toBe("ACTIVE");

    await run(
      [
        interaction({
          polarity: "absence",
          temporal: { expression: "this week", absoluteDate: null },
        }),
      ],
      "abs",
    );

    const absences = store.interactionEvents.filter((e) => e.polarity === "absence");
    expect(absences).toHaveLength(1);

    const after = [...store.baselines.values()][0];
    expect(after.status).toBe("ACTIVE");
    expect(after.medianGapDays).toBe(before.medianGapDays);
    expect(after.inputsHash).toBe(before.inputsHash);
  });

  it("creates no signal or reconnect artefact of any kind", async () => {
    await run([
      interaction({ polarity: "absence", temporal: { expression: "this week", absoluteDate: null } }),
    ]);
    expect(store).not.toHaveProperty("signals");
    expect(store).not.toHaveProperty("reconnectOpportunities");
  });
});

describe("targeted recomputation", () => {
  it("recomputes only the series the turn touched", async () => {
    await run([interaction({ eventType: "visit" })]);
    const saves = store.calls.filter((c) => c.startsWith("baselines.save"));
    expect(saves).toHaveLength(1);
    expect(saves[0]).toContain(":visit");
  });

  it("does not recompute for an absence-only turn", async () => {
    await run([
      interaction({ polarity: "absence", temporal: { expression: "this week", absoluteDate: null } }),
    ]);
    expect(store.calls.filter((c) => c.startsWith("baselines.save"))).toHaveLength(0);
  });
});
