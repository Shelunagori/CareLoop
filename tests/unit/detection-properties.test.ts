import fc from "fast-check";
import { describe, it } from "vitest";
import { fixedClock } from "@/server/adapters/clock";
import { computeBaseline, computeCadenceThreshold, type BaselineInputEvent } from "@/core/baseline/compute";
import { DAY_MS } from "@/core/baseline/day";
import { detectCadenceGap } from "@/core/detection/cadence";
import { detectAssertedAbsence } from "@/core/detection/absence";
import { resolveDetections } from "@/core/detection/detect";
import { evaluateSuppression } from "@/core/detection/suppression";
import { buildProposal } from "@/core/detection/proposal";
import { minimize } from "@/core/share/minimize";
import { SHARE_PAYLOAD_FIELDS, SharePayloadSchema } from "@/core/share/payload";
import { sha256Hex } from "@/core/share/text-hash";
import { classifyCycle, draftOpportunity, runDetectionSweep } from "@/server/services/reconnect";
import { createStore, fakeFamilyRender, fakeReconnectDeps, resetIds } from "./detection-fakes";
import type { CadenceExplanation } from "@/core/detection/types";

/**
 * Property tests for detection, suppression and the outbound boundary.
 *
 * Example tests pin the cases we thought of; these pin the ones we did not.
 * Seeded, so a failure is reproducible rather than a story about a build that
 * went red once.
 */
const NOW = new Date("2026-09-16T00:00:00.000Z");
const RUNS = { numRuns: 400, seed: 20260916 };
const ENTITY = "entity-1";

/** The RPC verifies the entity exists and is the user's, so the store must
 *  hold it — the fake mirrors that check. */
const ENTITY_ROW = {
  id: ENTITY,
  type: "person" as const,
  subtype: null,
  displayName: "X",
  aliases: [] as string[],
  status: "active" as const,
  origin: "user" as const,
  lastMentionedAt: null,
};

function eventsAt(daysAgo: readonly number[]): BaselineInputEvent[] {
  return daysAgo.map((d, index) => ({
    id: `e${index}-${d}`,
    occurredAt: new Date(NOW.getTime() - d * DAY_MS),
    occurredAtPrecision: "day" as const,
    certainty: 0.9,
    polarity: "positive" as const,
  }));
}

const offsets = fc.array(fc.integer({ min: 0, max: 175 }), { minLength: 0, maxLength: 14 });

describe("cadence: the detector cannot run without a rhythm", () => {
  it("never fires unless the baseline is ACTIVE", () => {
    fc.assert(
      fc.property(offsets, (days) => {
        const events = eventsAt(days);
        const baseline = computeBaseline(events, NOW);
        const candidate = detectCadenceGap({
          entityId: ENTITY, eventType: "visit", baseline, events, now: NOW, conversationId: null,
        });
        return candidate === null || baseline.status === "ACTIVE";
      }),
      RUNS,
    );
  });

  it("never fires at or below the threshold, and always fires above it", () => {
    fc.assert(
      fc.property(offsets, (days) => {
        const events = eventsAt(days);
        const baseline = computeBaseline(events, NOW);
        if (baseline.status !== "ACTIVE") return true;
        const threshold = computeCadenceThreshold(baseline.medianGapDays!, baseline.madDays!);
        const daysSinceLast = Math.min(...days);
        const candidate = detectCadenceGap({
          entityId: ENTITY, eventType: "visit", baseline, events, now: NOW, conversationId: null,
        });
        return daysSinceLast > threshold ? candidate !== null : candidate === null;
      }),
      RUNS,
    );
  });

  it("the explanation's arithmetic always agrees with the shared threshold function", () => {
    fc.assert(
      fc.property(offsets, (days) => {
        const events = eventsAt(days);
        const baseline = computeBaseline(events, NOW);
        const candidate = detectCadenceGap({
          entityId: ENTITY, eventType: "visit", baseline, events, now: NOW, conversationId: null,
        });
        if (candidate === null) return true;
        const explanation = candidate.explanation as CadenceExplanation;
        return (
          explanation.thresholdDays ===
            computeCadenceThreshold(explanation.medianGapDays, explanation.madDays) &&
          explanation.daysSinceLast > explanation.thresholdDays
        );
      }),
      RUNS,
    );
  });
});

describe("absence: the person's own statement never depends on our statistics", () => {
  it("fires identically with any baseline status and with none", () => {
    fc.assert(
      fc.property(offsets, fc.integer({ min: 1, max: 30 }), (days, windowDays) => {
        const baseline = computeBaseline(eventsAt(days), NOW);
        const event = {
          id: "abs",
          entityId: ENTITY,
          eventType: "visit" as const,
          polarity: "absence" as const,
          windowStart: new Date(NOW.getTime() - windowDays * DAY_MS),
          windowEnd: NOW,
          reportedAt: NOW,
          certainty: 0.9,
        };
        const withBaseline = detectAssertedAbsence({ event, baseline, now: NOW, conversationId: null });
        const without = detectAssertedAbsence({ event, baseline: null, now: NOW, conversationId: null });
        return (
          withBaseline !== null &&
          without !== null &&
          withBaseline.detectionKey === without.detectionKey
        );
      }),
      RUNS,
    );
  });

  it("a proposal claims a pattern only when the attached baseline is ACTIVE", () => {
    fc.assert(
      fc.property(offsets, (days) => {
        const baseline = computeBaseline(eventsAt(days), NOW);
        const candidate = detectAssertedAbsence({
          event: {
            id: "abs", entityId: ENTITY, eventType: "visit", polarity: "absence",
            windowStart: new Date(NOW.getTime() - 7 * DAY_MS), windowEnd: NOW,
            reportedAt: NOW, certainty: 0.9,
          },
          baseline, now: NOW, conversationId: null,
        })!;
        const proposal = buildProposal({
          explanation: candidate.explanation, entityName: "X", alsoMention: [], baseline,
        });
        return (proposal.pattern !== undefined) === (baseline.status === "ACTIVE");
      }),
      RUNS,
    );
  });
});

describe("precedence is a total order", () => {
  it("is independent of input order, and keeps one candidate per entity", () => {
    const candidate = (entityId: string, kind: "cadence_gap" | "user_asserted_absence", at: number) => ({
      signalType: kind,
      entityId,
      eventType: "visit" as const,
      detectionKey: `${entityId}-${kind}-${at}`,
      explanation: {
        detector: kind, methodVersion: "detection.v1", detectionKey: `${entityId}-${kind}-${at}`,
        entityId, eventType: "visit",
      } as never,
      priority: kind === "user_asserted_absence" ? 2 : 1,
      orderedAt: at,
    });

    fc.assert(
      fc.property(
        fc.array(
          fc.tuple(
            fc.constantFrom("e1", "e2", "e3"),
            fc.constantFrom("cadence_gap" as const, "user_asserted_absence" as const),
            fc.integer({ min: 0, max: 5 }),
          ),
          { maxLength: 8 },
        ),
        (rows) => {
          const built = rows.map(([e, k, at]) => candidate(e, k, at));
          const forward = resolveDetections(built);
          const backward = resolveDetections([...built].reverse());
          const keys = (r: typeof forward) => r.selected.map((c) => c.detectionKey).join("|");
          const entities = new Set(forward.selected.map((c) => c.entityId));
          return (
            keys(forward) === keys(backward) &&
            entities.size === forward.selected.length &&
            forward.selected.length + forward.discarded.length === built.length
          );
        },
      ),
      RUNS,
    );
  });
});

describe("suppression never permits a second open opportunity for one entity", () => {
  it("refuses whenever one is already open, whatever else is true", () => {
    fc.assert(
      fc.property(
        fc.record({
          signalType: fc.constantFrom("cadence_gap" as const, "user_asserted_absence" as const),
          open: fc.integer({ min: 1, max: 4 }),
          accountAgeDays: fc.integer({ min: 0, max: 400 }),
          outstanding: fc.integer({ min: 0, max: 3 }),
          offersInConversation: fc.integer({ min: 0, max: 3 }),
        }),
        (input) => {
          const decision = evaluateSuppression(
            {
              signalType: input.signalType,
              entityId: ENTITY,
              accountStartedAt: new Date(NOW.getTime() - input.accountAgeDays * DAY_MS),
              openOpportunityCountForEntity: input.open,
              offeredAtForEntity: [],
              declinedAtForEntity: [],
              outstandingFamilyRequestCount: input.outstanding,
              offersInConversation: input.offersInConversation,
              offeredAtForAccount: [],
            },
            NOW,
          );
          return !decision.allowed && decision.reason === "open_opportunity_exists";
        },
      ),
      RUNS,
    );
  });
});

describe("the outbound boundary holds for any proposal", () => {
  it("minimize emits only whitelisted fields, and the strict schema accepts them", () => {
    fc.assert(
      fc.property(
        fc.record({
          entityName: fc.string({ minLength: 1, maxLength: 60 }),
          alsoMention: fc.array(fc.string({ maxLength: 60 }), { maxLength: 4 }),
          familyDisplayName: fc.option(fc.string({ maxLength: 60 }), { nil: null }),
          eventType: fc.constantFrom("visit" as const, "call" as const),
          days: fc.integer({ min: 0, max: 400 }),
        }),
        (input) => {
          const payload = minimize({
            proposal: {
              entityId: ENTITY,
              entityName: input.entityName,
              alsoMention: input.alsoMention,
              eventType: input.eventType,
              observation: { kind: "no_mention_since", days: input.days },
              question: input.eventType === "call" ? "ask_if_calling" : "ask_if_visiting",
            },
            profile: { familyDisplayName: input.familyDisplayName },
          });

          const onlyWhitelisted = Object.keys(payload).every((key) =>
            (SHARE_PAYLOAD_FIELDS as readonly string[]).includes(key),
          );
          // The recipient's own name never leaves, whatever it is.
          const noRecipient = !JSON.stringify(payload).includes(ENTITY);
          return onlyWhitelisted && noRecipient && SharePayloadSchema.safeParse(payload).success;
        },
      ),
      RUNS,
    );
  });
});

describe("materialization and drafting are idempotent", () => {
  it("repeated materialization of one signal yields at most one opportunity", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 6 }), async (attempts) => {
        resetIds();
        const store = createStore({ entities: [ENTITY_ROW] });
        const deps = fakeReconnectDeps({ store, clock: fixedClock(NOW) });
        const signal = await deps.signals.insert({
          userId: "u", entityId: ENTITY, baselineId: null, signalType: "cadence_gap",
          explanation: { detectionKey: "k" }, detectedAt: NOW.toISOString(),
        });
        const args = {
          signalId: signal.id, userId: "u", entityId: ENTITY, proposal: {},
          expiresAt: new Date(NOW.getTime() + DAY_MS).toISOString(), now: NOW.toISOString(),
        };
        await Promise.all(
          Array.from({ length: attempts }, () => deps.opportunities.materialize(args)),
        );
        return store.opportunities.length === 1;
      }),
      { numRuns: 60, seed: 20260916 },
    );
  });

  it("a drafted opportunity's stored hash always matches its stored text", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 0, maxLength: 400 }),
        fc.constantFrom("visit" as const, "call" as const),
        async (renderText, eventType) => {
          resetIds();
          const store = createStore({
            entities: [ENTITY_ROW],
            profile: { id: "u", displayName: null, familyDisplayName: "Dad", createdAt: NOW.toISOString() },
          });
          const deps = fakeReconnectDeps({
            store,
            clock: fixedClock(NOW),
            familyRender: fakeFamilyRender({ text: renderText }),
          });
          const signal = await deps.signals.insert({
            userId: "u", entityId: ENTITY, baselineId: null, signalType: "cadence_gap",
            explanation: { detectionKey: "k" }, detectedAt: NOW.toISOString(),
          });
          const created = await deps.opportunities.materialize({
            signalId: signal.id, userId: "u", entityId: ENTITY,
            proposal: {
              entityId: ENTITY, entityName: "X", eventType,
              observation: { kind: "no_mention_since", days: 13 },
              question: eventType === "call" ? "ask_if_calling" : "ask_if_visiting",
            },
            expiresAt: new Date(NOW.getTime() + DAY_MS).toISOString(),
            now: NOW.toISOString(),
          });
          await draftOpportunity(deps, { userId: "u", opportunityId: created.opportunityId! });

          const stored = store.opportunities[0];
          if (stored.status !== "drafted") return false;
          // Whatever the model said, the stored bytes hash to the stored hash.
          return (
            stored.renderedText !== null &&
            stored.renderedTextHash === sha256Hex(stored.renderedText)
          );
        },
      ),
      { numRuns: 120, seed: 20260916 },
    );
  });
});

describe("an unfinished cycle is singular, reused, and blocks a fresh one", () => {
  const KEY = "dk-1";
  const signal = (
    id: string,
    status: "detected" | "materialized" | "suppressed",
    detectedAt: string,
  ) => ({
    id,
    entityId: ENTITY,
    baselineId: null,
    signalType: "cadence_gap" as const,
    status,
    explanation: { detectionKey: KEY },
    detectedAt,
    suppressionReason: status === "suppressed" ? "offer_cooldown" : null,
    materializedAt: status === "materialized" ? detectedAt : null,
  });

  it("classifies by unfinished-first precedence, for any mix of prior rows", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.tuple(
            fc.constantFrom("detected" as const, "materialized" as const, "suppressed" as const),
            fc.constantFrom(
              "proposed" as const, "drafted" as const, "offered" as const,
              "approved" as const, "expired" as const, "declined" as const,
              "consumed" as const, "none" as const,
            ),
          ),
          { maxLength: 5 },
        ),
        (rows) => {
          const signals = rows.map(([status], index) =>
            signal(`s${index}`, status, `2026-09-1${index}T00:00:00.000Z`),
          );
          const opportunities = new Map<string, { id: string; status: never }>();
          rows.forEach(([status, oppStatus], index) => {
            if (status === "materialized" && oppStatus !== "none") {
              opportunities.set(`s${index}`, { id: `o${index}`, status: oppStatus as never });
            }
          });

          const cycle = classifyCycle(KEY, signals, opportunities);
          const hasDetected = rows.some(([status]) => status === "detected");
          const hasProposed = rows.some(
            ([status, opp]) => status === "materialized" && opp === "proposed",
          );

          if (signals.length === 0) return cycle.kind === "NONE";
          // Unfinished states win, in order, over everything else.
          if (hasDetected) return cycle.kind === "DETECTED_PENDING";
          if (hasProposed) return cycle.kind === "PROPOSED_PENDING";
          return cycle.kind === "LIVE_COMPLETE" || cycle.kind === "RESOLVED";
        },
      ),
      RUNS,
    );
  });

  it("repeated sweeps over a failing materialization never create a second cycle", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 5 }),
        fc.integer({ min: 0, max: 4 }),
        async (sweeps, failures) => {
          resetIds();
          const NOW_LOCAL = new Date("2026-09-16T12:00:00.000Z");
          const day = 86_400_000;
          const store = createStore({
            entities: [ENTITY_ROW],
            profile: {
              id: "u", displayName: null, familyDisplayName: "Dad",
              createdAt: new Date(NOW_LOCAL.getTime() - 200 * day).toISOString(),
            },
            baselines: new Map([
              [
                `${ENTITY}:visit`,
                {
                  id: "bl", entityId: ENTITY, eventType: "visit" as const, status: "ACTIVE" as const,
                  medianGapDays: 7, madDays: 1, observationCount: 5,
                  windowStart: null, windowEnd: null, reasons: [],
                  methodVersion: "baseline.v1", inputsHash: "h",
                  computedAt: NOW_LOCAL.toISOString(),
                },
              ],
            ]),
            interactionEvents: [41, 36, 29, 22, 13].map((daysAgo) => ({
              id: `ie-${daysAgo}`, entityId: ENTITY, eventType: "visit" as const,
              occurredAt: new Date(NOW_LOCAL.getTime() - daysAgo * day).toISOString(),
              occurredAtPrecision: "day" as const,
              reportedAt: new Date(NOW_LOCAL.getTime() - daysAgo * day).toISOString(),
              certainty: 0.9, polarity: "positive" as const,
              windowStart: null, windowEnd: null, sourceObservationId: null,
              ingestFingerprint: `fp-${daysAgo}`,
            })),
          });

          let attempt = 0;
          for (let i = 0; i < sweeps; i += 1) {
            const deps = fakeReconnectDeps({
              store, clock: fixedClock(NOW_LOCAL), familyRender: fakeFamilyRender(),
            });
            const real = deps.opportunities.materialize;
            deps.opportunities.materialize = async (args) => {
              attempt += 1;
              if (attempt <= failures) {
                return { outcome: "invalid_expiry" as const, opportunityId: null };
              }
              return real(args);
            };
            await runDetectionSweep(deps, { userId: "u", conversationId: `c${i}` });
          }

          // However many retries happened, the evidence produced exactly ONE
          // cycle, and at most one opportunity.
          const unfinished = store.signals.filter((s) => s.status === "detected");
          return (
            store.signals.length === 1 &&
            unfinished.length <= 1 &&
            store.opportunities.length <= 1
          );
        },
      ),
      { numRuns: 60, seed: 20260916 },
    );
  });
});

describe("sweep accounting: no candidate ever disappears", () => {
  /**
   * The identity that would have caught the live failure outright:
   *
   *   candidates = discarded (lost precedence) + one explicit outcome each
   *
   * Generated across entity counts that straddle the per-sweep work budget,
   * with a mix of detectors and pre-existing signals, because the live bug
   * only appeared once there were more candidates than budget AND the
   * overflow happened to be the lower-precedence detector.
   */
  const DAY = 86_400_000;
  const NOW_LOCAL = new Date("2026-09-16T12:00:00.000Z");
  const at = (daysAgo: number) => new Date(NOW_LOCAL.getTime() - daysAgo * DAY).toISOString();

  const entityRow = (id: string) => ({
    id, type: "person" as const, subtype: null, displayName: id,
    aliases: [] as string[], status: "active" as const, origin: "user" as const, lastMentionedAt: null,
  });

  const activeBaseline = (entityId: string) => ({
    id: `bl-${entityId}`, entityId, eventType: "visit" as const,
    status: "ACTIVE" as const, medianGapDays: 7, madDays: 1, observationCount: 5,
    windowStart: null, windowEnd: null, reasons: [],
    methodVersion: "baseline.v1", inputsHash: `inputs-${entityId}`,
    computedAt: NOW_LOCAL.toISOString(),
  });

  const positive = (entityId: string, daysAgo: number) => ({
    id: `${entityId}-${daysAgo}`, entityId, eventType: "visit" as const,
    occurredAt: at(daysAgo), occurredAtPrecision: "day" as const,
    reportedAt: at(daysAgo), certainty: 0.9, polarity: "positive" as const,
    windowStart: null, windowEnd: null, sourceObservationId: null,
    ingestFingerprint: `fp-${entityId}-${daysAgo}`,
  });

  const absence = (entityId: string) => ({
    id: `abs-${entityId}`, entityId, eventType: "visit" as const,
    occurredAt: at(7), occurredAtPrecision: "day" as const,
    reportedAt: at(0), certainty: 0.9, polarity: "absence" as const,
    windowStart: at(7), windowEnd: at(0), sourceObservationId: null,
    ingestFingerprint: `fp-abs-${entityId}`,
  });

  it("holds for any mix of detectors, entity counts and budget pressure", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 5 }),
        fc.integer({ min: 0, max: 5 }),
        async (absenceCount, cadenceCount) => {
          resetIds();
          const entities = [];
          const events = [];
          const baselines = new Map();

          for (let i = 0; i < absenceCount; i += 1) {
            const id = `abs-entity-${i}`;
            entities.push(entityRow(id));
            events.push(absence(id));
          }
          for (let i = 0; i < cadenceCount; i += 1) {
            const id = `cad-entity-${i}`;
            entities.push(entityRow(id));
            events.push(...[41, 36, 29, 22, 13].map((d) => positive(id, d)));
            baselines.set(`${id}:visit`, activeBaseline(id));
          }

          const store = createStore({
            entities,
            interactionEvents: events,
            baselines,
            profile: {
              id: "u", displayName: null, familyDisplayName: "Dad",
              createdAt: at(200),
            },
          });
          const deps = fakeReconnectDeps({
            store, clock: fixedClock(NOW_LOCAL), familyRender: fakeFamilyRender(),
          });

          const result = await runDetectionSweep(deps, { userId: "u", conversationId: null });

          const keys = result.signals.map((entry) => entry.detectionKey);
          return (
            result.signals.length === result.candidates - result.discarded &&
            new Set(keys).size === keys.length &&
            result.signals.every((entry) => typeof entry.outcome === "string")
          );
        },
      ),
      { numRuns: 60, seed: 20260916 },
    );
  });

  it("never writes more signals in one sweep than the budget allows", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 6 }), async (cadenceCount) => {
        resetIds();
        const entities = [];
        const events = [];
        const baselines = new Map();
        for (let i = 0; i < cadenceCount; i += 1) {
          const id = `cad-${i}`;
          entities.push(entityRow(id));
          events.push(...[41, 36, 29, 22, 13].map((d) => positive(id, d)));
          baselines.set(`${id}:visit`, activeBaseline(id));
        }
        const store = createStore({
          entities, interactionEvents: events, baselines,
          profile: { id: "u", displayName: null, familyDisplayName: "Dad", createdAt: at(200) },
        });
        const deps = fakeReconnectDeps({
          store, clock: fixedClock(NOW_LOCAL), familyRender: fakeFamilyRender(),
        });

        const result = await runDetectionSweep(deps, { userId: "u", conversationId: null });

        const deferred = result.signals.filter((e) => e.outcome === "deferred").length;
        return (
          store.signals.length <= 3 &&
          store.signals.length === Math.min(cadenceCount, 3) &&
          deferred === Math.max(cadenceCount - 3, 0)
        );
      }),
      { numRuns: 30, seed: 20260916 },
    );
  });
});
