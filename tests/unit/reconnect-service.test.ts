import { beforeEach, describe, expect, it } from "vitest";
import { fixedClock, type Clock } from "@/server/adapters/clock";
import { DAY_MS } from "@/core/baseline/day";
import { detectionConfig } from "@/core/detection/config";
import { sha256Hex } from "@/core/share/text-hash";
import { checkOutboundText } from "@/core/safety/output-guard";
import { SharePayloadSchema } from "@/core/share/payload";
import { findDeniedTerm } from "@/core/safety/deny-list";
import { resolveAbsenceWindow } from "@/core/memory/temporal";
import { absenceDetectionKey } from "@/core/detection/absence";
import { cadenceDetectionKey } from "@/core/detection/cadence";
import { EMPTY_EXTRACTION } from "@/core/memory/extraction-contract";
import {
  draftOpportunity,
  runDetectionSweep,
  type DetectionSweepResult,
  type ReconnectDeps,
} from "@/server/services/reconnect";
import type { InteractionEventRecord } from "@/server/repositories/interaction-events";
import type { StoredBaseline } from "@/server/repositories/baselines";
import {
  createStore,
  fakeFamilyRender,
  fakeReconnectDeps,
  resetIds,
  type FakeFamilyRender,
  type ReconnectStore,
} from "./detection-fakes";

const NOW = new Date("2026-09-16T12:00:00.000Z");
const USER = "user-1";
const JOHN = "entity-john";
const SIMBA = "entity-simba";
const MARY = "entity-mary";
const SENTINEL = "PRIVATE_TRANSCRIPT_SENTINEL_7F3A";

const iso = (daysAgo: number) => new Date(NOW.getTime() - daysAgo * DAY_MS).toISOString();

function event(overrides: Partial<InteractionEventRecord> & { id: string }): InteractionEventRecord {
  return {
    entityId: JOHN,
    eventType: "visit",
    occurredAt: iso(0),
    occurredAtPrecision: "day",
    reportedAt: iso(0),
    certainty: 0.9,
    polarity: "positive",
    windowStart: null,
    windowEnd: null,
    sourceObservationId: null,
    ingestFingerprint: `fp-${overrides.id}`,
    ...overrides,
  };
}

/** Days ago [lastDaysAgo + 28, +23, +16, +9, last] -> gaps 5,7,7,9. */
function weekly(lastDaysAgo: number, entityId = JOHN): InteractionEventRecord[] {
  return [lastDaysAgo + 28, lastDaysAgo + 23, lastDaysAgo + 16, lastDaysAgo + 9, lastDaysAgo].map(
    (daysAgo) => event({ id: `${entityId}-${daysAgo}`, entityId, occurredAt: iso(daysAgo) }),
  );
}

function activeBaseline(entityId = JOHN, eventType: "visit" | "call" = "visit"): StoredBaseline {
  return {
    id: `bl-${entityId}-${eventType}`,
    entityId,
    eventType,
    status: "ACTIVE",
    medianGapDays: 7,
    madDays: 1,
    observationCount: 5,
    windowStart: null,
    windowEnd: null,
    reasons: [],
    methodVersion: "baseline.v1",
    inputsHash: `inputs-${entityId}`,
    // Fresh, so the lazy-staleness read serves the stored row.
    computedAt: NOW.toISOString(),
  };
}

function absenceEvent(id = "abs-1", entityId = JOHN): InteractionEventRecord {
  return event({
    id,
    entityId,
    polarity: "absence",
    occurredAt: iso(7),
    reportedAt: iso(0),
    windowStart: iso(7),
    windowEnd: iso(0),
  });
}

/**
 * An absence event whose window is what the deterministic resolver produces
 * for a real phrase, plus the immutable observation that phrase came from.
 * The two have to agree, because that agreement IS the matching rule.
 */
function absenceWithObservation(expression: string, entityId = JOHN) {
  const reportedAt = NOW;
  const window = resolveAbsenceWindow({
    claim: { expression, absoluteDate: null },
    referenceAt: reportedAt,
  })!;
  const observation = {
    id: "obs-1",
    sourceMessageId: "msg-1",
    kind: "extraction.v1",
    payload: {
      ...EMPTY_EXTRACTION,
      interactions: [
        {
          participantMention: "John",
          eventType: "visit" as const,
          polarity: "absence" as const,
          temporal: { expression, absoluteDate: null },
          certainty: 0.9,
          sourceSpan: `I haven't seen John ${expression}`,
        },
      ],
    },
    confidence: null,
    processedAt: null,
  };
  const row = event({
    id: "abs-obs",
    entityId,
    polarity: "absence",
    occurredAt: window.start.toISOString(),
    reportedAt: reportedAt.toISOString(),
    windowStart: window.start.toISOString(),
    windowEnd: window.end.toISOString(),
    sourceObservationId: observation.id,
  });
  return { row, observation, window };
}

function baseStore(overrides: Partial<ReconnectStore> = {}): ReconnectStore {
  return createStore({
    entities: [
      { id: JOHN, type: "person", subtype: null, displayName: "John", aliases: [], status: "active", lastMentionedAt: null },
      { id: SIMBA, type: "pet", subtype: "dog", displayName: "Simba", aliases: [], status: "active", lastMentionedAt: null },
      { id: MARY, type: "person", subtype: null, displayName: "Mary", aliases: [], status: "active", lastMentionedAt: null },
    ],
    relationships: [
      {
        id: "rel-1",
        fromEntityId: JOHN,
        toEntityId: SIMBA,
        kind: "pet",
        status: "confirmed",
        evidenceCount: 2,
        sourceObservationIds: [],
        sourceConversationIds: [],
      },
    ],
    profile: {
      id: USER,
      displayName: "George",
      familyDisplayName: "Dad",
      // Old enough that the cold-start rule is not in play unless a test says so.
      createdAt: iso(200),
    },
    ...overrides,
  });
}

function harness(options: {
  store?: ReconnectStore;
  clock?: Clock;
  render?: FakeFamilyRender;
} = {}) {
  const store = options.store ?? baseStore();
  const render = options.render ?? fakeFamilyRender();
  const deps: ReconnectDeps = fakeReconnectDeps({
    store,
    clock: options.clock ?? fixedClock(NOW),
    familyRender: render,
  });
  return { store, render, deps };
}

/**
 * Every disposition a candidate may end in. A candidate that reaches the
 * processing loop and produces none of these has been dropped silently, which
 * is what happened live: five candidates, three outcomes, two cadence
 * detections gone without a log line or a row.
 */
const ACCOUNTED_OUTCOMES = [
  "materialized",
  "reloaded",
  "resumed_materialized",
  "suppressed",
  "resumed_suppressed",
  "resumed_draft",
  "replayed_live",
  "replayed_suppressed",
  "rejected",
  "deferred",
  "entity_missing",
  "signal_not_detected",
  "signal_not_found",
];

/** candidates = discarded (by precedence) + one explicit outcome each. */
function expectFullyAccounted(result: DetectionSweepResult): void {
  expect(result.signals).toHaveLength(result.candidates - result.discarded);
  for (const entry of result.signals) {
    expect(ACCOUNTED_OUTCOMES, `unaccounted outcome ${entry.outcome}`).toContain(entry.outcome);
  }
  const keys = result.signals.map((entry) => entry.detectionKey);
  expect(new Set(keys).size, "one outcome per candidate").toBe(keys.length);
}

beforeEach(resetIds);

describe("1. cadence gap: evidence -> signal -> opportunity -> draft", () => {
  it("runs the whole path and stops at `drafted`", async () => {
    const store = baseStore({
      interactionEvents: weekly(13),
      baselines: new Map([[`${JOHN}:visit`, activeBaseline()]]),
    });
    const { deps, render } = harness({ store });

    const result = await runDetectionSweep(deps, { userId: USER, conversationId: "conv-1" });

    expect(result.signals).toHaveLength(1);
    expect(result.signals[0]).toMatchObject({
      signalType: "cadence_gap",
      entityId: JOHN,
      outcome: "materialized",
    });
    expect(store.signals[0].status).toBe("materialized");
    expect(store.signals[0].materializedAt).toBe(NOW.toISOString());
    expect(store.signals[0].suppressionReason).toBeNull();

    expect(store.opportunities).toHaveLength(1);
    const opportunity = store.opportunities[0];
    expect(opportunity.status).toBe("drafted");
    expect(opportunity.renderedText).toBeTruthy();
    expect(sha256Hex(opportunity.renderedText!)).toBe(opportunity.renderedTextHash);

    // Expiry starts at materialization and is the configured window.
    expect(Date.parse(opportunity.expiresAt) - NOW.getTime()).toBe(
      detectionConfig.opportunityOfferabilityHours * 3_600_000,
    );

    // It stops here. Nothing offers, approves or consumes in M4.
    expect(opportunity.offeredAt).toBeNull();
    expect(opportunity.resolvedAt).toBeNull();
    expect(render.calls).toHaveLength(1);
  });

  it("mentions the dog only because a CONFIRMED relationship says so", async () => {
    const store = baseStore({
      interactionEvents: weekly(13),
      baselines: new Map([[`${JOHN}:visit`, activeBaseline()]]),
    });
    const { deps } = harness({ store });
    await runDetectionSweep(deps, { userId: USER, conversationId: null });
    expect(store.opportunities[0].proposal).toMatchObject({ alsoMention: ["Simba"] });

    // Same setup, candidate edge: omitted rather than guessed.
    resetIds();
    const unconfirmed = baseStore({
      interactionEvents: weekly(13),
      baselines: new Map([[`${JOHN}:visit`, activeBaseline()]]),
    });
    unconfirmed.relationships[0] = { ...unconfirmed.relationships[0], status: "candidate" };
    const second = harness({ store: unconfirmed });
    await runDetectionSweep(second.deps, { userId: USER, conversationId: null });
    expect(second.store.opportunities[0].proposal).not.toHaveProperty("alsoMention");
  });

  it("does not fire at exactly the threshold", async () => {
    const store = baseStore({
      interactionEvents: weekly(11),
      baselines: new Map([[`${JOHN}:visit`, activeBaseline()]]),
    });
    const { deps, render } = harness({ store });
    const result = await runDetectionSweep(deps, { userId: USER, conversationId: null });
    expect(result.signals).toHaveLength(0);
    expect(store.opportunities).toHaveLength(0);
    expect(render.calls).toHaveLength(0);
  });
});

describe("2. explicit absence needs no baseline", () => {
  it("detects, materializes and drafts with NO_BASELINE", async () => {
    const store = baseStore({ interactionEvents: [absenceEvent()] });
    const { deps } = harness({ store });

    const result = await runDetectionSweep(deps, { userId: USER, conversationId: "conv-1" });

    expect(result.signals[0]).toMatchObject({
      signalType: "user_asserted_absence",
      outcome: "materialized",
    });
    expect(store.opportunities[0].status).toBe("drafted");
    // No rhythm is known, so no rhythm is claimed.
    expect(store.opportunities[0].proposal).not.toHaveProperty("pattern");
  });

  it("wins over a cadence gap for the same entity, and only one row is written", async () => {
    const store = baseStore({
      interactionEvents: [...weekly(13), absenceEvent()],
      baselines: new Map([[`${JOHN}:visit`, activeBaseline()]]),
    });
    const { deps } = harness({ store });

    const result = await runDetectionSweep(deps, { userId: USER, conversationId: null });

    expect(result.candidates).toBe(2);
    expect(result.discarded).toBe(1);
    expect(store.signals).toHaveLength(1);
    expect(store.signals[0].signalType).toBe("user_asserted_absence");
    expect(store.opportunities).toHaveLength(1);
  });
});

describe("3. suppression writes an audit row and creates nothing", () => {
  it("records the reason and leaves no opportunity", async () => {
    const store = baseStore({
      interactionEvents: weekly(13),
      baselines: new Map([[`${JOHN}:visit`, activeBaseline()]]),
      outstandingFamilyRequests: 1,
    });
    const { deps, render } = harness({ store });

    const result = await runDetectionSweep(deps, { userId: USER, conversationId: null });

    expect(result.signals[0]).toMatchObject({
      outcome: "suppressed",
      suppressionReason: "family_request_outstanding",
    });
    expect(store.signals[0].status).toBe("suppressed");
    expect(store.signals[0].suppressionReason).toBe("family_request_outstanding");
    expect(store.opportunities).toHaveLength(0);
    expect(render.calls).toHaveLength(0);
  });

  it("a new account suppresses cadence but never an explicit absence", async () => {
    const young = { createdAt: iso(3), id: USER, displayName: "G", familyDisplayName: "Dad" };

    // A young account whose whole history is 13 days deep: one recorded visit
    // and a baseline row that has not yet been invalidated. The gap is real
    // (13 > 11) and the detector fires — suppression is what stays its hand.
    const cadence = baseStore({
      interactionEvents: [event({ id: "only", occurredAt: iso(13) })],
      baselines: new Map([[`${JOHN}:visit`, activeBaseline()]]),
      profile: young,
      earliestConversationAt: iso(3),
    });
    const a = harness({ store: cadence });
    const first = await runDetectionSweep(a.deps, { userId: USER, conversationId: null });
    expect(first.signals[0].suppressionReason).toBe("account_too_new_for_cadence");

    resetIds();
    const absence = baseStore({
      interactionEvents: [absenceEvent()],
      profile: young,
      earliestConversationAt: iso(1),
    });
    const b = harness({ store: absence });
    const second = await runDetectionSweep(b.deps, { userId: USER, conversationId: null });
    expect(second.signals[0].outcome).toBe("materialized");
  });

  it("an account whose EVIDENCE is old is not treated as new", async () => {
    // A replayed history: profile row minutes old, evidence months deep. This
    // is the M6 fixture shape, and reading profile.created_at alone would
    // silence it.
    const store = baseStore({
      interactionEvents: weekly(13),
      baselines: new Map([[`${JOHN}:visit`, activeBaseline()]]),
      profile: { id: USER, displayName: "G", familyDisplayName: "Dad", createdAt: iso(0) },
    });
    const { deps } = harness({ store });
    const result = await runDetectionSweep(deps, { userId: USER, conversationId: null });
    expect(result.signals[0].outcome).toBe("materialized");
  });
});

describe("4. replay does not create repeated actionable behaviour", () => {
  it("a second sweep over the same evidence writes nothing and renders nothing", async () => {
    const store = baseStore({
      interactionEvents: weekly(13),
      baselines: new Map([[`${JOHN}:visit`, activeBaseline()]]),
    });
    const { deps, render } = harness({ store });

    await runDetectionSweep(deps, { userId: USER, conversationId: "conv-1" });
    const second = await runDetectionSweep(deps, { userId: USER, conversationId: "conv-2" });

    expect(second.replayed).toBe(1);
    // Reported, so the sweep is legible — but nothing was written.
    expect(second.signals).toEqual([
      expect.objectContaining({ signalId: null, outcome: "replayed_live" }),
    ]);
    expect(store.signals).toHaveLength(1);
    expect(store.opportunities).toHaveLength(1);
    // The already-drafted opportunity is revisited and NOT re-rendered.
    expect(render.calls).toHaveLength(1);
    expect(second.drafts[0]?.rendererCalled ?? false).toBe(false);
  });

  it("new evidence is new news, but the open opportunity still stops a second offer", async () => {
    const store = baseStore({
      interactionEvents: weekly(13),
      baselines: new Map([[`${JOHN}:visit`, activeBaseline()]]),
    });
    const { deps } = harness({ store });
    await runDetectionSweep(deps, { userId: USER, conversationId: null });

    // A newer absence assertion: different evidence, so a genuine new signal.
    store.interactionEvents.push(absenceEvent("abs-new"));
    const second = await runDetectionSweep(deps, { userId: USER, conversationId: null });

    expect(second.signals).toHaveLength(1);
    expect(second.signals[0].suppressionReason).toBe("open_opportunity_exists");
    expect(store.opportunities).toHaveLength(1);
  });
});

describe("5. concurrency", () => {
  it("two racing materializations of one signal yield exactly one opportunity", async () => {
    const store = baseStore();
    const { deps } = harness({ store });
    const signal = await deps.signals.insert({
      userId: USER, entityId: JOHN, baselineId: null, signalType: "cadence_gap",
      explanation: { detectionKey: "dk" }, detectedAt: NOW.toISOString(),
    });

    const args = {
      signalId: signal.id, userId: USER, entityId: JOHN,
      proposal: { entityId: JOHN }, expiresAt: iso(-1), now: NOW.toISOString(),
    };
    const [a, b] = await Promise.all([
      deps.opportunities.materialize(args),
      deps.opportunities.materialize(args),
    ]);

    expect(store.opportunities).toHaveLength(1);
    expect(new Set([a.outcome, b.outcome])).toEqual(new Set(["materialized", "reloaded"]));
    expect(a.opportunityId).toBe(b.opportunityId);
  });

  it("two different signals for one entity cannot both open", async () => {
    const store = baseStore();
    const { deps } = harness({ store });
    const first = await deps.signals.insert({
      userId: USER, entityId: JOHN, baselineId: null, signalType: "cadence_gap",
      explanation: { detectionKey: "a" }, detectedAt: NOW.toISOString(),
    });
    const second = await deps.signals.insert({
      userId: USER, entityId: JOHN, baselineId: null, signalType: "user_asserted_absence",
      explanation: { detectionKey: "b" }, detectedAt: NOW.toISOString(),
    });

    const base = { userId: USER, entityId: JOHN, proposal: {}, expiresAt: iso(-1), now: NOW.toISOString() };
    const outcomes = await Promise.all([
      deps.opportunities.materialize({ ...base, signalId: first.id }),
      deps.opportunities.materialize({ ...base, signalId: second.id }),
    ]);

    expect(store.opportunities).toHaveLength(1);
    expect(outcomes.filter((o) => o.outcome === "materialized")).toHaveLength(1);
    expect(outcomes.filter((o) => o.outcome === "blocked_open_opportunity")).toHaveLength(1);
  });

  it("a blocked materialization is recorded as a suppressed signal, not a crash", async () => {
    const store = baseStore({
      interactionEvents: [absenceEvent()],
      opportunities: [
        {
          id: "opp-existing", userId: USER, signalId: "sig-old", entityId: JOHN,
          proposal: {}, sharePayload: null, renderedText: null, renderedTextHash: null,
          status: "approved", offeredAt: iso(1), resolvedAt: null,
          expiresAt: iso(-1), createdAt: iso(1),
        },
      ],
    });
    const { deps } = harness({ store });
    const result = await runDetectionSweep(deps, { userId: USER, conversationId: null });
    // `approved` counts as open, so suppression refuses before the RPC.
    expect(result.signals[0].suppressionReason).toBe("open_opportunity_exists");
  });

  it("two racing drafts leave exactly one stored draft, and the loser reloads it", async () => {
    const store = baseStore({
      interactionEvents: weekly(13),
      baselines: new Map([[`${JOHN}:visit`, activeBaseline()]]),
    });
    let call = 0;
    const render = fakeFamilyRender({
      text: () => (++call === 1 ? "Dad was wondering — are you able to visit soon?" : "Dad was wondering — could you come round soon?"),
    });
    const deps = fakeReconnectDeps({ store, clock: fixedClock(NOW), familyRender: render });

    // Materialize without drafting, then race two drafters at it.
    const signal = await deps.signals.insert({
      userId: USER, entityId: JOHN, baselineId: null, signalType: "cadence_gap",
      explanation: { detectionKey: "dk" }, detectedAt: NOW.toISOString(),
    });
    const materialized = await deps.opportunities.materialize({
      signalId: signal.id, userId: USER, entityId: JOHN,
      proposal: {
        entityId: JOHN, entityName: "John", eventType: "visit",
        observation: { kind: "no_mention_since", days: 13 }, question: "ask_if_visiting",
      },
      expiresAt: new Date(NOW.getTime() + DAY_MS).toISOString(), now: NOW.toISOString(),
    });

    const [a, b] = await Promise.all([
      draftOpportunity(deps, { userId: USER, opportunityId: materialized.opportunityId! }),
      draftOpportunity(deps, { userId: USER, opportunityId: materialized.opportunityId! }),
    ]);

    const outcomes = [a.outcome, b.outcome].sort();
    expect(outcomes).toEqual(["drafted", "lost_race"]);
    const stored = store.opportunities[0];
    expect(stored.status).toBe("drafted");
    expect(sha256Hex(stored.renderedText!)).toBe(stored.renderedTextHash);
    // Both attempts report the WINNER's hash; nobody is told their bytes won
    // when they did not.
    const winner = a.outcome === "drafted" ? a : b;
    const loser = a.outcome === "drafted" ? b : a;
    expect(winner.renderedTextHash).toBe(stored.renderedTextHash);
    expect(loser.renderedTextHash).toBe(stored.renderedTextHash);
  });
});

describe("5b. an integrity rejection from the RPC is surfaced, not laundered", () => {
  it("records `rejected`, leaves the signal detected, and writes no opportunity", async () => {
    const store = baseStore({
      interactionEvents: weekly(13),
      baselines: new Map([[`${JOHN}:visit`, activeBaseline()]]),
    });
    const { deps, render } = harness({ store });
    // The RPC refuses because the arguments did not describe a consistent,
    // owned row. That is a bug in this service, not a product state, so it
    // must NOT become a suppression reason that reads like a policy decision.
    deps.opportunities.materialize = async () => ({
      outcome: "invalid_expiry",
      opportunityId: null,
    });

    const result = await runDetectionSweep(deps, { userId: USER, conversationId: null });

    expect(result.signals[0].outcome).toBe("rejected");
    expect(result.signals[0].suppressionReason).toBeUndefined();
    expect(store.signals[0].status).toBe("detected");
    expect(store.signals[0].suppressionReason).toBeNull();
    expect(store.opportunities).toHaveLength(0);
    expect(render.calls).toHaveLength(0);
  });

  it("the fake enforces the same identity order as the SQL", async () => {
    const store = baseStore();
    const { deps } = harness({ store });
    const signal = await deps.signals.insert({
      userId: USER, entityId: JOHN, baselineId: null, signalType: "cadence_gap",
      explanation: { detectionKey: "dk" }, detectedAt: NOW.toISOString(),
    });
    const base = { signalId: signal.id, proposal: {}, expiresAt: iso(-1), now: NOW.toISOString() };

    expect(await deps.opportunities.materialize({ ...base, userId: "someone-else", entityId: JOHN }))
      .toEqual({ outcome: "signal_not_found", opportunityId: null });
    expect(await deps.opportunities.materialize({ ...base, userId: USER, entityId: MARY }))
      .toEqual({ outcome: "signal_entity_mismatch", opportunityId: null });
    expect(
      await deps.opportunities.materialize({
        ...base, userId: USER, entityId: JOHN, expiresAt: NOW.toISOString(),
      }),
    ).toEqual({ outcome: "invalid_expiry", opportunityId: null });
    expect(store.opportunities).toHaveLength(0);
  });
});

describe("5c. a cadence signal re-arms after its opportunity expires", () => {
  /**
   * The identity of a cadence claim says WHAT EVIDENCE caused it. It does not
   * say the evidence has been dealt with for good. An expired opportunity is
   * terminal and the frozen way back is a fresh signal (docs/04 s11.5) — so
   * the same key must be able to fire again once no cycle is running.
   */
  async function firstCycle() {
    const store = baseStore({
      interactionEvents: weekly(13),
      baselines: new Map([[`${JOHN}:visit`, activeBaseline()]]),
    });
    const render = fakeFamilyRender();
    const deps = fakeReconnectDeps({ store, clock: fixedClock(NOW), familyRender: render });
    await runDetectionSweep(deps, { userId: USER, conversationId: "conv-1" });
    return { store, render };
  }

  function expireIt(store: ReconnectStore) {
    store.opportunities[0].status = "expired";
    store.opportunities[0].resolvedAt = NOW.toISOString();
  }

  // 23 hours: a new UTC day (so elapsed time really has moved) but inside the
  // 24h staleness window, so the SAME stored baseline is served and the
  // detection key is genuinely unchanged rather than accidentally different.
  const LATER = new Date(NOW.getTime() + 23 * 3_600_000);

  it("creates a NEW signal and a NEW opportunity, and leaves the expired one alone", async () => {
    const { store, render } = await firstCycle();
    const firstSignalId = store.signals[0].id;
    const firstOpportunityId = store.opportunities[0].id;
    const firstKey = (store.signals[0].explanation as { detectionKey: string }).detectionKey;
    expireIt(store);

    const deps = fakeReconnectDeps({ store, clock: fixedClock(LATER), familyRender: render });
    const result = await runDetectionSweep(deps, { userId: USER, conversationId: "conv-2" });

    expect(result.signals).toHaveLength(1);
    expect(result.signals[0].outcome).toBe("materialized");
    expect(store.signals).toHaveLength(2);
    expect(store.opportunities).toHaveLength(2);

    const second = store.signals[1];
    expect(second.id).not.toBe(firstSignalId);
    // Same evidence-level identity — no timestamp, no randomness.
    expect((second.explanation as { detectionKey: string }).detectionKey).toBe(firstKey);

    const reopened = store.opportunities[1];
    expect(reopened.id).not.toBe(firstOpportunityId);
    expect(reopened.signalId).toBe(second.id);
    expect(reopened.status).toBe("drafted");

    // The expired one was not reopened, reused or mutated.
    const expired = store.opportunities[0];
    expect(expired.id).toBe(firstOpportunityId);
    expect(expired.status).toBe("expired");
    expect(expired.resolvedAt).toBe(NOW.toISOString());
  });

  it("re-computes the explanation instead of copying the old one", async () => {
    const { store, render } = await firstCycle();
    const before = store.signals[0].explanation as {
      daysSinceLast: number; thresholdDays: number; medianGapDays: number;
    };
    expect(before).toMatchObject({ daysSinceLast: 13, thresholdDays: 11, medianGapDays: 7 });
    expireIt(store);

    // The world moved: the baseline now says 8 days, and a day has passed.
    // The inputs hash is untouched, so the identity is still the same evidence.
    const baseline = store.baselines.get(`${JOHN}:visit`)!;
    store.baselines.set(`${JOHN}:visit`, { ...baseline, medianGapDays: 8 });

    const deps = fakeReconnectDeps({ store, clock: fixedClock(LATER), familyRender: render });
    await runDetectionSweep(deps, { userId: USER, conversationId: "conv-2" });

    const after = store.signals[1].explanation as {
      daysSinceLast: number; thresholdDays: number; medianGapDays: number; detectionKey: string;
    };
    expect(after.daysSinceLast).toBe(14); // recomputed from the current clock
    expect(after.medianGapDays).toBe(8); // recomputed from the current baseline
    expect(after.thresholdDays).toBe(12); // max(8+2, 12, 12, 7)
    expect(after).not.toEqual(before);
  });

  it("does not re-arm while the cycle is still live", async () => {
    const { store, render } = await firstCycle();
    // Opportunity is `drafted` — open. An ordinary retry must write nothing.
    const deps = fakeReconnectDeps({ store, clock: fixedClock(LATER), familyRender: render });
    const result = await runDetectionSweep(deps, { userId: USER, conversationId: "conv-2" });

    expect(result.replayed).toBe(1);
    expect(result.signals[0]).toMatchObject({ signalId: null, outcome: "replayed_live" });
    expect(store.signals).toHaveLength(1);
    expect(store.opportunities).toHaveLength(1);
  });

  it("does not re-arm when the cadence condition no longer holds", async () => {
    const { store, render } = await firstCycle();
    expireIt(store);
    // John visited yesterday. The gap is closed; there is nothing to say.
    store.interactionEvents.push(event({ id: "fresh-visit", occurredAt: iso(1) }));

    const deps = fakeReconnectDeps({ store, clock: fixedClock(LATER), familyRender: render });
    const result = await runDetectionSweep(deps, { userId: USER, conversationId: "conv-2" });

    expect(result.candidates).toBe(0);
    expect(result.signals).toHaveLength(0);
    expect(store.signals).toHaveLength(1);
    expect(store.opportunities).toHaveLength(1);
  });

  it("re-arms into suppression without writing a duplicate audit row", async () => {
    const { store, render } = await firstCycle();
    expireIt(store);
    // Something else is now in the way. The earlier cycle's rows already say
    // what happened, and a second identical row answers no new question.
    store.outstandingFamilyRequests = 1;

    const deps = fakeReconnectDeps({ store, clock: fixedClock(LATER), familyRender: render });
    const result = await runDetectionSweep(deps, { userId: USER, conversationId: "conv-2" });

    expect(result.signals[0]).toMatchObject({
      signalId: null,
      outcome: "replayed_suppressed",
      suppressionReason: "family_request_outstanding",
    });
    expect(store.signals).toHaveLength(1);
    expect(store.opportunities).toHaveLength(1);
  });

  it("fails CLOSED when the prior cycle's opportunity is out of the read window", async () => {
    const { store, render } = await firstCycle();
    // Terminal, but so old that the bounded history read cannot see it. A
    // missed nudge is the cheaper mistake than a duplicate one.
    store.opportunities[0].status = "consumed";
    store.opportunities[0].createdAt = iso(200);
    store.opportunities[0].resolvedAt = iso(200);

    const deps = fakeReconnectDeps({ store, clock: fixedClock(LATER), familyRender: render });
    const result = await runDetectionSweep(deps, { userId: USER, conversationId: "conv-2" });

    expect(result.signals[0].outcome).toBe("replayed_live");
    expect(store.signals).toHaveLength(1);
  });

  it("re-arms when that same terminal opportunity IS visible", async () => {
    const { store, render } = await firstCycle();
    store.opportunities[0].status = "consumed";
    store.opportunities[0].resolvedAt = NOW.toISOString();

    const deps = fakeReconnectDeps({ store, clock: fixedClock(LATER), familyRender: render });
    const result = await runDetectionSweep(deps, { userId: USER, conversationId: "conv-2" });

    expect(result.signals[0].outcome).toBe("materialized");
    expect(store.signals).toHaveLength(2);
  });

  it("concurrent re-arm sweeps still leave at most one open opportunity", async () => {
    const { store, render } = await firstCycle();
    expireIt(store);

    const a = fakeReconnectDeps({ store, clock: fixedClock(LATER), familyRender: render });
    const b = fakeReconnectDeps({ store, clock: fixedClock(LATER), familyRender: render });
    await Promise.all([
      runDetectionSweep(a, { userId: USER, conversationId: "conv-a" }),
      runDetectionSweep(b, { userId: USER, conversationId: "conv-b" }),
    ]);

    const open = store.opportunities.filter((o) =>
      ["proposed", "drafted", "offered", "approved"].includes(o.status),
    );
    expect(open).toHaveLength(1);
    // The loser was recorded as suppressed, not crashed and not duplicated.
    const suppressed = store.signals.filter((s) => s.status === "suppressed");
    expect(suppressed.every((s) => s.suppressionReason === "open_opportunity_exists")).toBe(true);
  });
});

describe("5e. unfinished work is resumed, never abandoned and never duplicated", () => {
  /**
   * The signal row is committed BEFORE the materialization RPC, so a reclaimed
   * serverless runtime leaves a `detected` signal with no opportunity. That is
   * unfinished durable work, not a completed cycle — exactly the state that
   * was reproduced in live testing before the RPC existed. The next ordinary
   * request has to carry it the rest of the way.
   */
  const LATER = new Date(NOW.getTime() + 23 * 3_600_000);

  function cadenceStore() {
    return baseStore({
      interactionEvents: weekly(13),
      baselines: new Map([[`${JOHN}:visit`, activeBaseline()]]),
    });
  }

  /** A sweep killed the instant after the signal row was committed. */
  async function crashedAfterSignal(store: ReconnectStore) {
    const render = fakeFamilyRender();
    const deps = fakeReconnectDeps({ store, clock: fixedClock(NOW), familyRender: render });
    // The RPC never returns: the process died between the insert and the
    // transaction. Nothing after it ran.
    deps.opportunities.materialize = async () => {
      throw new Error("runtime reclaimed");
    };
    await expect(
      runDetectionSweep(deps, { userId: USER, conversationId: "conv-1" }),
    ).rejects.toThrow("runtime reclaimed");
    expect(store.signals).toHaveLength(1);
    expect(store.signals[0].status).toBe("detected");
    expect(store.opportunities).toHaveLength(0);
    return store.signals[0].id;
  }

  it("resumes a `detected` signal through to an opportunity and a draft", async () => {
    const store = cadenceStore();
    const abandoned = await crashedAfterSignal(store);

    const render = fakeFamilyRender();
    const deps = fakeReconnectDeps({ store, clock: fixedClock(LATER), familyRender: render });
    const result = await runDetectionSweep(deps, { userId: USER, conversationId: "conv-2" });

    expect(result.signals[0]).toMatchObject({
      signalId: abandoned,
      outcome: "resumed_materialized",
    });
    // The SAME signal, carried forward. No second row to retry work.
    expect(store.signals).toHaveLength(1);
    expect(store.signals[0].id).toBe(abandoned);
    expect(store.signals[0].status).toBe("materialized");

    expect(store.opportunities).toHaveLength(1);
    expect(store.opportunities[0].signalId).toBe(abandoned);
    expect(store.opportunities[0].status).toBe("drafted");
    expect(sha256Hex(store.opportunities[0].renderedText!)).toBe(
      store.opportunities[0].renderedTextHash,
    );
    expect(render.calls).toHaveLength(1);
  });

  it("completes the cycle with the STORED explanation, not a recomputed one", async () => {
    const store = cadenceStore();
    await crashedAfterSignal(store);
    const stored = store.signals[0].explanation as { daysSinceLast: number };
    expect(stored.daysSinceLast).toBe(13);

    const deps = fakeReconnectDeps({ store, clock: fixedClock(LATER), familyRender: fakeFamilyRender() });
    await runDetectionSweep(deps, { userId: USER, conversationId: "conv-2" });

    // A day has passed, but the opportunity belongs to the signal it hangs
    // off, so the two agree. Drift is handled by expiry, not by rewriting an
    // audit row.
    const proposal = store.opportunities[0].proposal as {
      observation: { days: number };
    };
    expect(proposal.observation.days).toBe(13);
  });

  it("running again after recovery duplicates nothing and re-renders nothing", async () => {
    const store = cadenceStore();
    const abandoned = await crashedAfterSignal(store);
    const render = fakeFamilyRender();
    const deps = fakeReconnectDeps({ store, clock: fixedClock(LATER), familyRender: render });

    await runDetectionSweep(deps, { userId: USER, conversationId: "conv-2" });
    const again = await runDetectionSweep(deps, { userId: USER, conversationId: "conv-3" });

    expect(again.signals[0]).toMatchObject({ signalId: null, outcome: "replayed_live" });
    expect(store.signals).toHaveLength(1);
    expect(store.signals[0].id).toBe(abandoned);
    expect(store.opportunities).toHaveLength(1);
    expect(render.calls).toHaveLength(1);
  });

  it("a suppression that arose while work was abandoned lands on the SAME signal", async () => {
    const store = cadenceStore();
    const abandoned = await crashedAfterSignal(store);
    // Something else opened for this entity in the meantime.
    store.outstandingFamilyRequests = 1;

    const render = fakeFamilyRender();
    const deps = fakeReconnectDeps({ store, clock: fixedClock(LATER), familyRender: render });
    const result = await runDetectionSweep(deps, { userId: USER, conversationId: "conv-2" });

    expect(result.signals[0]).toMatchObject({
      signalId: abandoned,
      outcome: "resumed_suppressed",
      suppressionReason: "family_request_outstanding",
    });
    expect(store.signals).toHaveLength(1);
    expect(store.signals[0].status).toBe("suppressed");
    expect(store.signals[0].suppressionReason).toBe("family_request_outstanding");
    expect(store.opportunities).toHaveLength(0);
    expect(render.calls).toHaveLength(0);
  });

  it("an open opportunity found only inside the transaction suppresses the same signal", async () => {
    const store = cadenceStore();
    const abandoned = await crashedAfterSignal(store);
    // Invisible to the snapshot (a different entity's key would not collide),
    // so only the RPC's in-transaction recheck can catch it.
    const render = fakeFamilyRender();
    const deps = fakeReconnectDeps({ store, clock: fixedClock(LATER), familyRender: render });
    deps.opportunities.materialize = async () => ({
      outcome: "blocked_open_opportunity",
      opportunityId: null,
    });

    const result = await runDetectionSweep(deps, { userId: USER, conversationId: "conv-2" });

    expect(result.signals[0]).toMatchObject({
      signalId: abandoned,
      outcome: "resumed_suppressed",
      suppressionReason: "open_opportunity_exists",
    });
    expect(store.signals[0].status).toBe("suppressed");
    expect(store.opportunities).toHaveLength(0);
  });

  it("an integrity failure leaves the signal `detected` for retry", async () => {
    const store = cadenceStore();
    const abandoned = await crashedAfterSignal(store);
    const deps = fakeReconnectDeps({ store, clock: fixedClock(LATER), familyRender: fakeFamilyRender() });
    deps.opportunities.materialize = async () => ({
      outcome: "invalid_expiry",
      opportunityId: null,
    });

    const result = await runDetectionSweep(deps, { userId: USER, conversationId: "conv-2" });

    expect(result.signals[0]).toMatchObject({ signalId: abandoned, outcome: "rejected" });
    expect(result.signals[0].suppressionReason).toBeUndefined();
    // Still recoverable. Not disguised as a product decision.
    expect(store.signals[0].status).toBe("detected");
    expect(store.signals[0].suppressionReason).toBeNull();
  });

  it("refuses to resume a signal whose stored explanation no longer parses", async () => {
    const store = cadenceStore();
    const abandoned = await crashedAfterSignal(store);
    const key = (store.signals[0].explanation as { detectionKey: string }).detectionKey;
    // Same identity, unreadable body: recognised as the same cycle, but it
    // cannot be completed.
    store.signals[0].explanation = { detectionKey: key, detector: "cadence_gap", nonsense: true };

    const deps = fakeReconnectDeps({ store, clock: fixedClock(LATER), familyRender: fakeFamilyRender() });
    const result = await runDetectionSweep(deps, { userId: USER, conversationId: "conv-2" });

    // The key still matches, so it is recognised as the same cycle and not
    // duplicated — but it cannot be completed, and it is not silently dropped.
    expect(result.signals[0]).toMatchObject({ signalId: abandoned, outcome: "rejected" });
    expect(store.signals).toHaveLength(1);
    expect(store.opportunities).toHaveLength(0);
  });

  it("resumes drafting for a `proposed` opportunity whose draft step never ran", async () => {
    const store = cadenceStore();
    const render = fakeFamilyRender();
    const first = fakeReconnectDeps({ store, clock: fixedClock(NOW), familyRender: render });
    // Materialization succeeded; the process died before the draft landed.
    const crash = new Error("runtime reclaimed");
    const realDraftRender = first.familyRender.render.bind(first.familyRender);
    first.familyRender = { render: async () => { void realDraftRender; throw crash; } };
    await runDetectionSweep(first, { userId: USER, conversationId: "conv-1" });
    // The render threw, so the deterministic fallback drafted instead. Undo
    // that to model the harder case: nothing persisted at all.
    store.opportunities[0].status = "proposed";
    store.opportunities[0].renderedText = null;
    store.opportunities[0].renderedTextHash = null;
    store.opportunities[0].sharePayload = null;
    const signalId = store.signals[0].id;

    const second = fakeReconnectDeps({ store, clock: fixedClock(LATER), familyRender: render });
    const result = await runDetectionSweep(second, { userId: USER, conversationId: "conv-2" });

    expect(result.signals[0]).toMatchObject({
      signalId,
      outcome: "resumed_draft",
      opportunityId: store.opportunities[0].id,
    });
    expect(store.signals).toHaveLength(1);
    expect(store.opportunities).toHaveLength(1);
    expect(store.opportunities[0].status).toBe("drafted");
    expect(sha256Hex(store.opportunities[0].renderedText!)).toBe(
      store.opportunities[0].renderedTextHash,
    );
  });

  it("does not draft a `proposed` opportunity that expired before recovery", async () => {
    const store = cadenceStore();
    const render = fakeFamilyRender();
    const first = fakeReconnectDeps({ store, clock: fixedClock(NOW), familyRender: render });
    await runDetectionSweep(first, { userId: USER, conversationId: "conv-1" });
    const expiresAt = store.opportunities[0].expiresAt;
    store.opportunities[0].status = "proposed";
    store.opportunities[0].renderedText = null;
    store.opportunities[0].renderedTextHash = null;
    store.opportunities[0].sharePayload = null;

    // Two days later: the offerability window closed while the work was lost.
    const muchLater = new Date(NOW.getTime() + 48 * 3_600_000);
    const second = fakeReconnectDeps({ store, clock: fixedClock(muchLater), familyRender: render });
    const result = await runDetectionSweep(second, { userId: USER, conversationId: "conv-2" });

    expect(result.drafts[0].outcome).toBe("expired");
    expect(result.drafts[0].rendererCalled).toBe(false);
    expect(store.opportunities[0].status).toBe("expired");
    expect(store.opportunities[0].renderedText).toBeNull();
    // Never extended.
    expect(store.opportunities[0].expiresAt).toBe(expiresAt);
    expect(render.calls).toHaveLength(1); // only the first cycle's
  });

  it("a renderer outage leaves the opportunity recoverable rather than wrong", async () => {
    const store = cadenceStore();
    const render = fakeFamilyRender({ failWith: new Error("upstream down") });
    const deps = fakeReconnectDeps({ store, clock: fixedClock(NOW), familyRender: render });

    await runDetectionSweep(deps, { userId: USER, conversationId: "conv-1" });

    // The deterministic fallback means there IS a safe draft, so the loop is
    // never stuck waiting for a model to come back.
    expect(store.opportunities[0].status).toBe("drafted");
    expect(store.opportunities[0].renderedText).toBe(
      "Dad was wondering — are you and Simba able to visit soon?",
    );
  });

  it("at most one unfinished cycle per detection key, and it is reused", async () => {
    const store = cadenceStore();
    await crashedAfterSignal(store);
    const key = (store.signals[0].explanation as { detectionKey: string }).detectionKey;

    // Three more ordinary requests arrive before anything completes.
    for (const conversationId of ["c2", "c3", "c4"]) {
      const deps = fakeReconnectDeps({ store, clock: fixedClock(NOW), familyRender: fakeFamilyRender() });
      deps.opportunities.materialize = async () => ({
        outcome: "invalid_expiry",
        opportunityId: null,
      });
      await runDetectionSweep(deps, { userId: USER, conversationId });
    }

    const forKey = store.signals.filter(
      (signal) => (signal.explanation as { detectionKey?: string }).detectionKey === key,
    );
    const unfinished = forKey.filter((signal) => signal.status === "detected");
    expect(forKey).toHaveLength(1);
    expect(unfinished).toHaveLength(1);
    expect(store.opportunities).toHaveLength(0);
  });
});

describe("5f. no candidate leaves the sweep unaccounted for", () => {
  /**
   * The live failure: POST /api/dev/detect reported 5 candidates, 0 discarded,
   * 0 replayed and 3 outcomes. The per-sweep work budget is 3, and the loop
   * `break`-ed on it without recording anything — so two cadence detections
   * vanished. Worse, `selected` is ordered by detector precedence, which puts
   * every absence candidate ahead of every cadence one, so cadence was the
   * systematic loser.
   */
  const KATE = "entity-kate";
  const LATER = new Date(NOW.getTime() + 23 * 3_600_000);

  /** A store with an absence and two cadence series across four entities. */
  function mixedStore() {
    const store = baseStore({
      interactionEvents: [
        absenceEvent("abs-john", JOHN),
        ...weekly(13, MARY),
        ...weekly(13, KATE),
      ],
      baselines: new Map([
        [`${MARY}:visit`, activeBaseline(MARY)],
        [`${KATE}:visit`, activeBaseline(KATE)],
      ]),
    });
    store.entities.push({
      id: KATE, type: "person", subtype: null, displayName: "Kate",
      aliases: [], status: "active", lastMentionedAt: null,
    });
    return store;
  }

  /** A signal left `detected` by a process that died before materializing. */
  function pendingSignal(store: ReconnectStore, entityId: string, detectionKey: string, type: "cadence_gap" | "user_asserted_absence") {
    const id = `pending-${entityId}`;
    store.signals.push({
      id,
      userId: USER,
      entityId,
      baselineId: null,
      signalType: type,
      status: "detected",
      explanation:
        type === "cadence_gap"
          ? {
              detector: "cadence_gap", methodVersion: "detection.v1", detectionKey,
              entityId, eventType: "visit", medianGapDays: 7, madDays: 1,
              thresholdDays: 11, daysSinceLast: 13, lastEventId: `${entityId}-13`,
              lastEventDate: "2026-09-03", contributingEventCount: 5,
              baselineInputsHash: `inputs-${entityId}`, conversationId: null,
            }
          : {
              detector: "user_asserted_absence", methodVersion: "detection.v1", detectionKey,
              entityId, eventType: "visit", sourceEventId: "abs-john",
              absenceWindowStart: iso(7), absenceWindowEnd: iso(0),
              statedPhrase: null, reportedAt: iso(0), certainty: 0.9,
              baseline: null, conversationId: null,
            },
      detectedAt: iso(0),
      suppressionReason: null,
      materializedAt: null,
    });
    return id;
  }

  it("accounts for every candidate even when the work budget is spent", async () => {
    const store = mixedStore();
    const { deps } = harness({ store });

    const result = await runDetectionSweep(deps, { userId: USER, conversationId: null });

    expect(result.candidates).toBe(3);
    expectFullyAccounted(result);
    // Budget is 3, so all three fit here — the point is that the count adds up.
    expect(result.signals.map((entry) => entry.outcome).sort()).toEqual([
      "materialized", "materialized", "materialized",
    ]);
  });

  it("reports the overflow as `deferred` rather than dropping it", async () => {
    const store = mixedStore();
    // A fourth candidate, one more than the budget of three.
    const ELI = "entity-eli";
    store.entities.push({
      id: ELI, type: "person", subtype: null, displayName: "Eli",
      aliases: [], status: "active", lastMentionedAt: null,
    });
    store.interactionEvents.push(...weekly(13, ELI));
    store.baselines.set(`${ELI}:visit`, activeBaseline(ELI));

    const { deps } = harness({ store });
    const result = await runDetectionSweep(deps, { userId: USER, conversationId: null });

    expect(result.candidates).toBe(4);
    expectFullyAccounted(result);
    const outcomes = result.signals.map((entry) => entry.outcome);
    expect(outcomes.filter((o) => o === "materialized")).toHaveLength(3);
    expect(outcomes.filter((o) => o === "deferred")).toHaveLength(1);
    // Nothing durable was written for the deferred one...
    expect(store.signals).toHaveLength(3);

    // ...and the next ordinary sweep picks it up. Deferred is not lost.
    const second = await runDetectionSweep(
      fakeReconnectDeps({ store, clock: fixedClock(LATER), familyRender: fakeFamilyRender() }),
      { userId: USER, conversationId: null },
    );
    expectFullyAccounted(second);
    expect(store.signals).toHaveLength(4);
  });

  it("records a candidate whose entity has been deleted", async () => {
    const store = mixedStore();
    store.entities = store.entities.filter((entity) => entity.id !== MARY);

    const { deps } = harness({ store });
    const result = await runDetectionSweep(deps, { userId: USER, conversationId: null });

    expectFullyAccounted(result);
    expect(
      result.signals.find((entry) => entry.entityId === MARY)?.outcome,
    ).toBe("entity_missing");
  });

  it("a permanently unreadable pending signal does not drain the budget", async () => {
    // The live account has two of these, left by a pre-schema deploy. Charging
    // them would starve everything behind them on every single sweep — so the
    // store deliberately holds MORE real candidates than the budget of three
    // minus the two stuck rows. If rejections cost budget, work is deferred.
    const store = mixedStore();
    for (const extra of ["entity-eli", "entity-zoe"]) {
      store.entities.push({
        id: extra, type: "person", subtype: null, displayName: extra,
        aliases: [], status: "active", lastMentionedAt: null,
      });
      store.interactionEvents.push(...weekly(13, extra));
      store.baselines.set(`${extra}:visit`, activeBaseline(extra));
    }
    for (const entityId of [MARY, KATE]) {
      const key = cadenceDetectionKey({
        entityId, eventType: "visit",
        baselineInputsHash: `inputs-${entityId}`, lastEventId: `${entityId}-13`,
      });
      const id = pendingSignal(store, entityId, key, "cadence_gap");
      const signal = store.signals.find((row) => row.id === id)!;
      signal.explanation = { detectionKey: key, detector: "cadence_gap", nonsense: true };
    }

    const { deps } = harness({ store });
    const result = await runDetectionSweep(deps, { userId: USER, conversationId: null });

    expectFullyAccounted(result);
    const outcomes = result.signals.map((entry) => entry.outcome);
    expect(result.candidates).toBe(5);
    expect(outcomes.filter((o) => o === "rejected")).toHaveLength(2);
    // All three real candidates behind the stuck rows were still processed:
    // the budget of three was spent entirely on work that writes.
    expect(outcomes.filter((o) => o === "materialized")).toHaveLength(3);
    expect(outcomes).not.toContain("deferred");
  });

  it("resuming a `proposed` draft does not drain the signal budget either", async () => {
    // Drafting has its own bound (one per sweep). Charging it to the signal
    // budget would let one abandoned draft push a real detection out.
    const store = mixedStore();
    for (const extra of ["entity-eli"]) {
      store.entities.push({
        id: extra, type: "person", subtype: null, displayName: extra,
        aliases: [], status: "active", lastMentionedAt: null,
      });
      store.interactionEvents.push(...weekly(13, extra));
      store.baselines.set(`${extra}:visit`, activeBaseline(extra));
    }
    // MARY already materialized, but her draft never landed.
    const cadenceKey = cadenceDetectionKey({
      entityId: MARY, eventType: "visit",
      baselineInputsHash: `inputs-${MARY}`, lastEventId: `${MARY}-13`,
    });
    const signalId = pendingSignal(store, MARY, cadenceKey, "cadence_gap");
    const signal = store.signals.find((row) => row.id === signalId)!;
    signal.status = "materialized";
    signal.materializedAt = iso(0);
    store.opportunities.push({
      id: "opp-pending", userId: USER, signalId, entityId: MARY,
      proposal: {
        entityId: MARY, entityName: "Mary", eventType: "visit",
        observation: { kind: "no_mention_since", days: 13 }, question: "ask_if_visiting",
      },
      sharePayload: null, renderedText: null, renderedTextHash: null,
      status: "proposed", offeredAt: null, resolvedAt: null,
      expiresAt: new Date(NOW.getTime() + DAY_MS).toISOString(), createdAt: iso(0),
    });

    const { deps } = harness({ store });
    const result = await runDetectionSweep(deps, { userId: USER, conversationId: null });

    expectFullyAccounted(result);
    const outcomes = result.signals.map((entry) => entry.outcome);
    expect(result.candidates).toBe(4);
    expect(outcomes.filter((o) => o === "resumed_draft")).toHaveLength(1);
    // The three detections still all fit in the budget.
    expect(outcomes.filter((o) => o === "materialized")).toHaveLength(3);
    expect(outcomes).not.toContain("deferred");
  });
});

describe("5g. cadence is never starved by absence", () => {
  const KATE = "entity-kate";

  it("resumes a pending CADENCE signal — the exact live case", async () => {
    // entity M4Cadence1789574530: cadence_gap, status detected, opportunity null.
    const store = baseStore({
      interactionEvents: weekly(13),
      baselines: new Map([[`${JOHN}:visit`, activeBaseline()]]),
    });
    const key = cadenceDetectionKey({
      entityId: JOHN, eventType: "visit",
      baselineInputsHash: `inputs-${JOHN}`, lastEventId: `${JOHN}-13`,
    });
    store.signals.push({
      id: "sig-live", userId: USER, entityId: JOHN, baselineId: null,
      signalType: "cadence_gap", status: "detected",
      explanation: {
        detector: "cadence_gap", methodVersion: "detection.v1", detectionKey: key,
        entityId: JOHN, eventType: "visit", medianGapDays: 7, madDays: 1,
        thresholdDays: 11, daysSinceLast: 13, lastEventId: `${JOHN}-13`,
        lastEventDate: "2026-09-03", contributingEventCount: 5,
        baselineInputsHash: `inputs-${JOHN}`, conversationId: null,
      },
      detectedAt: iso(0), suppressionReason: null, materializedAt: null,
    });

    const { deps, render } = harness({ store });
    const result = await runDetectionSweep(deps, { userId: USER, conversationId: null });

    expectFullyAccounted(result);
    expect(result.signals[0]).toMatchObject({
      signalId: "sig-live",
      signalType: "cadence_gap",
      outcome: "resumed_materialized",
    });
    // The SAME signal, not a replacement.
    expect(store.signals).toHaveLength(1);
    expect(store.signals[0].id).toBe("sig-live");
    expect(store.signals[0].status).toBe("materialized");
    expect(store.opportunities).toHaveLength(1);
    expect(store.opportunities[0].signalId).toBe("sig-live");
    expect(store.opportunities[0].status).toBe("drafted");
    expect(render.calls).toHaveLength(1);
  });

  it("detects a fresh cadence gap with no prior signal, and reports it", async () => {
    // entity M4Cadence1789574689: ACTIVE, median 7, MAD 0, threshold 11,
    // last positive event 13 days ago, no signal, no opportunity.
    const store = baseStore({
      interactionEvents: weekly(13),
      baselines: new Map([
        [`${JOHN}:visit`, { ...activeBaseline(), madDays: 0 }],
      ]),
    });
    const { deps } = harness({ store });

    const result = await runDetectionSweep(deps, { userId: USER, conversationId: null });

    expectFullyAccounted(result);
    expect(result.candidates).toBe(1);
    expect(result.signals).toHaveLength(1);
    expect(result.signals[0]).toMatchObject({
      signalType: "cadence_gap",
      outcome: "materialized",
    });
    const explanation = store.signals[0].explanation as {
      medianGapDays: number; madDays: number; thresholdDays: number; daysSinceLast: number;
    };
    expect(explanation).toMatchObject({
      medianGapDays: 7, madDays: 0, thresholdDays: 11, daysSinceLast: 13,
    });
    expect(store.opportunities[0].status).toBe("drafted");
  });

  it("processes absence AND cadence in one sweep, recovery first", async () => {
    // The live shape: pending absence, pending cadence, fresh cadence.
    const store = baseStore({
      interactionEvents: [
        absenceEvent("abs-john", JOHN),
        ...weekly(13, MARY),
        ...weekly(13, KATE),
      ],
      baselines: new Map([
        [`${MARY}:visit`, activeBaseline(MARY)],
        [`${KATE}:visit`, activeBaseline(KATE)],
      ]),
    });
    store.entities.push({
      id: KATE, type: "person", subtype: null, displayName: "Kate",
      aliases: [], status: "active", lastMentionedAt: null,
    });

    const absenceKey = absenceDetectionKey("abs-john");
    const cadenceKey = cadenceDetectionKey({
      entityId: MARY, eventType: "visit",
      baselineInputsHash: `inputs-${MARY}`, lastEventId: `${MARY}-13`,
    });
    store.signals.push(
      {
        id: "pending-absence", userId: USER, entityId: JOHN, baselineId: null,
        signalType: "user_asserted_absence", status: "detected",
        explanation: {
          detector: "user_asserted_absence", methodVersion: "detection.v1",
          detectionKey: absenceKey, entityId: JOHN, eventType: "visit",
          sourceEventId: "abs-john", absenceWindowStart: iso(7),
          absenceWindowEnd: iso(0), statedPhrase: null, reportedAt: iso(0),
          certainty: 0.9, baseline: null, conversationId: null,
        },
        detectedAt: iso(0), suppressionReason: null, materializedAt: null,
      },
      {
        id: "pending-cadence", userId: USER, entityId: MARY, baselineId: null,
        signalType: "cadence_gap", status: "detected",
        explanation: {
          detector: "cadence_gap", methodVersion: "detection.v1",
          detectionKey: cadenceKey, entityId: MARY, eventType: "visit",
          medianGapDays: 7, madDays: 1, thresholdDays: 11, daysSinceLast: 13,
          lastEventId: `${MARY}-13`, lastEventDate: "2026-09-03",
          contributingEventCount: 5, baselineInputsHash: `inputs-${MARY}`,
          conversationId: null,
        },
        detectedAt: iso(0), suppressionReason: null, materializedAt: null,
      },
    );

    const { deps } = harness({ store });
    const result = await runDetectionSweep(deps, { userId: USER, conversationId: null });

    expectFullyAccounted(result);
    expect(result.candidates).toBe(3);

    const byEntity = new Map(result.signals.map((entry) => [entry.entityId, entry]));
    // Both pending cycles resumed — the cadence one was NOT starved behind the
    // absence one, which is precisely what happened live.
    expect(byEntity.get(JOHN)).toMatchObject({
      signalId: "pending-absence", outcome: "resumed_materialized",
    });
    expect(byEntity.get(MARY)).toMatchObject({
      signalId: "pending-cadence", outcome: "resumed_materialized",
    });
    // And the fresh cadence candidate was processed in the same sweep.
    expect(byEntity.get(KATE)).toMatchObject({
      signalType: "cadence_gap", outcome: "materialized",
    });

    expect(store.signals).toHaveLength(3);
    expect(store.signals.filter((row) => row.status === "materialized")).toHaveLength(3);
    expect(store.opportunities).toHaveLength(3);
    // Drafting stays bounded at one per sweep; the rest resume next time.
    expect(result.drafts).toHaveLength(1);
  });

  it("recovery outranks fresh detection when the budget is tight", async () => {
    // Three fresh absence candidates plus one pending cadence: under the old
    // precedence-ordered slice the pending cadence could never be reached.
    const store = baseStore({
      interactionEvents: [
        ...weekly(13, MARY),
        absenceEvent("abs-a", JOHN),
        absenceEvent("abs-b", SIMBA),
        absenceEvent("abs-c", KATE),
      ],
      baselines: new Map([[`${MARY}:visit`, activeBaseline(MARY)]]),
    });
    store.entities.push({
      id: KATE, type: "person", subtype: null, displayName: "Kate",
      aliases: [], status: "active", lastMentionedAt: null,
    });
    const cadenceKey = cadenceDetectionKey({
      entityId: MARY, eventType: "visit",
      baselineInputsHash: `inputs-${MARY}`, lastEventId: `${MARY}-13`,
    });
    store.signals.push({
      id: "pending-cadence", userId: USER, entityId: MARY, baselineId: null,
      signalType: "cadence_gap", status: "detected",
      explanation: {
        detector: "cadence_gap", methodVersion: "detection.v1",
        detectionKey: cadenceKey, entityId: MARY, eventType: "visit",
        medianGapDays: 7, madDays: 1, thresholdDays: 11, daysSinceLast: 13,
        lastEventId: `${MARY}-13`, lastEventDate: "2026-09-03",
        contributingEventCount: 5, baselineInputsHash: `inputs-${MARY}`,
        conversationId: null,
      },
      detectedAt: iso(0), suppressionReason: null, materializedAt: null,
    });

    const { deps } = harness({ store });
    const result = await runDetectionSweep(deps, { userId: USER, conversationId: null });

    expectFullyAccounted(result);
    expect(result.candidates).toBe(4);
    // The unfinished cycle went first, whatever the detector precedence says.
    expect(result.signals[0]).toMatchObject({
      signalId: "pending-cadence", outcome: "resumed_materialized",
    });
    expect(result.signals.filter((e) => e.outcome === "deferred")).toHaveLength(1);
  });
});

describe("5d. absence provenance is truthful", () => {
  it("carries the person's exact phrase when the observation holds it", async () => {
    const { row, observation, window } = absenceWithObservation("last week");
    const store = baseStore({ interactionEvents: [row], observations: [observation] });
    const { deps } = harness({ store });

    await runDetectionSweep(deps, { userId: USER, conversationId: null });

    const proposal = store.opportunities[0].proposal as {
      observation: { kind: string; statedPhrase?: string; window: { start: string; end: string } };
    };
    expect(proposal.observation.kind).toBe("user_stated_absence");
    expect(proposal.observation.statedPhrase).toBe("last week");
    expect(proposal.observation.window).toEqual({
      start: window.start.toISOString(),
      end: window.end.toISOString(),
    });
    expect(store.signals[0].explanation).toMatchObject({ statedPhrase: "last week" });
  });

  it("claims no quote when only resolved dates are available", async () => {
    // The dev seeder writes absence rows with no observation behind them, and
    // so will any path where the phrase cannot be matched.
    const store = baseStore({ interactionEvents: [absenceEvent()] });
    const { deps } = harness({ store });

    await runDetectionSweep(deps, { userId: USER, conversationId: null });

    const proposal = store.opportunities[0].proposal as {
      observation: { kind: string; statedPhrase?: string; window: { start: string; end: string } };
    };
    expect(proposal.observation.statedPhrase).toBeUndefined();
    expect("statedPhrase" in proposal.observation).toBe(false);
    expect(proposal.observation.window.start).toBeTruthy();
    expect(proposal.observation.window.end).toBeTruthy();
    // And nothing anywhere pretends a date range was spoken.
    expect(JSON.stringify(proposal)).not.toContain("quotedWindow");
    expect(store.signals[0].explanation).toMatchObject({ statedPhrase: null });
  });

  it("still works with NO_BASELINE, and makes no pattern claim", async () => {
    const { row, observation } = absenceWithObservation("last week");
    const store = baseStore({ interactionEvents: [row], observations: [observation] });
    const { deps } = harness({ store });

    const result = await runDetectionSweep(deps, { userId: USER, conversationId: null });

    expect(result.signals[0]).toMatchObject({
      signalType: "user_asserted_absence",
      outcome: "materialized",
    });
    expect(store.opportunities[0].proposal).not.toHaveProperty("pattern");
    expect(store.opportunities[0].status).toBe("drafted");
  });

  it("introduces no affect or clinical vocabulary anywhere in the proposal", async () => {
    const { row, observation } = absenceWithObservation("last week");
    const store = baseStore({ interactionEvents: [row], observations: [observation] });
    const { deps } = harness({ store });
    await runDetectionSweep(deps, { userId: USER, conversationId: null });

    const serialized = JSON.stringify(store.opportunities[0].proposal);
    expect(findDeniedTerm(serialized)).toBeNull();
    expect(findDeniedTerm(JSON.stringify(store.signals[0].explanation))).toBeNull();
  });

  it("the phrase never reaches the outbound payload", async () => {
    const { row, observation } = absenceWithObservation("last week");
    const store = baseStore({ interactionEvents: [row], observations: [observation] });
    const render = fakeFamilyRender();
    const { deps } = harness({ store, render });

    await runDetectionSweep(deps, { userId: USER, conversationId: null });

    expect(render.calls[0].serialized).not.toContain("last week");
    expect(render.calls[0].serialized).not.toContain("statedPhrase");
  });
});

describe("6. drafting: guard, fallback and hashing", () => {
  async function materializedOpportunity(deps: ReconnectDeps, expiresAt = new Date(NOW.getTime() + DAY_MS)) {
    const signal = await deps.signals.insert({
      userId: USER, entityId: JOHN, baselineId: null, signalType: "cadence_gap",
      explanation: { detectionKey: `dk-${Math.random()}` }, detectedAt: NOW.toISOString(),
    });
    const result = await deps.opportunities.materialize({
      signalId: signal.id, userId: USER, entityId: JOHN,
      proposal: {
        entityId: JOHN, entityName: "John", alsoMention: ["Simba"], eventType: "visit",
        observation: { kind: "no_mention_since", days: 13 },
        pattern: { medianGapDays: 7 }, question: "ask_if_visiting",
      },
      expiresAt: expiresAt.toISOString(), now: NOW.toISOString(),
    });
    return result.opportunityId!;
  }

  it("uses the deterministic template when the renderer throws", async () => {
    const store = baseStore();
    const render = fakeFamilyRender({ failWith: new Error("upstream down") });
    const deps = fakeReconnectDeps({ store, clock: fixedClock(NOW), familyRender: render });
    const id = await materializedOpportunity(deps);

    const result = await draftOpportunity(deps, { userId: USER, opportunityId: id });

    expect(result.outcome).toBe("drafted");
    expect(result.fallbackUsed).toBe(true);
    const stored = store.opportunities[0];
    expect(stored.renderedText).toBe("Dad was wondering — are you and Simba able to visit soon?");
    expect(checkOutboundText(stored.renderedText!, { question: "ask_if_visiting" }).accepted).toBe(true);
  });

  it("uses the template when the renderer returns unsafe text, and never asks again", async () => {
    const store = baseStore();
    const render = fakeFamilyRender({
      text: "John, Dad has been lonely because you haven't visited. Can you come over?",
    });
    const deps = fakeReconnectDeps({ store, clock: fixedClock(NOW), familyRender: render });
    const id = await materializedOpportunity(deps);

    const result = await draftOpportunity(deps, { userId: USER, opportunityId: id });

    expect(result.fallbackUsed).toBe(true);
    expect(result.guardFailures).toContain("denied_term");
    expect(result.guardFailures).toContain("causal_inference");
    // What is STORED is the template, not the rejected sentence. Reporting a
    // rejection while persisting the bytes anyway would be the whole guard
    // reduced to a log line.
    const stored = store.opportunities[0];
    expect(stored.renderedText).toBe("Dad was wondering — are you and Simba able to visit soon?");
    expect(stored.renderedText!.toLowerCase()).not.toContain("lonely");
    expect(checkOutboundText(stored.renderedText!, { question: "ask_if_visiting" }).accepted).toBe(true);
    expect(stored.renderedTextHash).toBe(sha256Hex(stored.renderedText!));
    // One attempt maximum: no repair prompt, no second sample.
    expect(render.calls).toHaveLength(1);
  });

  it("uses the template when the question did not survive rendering", async () => {
    const store = baseStore();
    const render = fakeFamilyRender({ text: "Dad sends his love and hopes all is well." });
    const deps = fakeReconnectDeps({ store, clock: fixedClock(NOW), familyRender: render });
    const id = await materializedOpportunity(deps);

    const result = await draftOpportunity(deps, { userId: USER, opportunityId: id });
    expect(result.guardFailures).toContain("question_missing");
    expect(result.fallbackUsed).toBe(true);
    expect(store.opportunities[0].renderedText).toBe(
      "Dad was wondering — are you and Simba able to visit soon?",
    );
  });

  it("uses the template when the renderer inverts the visit relation", async () => {
    // END TO END on the live failure. The renderer points the visit at the
    // companion; the guard rejects; the fallback is what gets hashed, stored
    // and later shown to the older adult for approval. There is no repair
    // prompt and no second sample.
    const store = baseStore();
    const render = fakeFamilyRender({
      text: "Dad would like to know if you can visit Simba?",
    });
    const deps = fakeReconnectDeps({ store, clock: fixedClock(NOW), familyRender: render });
    const id = await materializedOpportunity(deps);

    const result = await draftOpportunity(deps, { userId: USER, opportunityId: id });

    expect(result.guardFailures).toContain("inverted_visit_target");
    expect(result.fallbackUsed).toBe(true);

    const stored = store.opportunities[0];
    expect(stored.renderedText).toBe("Dad was wondering — are you and Simba able to visit soon?");
    // The message that would have asked the son to go and see the dog never
    // reaches storage, so it can never reach the offer either.
    expect(stored.renderedText).not.toContain("visit Simba");
    expect(stored.renderedTextHash).toBe(sha256Hex(stored.renderedText!));
    expect(render.calls).toHaveLength(1);
  });

  it("accepts a render that puts the companion alongside the reader", async () => {
    const text = "Dad was wondering — could you and Simba come and visit him this weekend?";
    const store = baseStore();
    const render = fakeFamilyRender({ text });
    const deps = fakeReconnectDeps({ store, clock: fixedClock(NOW), familyRender: render });
    const id = await materializedOpportunity(deps);

    const result = await draftOpportunity(deps, { userId: USER, opportunityId: id });
    expect(result.guardFailures).toEqual([]);
    expect(result.fallbackUsed).toBe(false);
    expect(store.opportunities[0].renderedText).toBe(text);
  });

  it("accepts a render that leaves the companion out", async () => {
    const text = "Dad was wondering whether you might come round and visit him soon?";
    const store = baseStore();
    const render = fakeFamilyRender({ text });
    const deps = fakeReconnectDeps({ store, clock: fixedClock(NOW), familyRender: render });
    const id = await materializedOpportunity(deps);

    expect((await draftOpportunity(deps, { userId: USER, opportunityId: id })).fallbackUsed).toBe(
      false,
    );
    expect(store.opportunities[0].renderedText).toBe(text);
  });

  it("accepts a safe render unchanged and stores its exact bytes", async () => {
    const text = "Dad was wondering whether you and Simba might come round soon. Any chance?";
    const store = baseStore();
    const render = fakeFamilyRender({ text });
    const deps = fakeReconnectDeps({ store, clock: fixedClock(NOW), familyRender: render });
    const id = await materializedOpportunity(deps);

    const result = await draftOpportunity(deps, { userId: USER, opportunityId: id });

    expect(result.fallbackUsed).toBe(false);
    expect(store.opportunities[0].renderedText).toBe(text);
    expect(store.opportunities[0].renderedTextHash).toBe(sha256Hex(text));
  });

  it("hashes the exact bytes: one character changes the hash", async () => {
    const text = "Dad was wondering — are you able to visit soon?";
    expect(sha256Hex(text)).toBe(sha256Hex(text));
    expect(sha256Hex(text)).not.toBe(sha256Hex(`${text.slice(0, -1)}!`));
    expect(sha256Hex(text)).toHaveLength(64);
    // No trimming or normalizing after the fact.
    expect(sha256Hex(` ${text}`)).not.toBe(sha256Hex(text));
  });

  it("a second draft attempt reuses the stored bytes and calls nothing", async () => {
    const store = baseStore();
    const render = fakeFamilyRender();
    const deps = fakeReconnectDeps({ store, clock: fixedClock(NOW), familyRender: render });
    const id = await materializedOpportunity(deps);

    const first = await draftOpportunity(deps, { userId: USER, opportunityId: id });
    const second = await draftOpportunity(deps, { userId: USER, opportunityId: id });

    expect(second.outcome).toBe("already_drafted");
    expect(second.rendererCalled).toBe(false);
    expect(second.renderedTextHash).toBe(first.renderedTextHash);
    expect(render.calls).toHaveLength(1);
  });

  it("stores a payload that parses against the whitelist", async () => {
    const store = baseStore();
    const deps = fakeReconnectDeps({ store, clock: fixedClock(NOW) });
    const id = await materializedOpportunity(deps);
    await draftOpportunity(deps, { userId: USER, opportunityId: id });
    const parsed = SharePayloadSchema.safeParse(store.opportunities[0].sharePayload);
    expect(parsed.success).toBe(true);
  });

  it("refuses to draft a proposal that no longer parses", async () => {
    const store = baseStore();
    const deps = fakeReconnectDeps({ store, clock: fixedClock(NOW) });
    const id = await materializedOpportunity(deps);
    store.opportunities[0].proposal = { entityName: 42 };
    const result = await draftOpportunity(deps, { userId: USER, opportunityId: id });
    expect(result.outcome).toBe("invalid_proposal");
    expect(result.rendererCalled).toBe(false);
  });
});

describe("7. expiry governs offerability and is never extended", () => {
  it("an already-expired opportunity is expired, not drafted, and nothing is rendered", async () => {
    const store = baseStore();
    const render = fakeFamilyRender();
    const deps = fakeReconnectDeps({ store, clock: fixedClock(NOW), familyRender: render });
    const signal = await deps.signals.insert({
      userId: USER, entityId: JOHN, baselineId: null, signalType: "cadence_gap",
      explanation: { detectionKey: "dk" }, detectedAt: iso(2),
    });
    const created = await deps.opportunities.materialize({
      signalId: signal.id, userId: USER, entityId: JOHN,
      proposal: { entityId: JOHN, entityName: "John", eventType: "visit", observation: { kind: "no_mention_since", days: 13 }, question: "ask_if_visiting" },
      expiresAt: iso(1), now: iso(2),
    });

    const result = await draftOpportunity(deps, { userId: USER, opportunityId: created.opportunityId! });

    expect(result.outcome).toBe("expired");
    expect(result.rendererCalled).toBe(false);
    expect(store.opportunities[0].status).toBe("expired");
    expect(store.opportunities[0].renderedText).toBeNull();
    expect(render.calls).toHaveLength(0);
  });

  it("expiring DURING the render refuses to persist an offerable draft", async () => {
    const store = baseStore();
    const render = fakeFamilyRender();
    // Fresh before the call, past expiry after it.
    let calls = 0;
    const steppingClock: Clock = {
      now: () => (++calls <= 1 ? NOW : new Date(NOW.getTime() + 25 * 3_600_000)),
    };
    const deps = fakeReconnectDeps({ store, clock: fixedClock(NOW), familyRender: render });
    const signal = await deps.signals.insert({
      userId: USER, entityId: JOHN, baselineId: null, signalType: "cadence_gap",
      explanation: { detectionKey: "dk" }, detectedAt: NOW.toISOString(),
    });
    const expiresAt = new Date(NOW.getTime() + 24 * 3_600_000).toISOString();
    const created = await deps.opportunities.materialize({
      signalId: signal.id, userId: USER, entityId: JOHN,
      proposal: { entityId: JOHN, entityName: "John", eventType: "visit", observation: { kind: "no_mention_since", days: 13 }, question: "ask_if_visiting" },
      expiresAt, now: NOW.toISOString(),
    });

    const racing = fakeReconnectDeps({ store, clock: steppingClock, familyRender: render });
    const result = await draftOpportunity(racing, { userId: USER, opportunityId: created.opportunityId! });

    expect(result.outcome).toBe("expired");
    expect(result.rendererCalled).toBe(true);
    const stored = store.opportunities[0];
    expect(stored.status).toBe("expired");
    expect(stored.renderedText).toBeNull();
    // The clock was not moved to accommodate the slow call.
    expect(stored.expiresAt).toBe(expiresAt);
  });
});

describe("8. the family renderer receives the payload and nothing else", () => {
  it("never sees a transcript, an id, an elapsed day count or a baseline", async () => {
    const store = baseStore({
      interactionEvents: weekly(13).map((e) => ({ ...e, ingestFingerprint: SENTINEL })),
      baselines: new Map([[`${JOHN}:visit`, activeBaseline()]]),
    });
    // Sentinel private content planted everywhere the renderer might reach it.
    store.entities = store.entities.map((entity) =>
      entity.id === SIMBA ? { ...entity, aliases: [SENTINEL] } : entity,
    );
    const { deps, render } = harness({ store });

    await runDetectionSweep(deps, { userId: USER, conversationId: SENTINEL });

    expect(render.calls).toHaveLength(1);
    const serialized = render.calls[0].serialized;

    expect(serialized).not.toContain(SENTINEL);
    for (const leak of [
      "13", "daysSinceLast", "no_mention_since", "medianGapDays", "madDays",
      "thresholdDays", "inputsHash", `inputs-${JOHN}`, "detectionKey",
      "sourceObservationId", "entityId", JOHN, "John", "conv",
    ]) {
      expect(serialized).not.toContain(leak);
    }

    // What it DOES contain is exactly the whitelist.
    const userMessage = render.calls[0].messages.find((m) => m.role === "user")!.content;
    expect(userMessage).toBe(
      "fromDisplayName: Dad\naboutEntityName: Simba\ntopic: visit\nquestion: ask_if_visiting",
    );
    expect(render.calls[0].messages).toHaveLength(2);
    expect(render.calls[0].promptRef).toBe("family-render.v2");
  });
});
