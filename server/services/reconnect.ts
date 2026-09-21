import { detectionSweepConfig } from "@/server/config";
import type { Clock } from "@/server/adapters/clock";
import type { FamilyRenderProvider } from "@/server/adapters/openai/types";
import type { BaselinesRepo } from "@/server/repositories/baselines";
import type { ConversationsRepo } from "@/server/repositories/conversations";
import type { EntitiesRepo, EntityRecord } from "@/server/repositories/entities";
import type { FamilyRequestsReadRepo } from "@/server/repositories/family-requests";
import type {
  InteractionEventRecord,
  InteractionEventsRepo,
} from "@/server/repositories/interaction-events";
import type { OpportunitiesRepo } from "@/server/repositories/opportunities";
import type { ObservationsRepo } from "@/server/repositories/observations";
import type { ProfilesRepo } from "@/server/repositories/profiles";
import type { RelationshipRecord, RelationshipsRepo } from "@/server/repositories/relationships";
import type { SignalRecord, SignalsRepo } from "@/server/repositories/signals";
import { familyRenderPromptV2 } from "@/server/prompts/family-render.v2";
import { baselineConfig } from "@/core/baseline/config";
import { DAY_MS } from "@/core/baseline/day";
import { detectAssertedAbsence } from "@/core/detection/absence";
import { detectCadenceGap } from "@/core/detection/cadence";
import { detectionConfig } from "@/core/detection/config";
import { resolveDetections } from "@/core/detection/detect";
import {
  buildProposal,
  ReconnectProposalSchema,
  type ReconnectProposal,
} from "@/core/detection/proposal";
import {
  evaluateSuppression,
  type SuppressionInput,
  type SuppressionReason,
} from "@/core/detection/suppression";
import {
  CadenceExplanationSchema,
  AbsenceExplanationSchema,
  type DetectorEventType,
  type ReconnectExplanation,
  type SignalCandidate,
} from "@/core/detection/types";
import { z } from "zod";
import { isOpenOpportunity, type OpportunityStatus } from "@/core/consent/status";
import { recoverStatedAbsencePhrase } from "@/core/memory/absence-phrase";
import { ExtractionV1Schema } from "@/core/memory/extraction-contract";
import { buildFallbackText, lastResortText } from "@/core/share/fallback";
import { minimize } from "@/core/share/minimize";
import type { SharePayload } from "@/core/share/payload";
import { sha256Hex } from "@/core/share/text-hash";
import { checkOutboundText } from "@/core/safety/output-guard";
import { fromStored, readBaseline, toBaselineInput } from "./baseline";

/**
 * Detection -> draft orchestration (docs/01 section 1.4, path B).
 *
 * A thin composition layer, on purpose. Every decision it appears to make is
 * actually made by a pure function it calls: whether a signal fires
 * (core/detection), whether it may be acted on (core/detection/suppression),
 * what may leave (core/share/minimize), and whether the rendered sentence is
 * safe (core/safety). What lives HERE is ordering, bounding and persistence.
 *
 * It never runs before the streamed reply. Path B is a conditional branch off
 * the tail of ingestion, not a stage of it — a renderer outage must never cost
 * an older adult their conversation.
 */

const MS_PER_HOUR = 3_600_000;
const ENTITY_SCAN_LIMIT = 400;
const RELATIONSHIP_SCAN_LIMIT = 400;

export type ReconnectDeps = {
  clock: Clock;
  signals: SignalsRepo;
  opportunities: OpportunitiesRepo;
  baselines: BaselinesRepo;
  interactionEvents: InteractionEventsRepo;
  entities: EntitiesRepo;
  relationships: RelationshipsRepo;
  observations: ObservationsRepo;
  profiles: ProfilesRepo;
  familyRequests: FamilyRequestsReadRepo;
  conversations: ConversationsRepo;
  familyRender: FamilyRenderProvider;
};

export type SignalOutcome =
  | "suppressed"
  | "materialized"
  | "reloaded"
  | "signal_not_detected"
  | "signal_not_found"
  | "rejected"
  /** The current stage's work is already done for this evidence. */
  | "replayed_live"
  /** A previous cycle already recorded this refusal, and it still stands. */
  | "replayed_suppressed"
  /** An abandoned `detected` signal was carried through to an opportunity. */
  | "resumed_materialized"
  /** An abandoned `detected` signal was carried through to a suppression. */
  | "resumed_suppressed"
  /** An abandoned `proposed` opportunity was handed back to the drafter. */
  | "resumed_draft"
  /** This sweep's work budget was spent; the next sweep picks it up. */
  | "deferred"
  /** The entity was deleted between detection and persistence. */
  | "entity_missing";

export type SweepSignalResult = {
  /** Null when the candidate was recognised as a replay and nothing written. */
  signalId: string | null;
  detectionKey: string;
  signalType: SignalCandidate["signalType"];
  entityId: string;
  outcome: SignalOutcome;
  suppressionReason?: SuppressionReason;
  opportunityId?: string;
};

export type DraftOutcomeKind =
  | "drafted"
  | "already_drafted"
  | "not_draftable"
  | "invalid_proposal"
  | "expired"
  | "lost_race";

export type DraftResult = {
  opportunityId: string;
  outcome: DraftOutcomeKind;
  /** False on every replay path. This is the no-rerender guarantee. */
  rendererCalled: boolean;
  fallbackUsed: boolean;
  guardFailures: string[];
  renderedTextHash?: string;
};

export type DetectionSweepResult = {
  candidates: number;
  /** Lower-priority candidates dropped before persistence (docs/03 s10.2). */
  discarded: number;
  /** Candidates recognised as an in-flight or already-answered cycle. */
  replayed: number;
  /**
   * One entry per candidate that survived precedence. INVARIANT:
   * `candidates === discarded + signals.length`. A candidate that reaches the
   * processing loop and produces no entry is a silently dropped detection,
   * which is the bug this field exists to make impossible to miss.
   */
  signals: SweepSignalResult[];
  drafts: DraftResult[];
};

/**
 * Read-side validation for a STORED reconnect explanation.
 *
 * Narrower than `SignalExplanationSchema` since M12e: resuming an abandoned
 * cycle means completing a RECONNECT claim, and a wellbeing signal has no
 * such cycle to resume. Parsing with the wide union here would let one
 * through into code that then reaches for `eventType`.
 */
const ReconnectExplanationSchema = z.discriminatedUnion("detector", [
  CadenceExplanationSchema,
  AbsenceExplanationSchema,
]);

function logEvent(record: Record<string, unknown>): void {
  console.log(JSON.stringify(record));
}

function isDetectorEventType(value: string): value is DetectorEventType {
  return value === "visit" || value === "call";
}

/** Reads the stable identity out of a stored explanation, or null. */
export function readDetectionKey(signal: SignalRecord): string | null {
  const explanation = signal.explanation;
  if (typeof explanation !== "object" || explanation === null) return null;
  const key = (explanation as { detectionKey?: unknown }).detectionKey;
  return typeof key === "string" && key.length > 0 ? key : null;
}

function readConversationId(signal: SignalRecord): string | null {
  const explanation = signal.explanation;
  if (typeof explanation !== "object" || explanation === null) return null;
  const id = (explanation as { conversationId?: unknown }).conversationId;
  return typeof id === "string" && id.length > 0 ? id : null;
}

function toDate(value: string | null): Date | null {
  if (value === null) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms);
}

/**
 * When this account's history begins.
 *
 * Deliberately the earliest EVIDENCE the account holds, not the auth row's
 * creation timestamp. The cold-start rule exists because a brand-new account
 * cannot have a meaningful cadence, and the M6 demo fixture is the proof that
 * "new row" and "no history" are different things: it replays fourteen weeks
 * of real utterances through the production pipeline against a Clock port, so
 * its profile row is minutes old while its evidence is months deep. Reading
 * the profile's created_at alone would silence the demo the architecture is
 * built to produce — and, worse, would silence any real user whose history was
 * imported rather than accumulated.
 */
async function resolveAccountStart(deps: ReconnectDeps, userId: string, now: Date): Promise<Date> {
  const [profile, firstConversation, firstEvent] = await Promise.all([
    deps.profiles.find(userId),
    deps.conversations.earliestStartedAt(userId),
    deps.interactionEvents.earliestOccurredAt(userId),
  ]);

  const candidates = [
    toDate(profile?.createdAt ?? null),
    toDate(firstConversation),
    toDate(firstEvent),
  ].filter((date): date is Date => date !== null);

  if (candidates.length === 0) return now;
  return candidates.reduce((a, b) => (a.getTime() <= b.getTime() ? a : b));
}

type SuppressionSnapshot = {
  accountStartedAt: Date;
  /** Opportunity id + status per signal, for classifying an existing cycle. */
  opportunityBySignal: Map<string, { id: string; status: OpportunityStatus }>;
  outstandingFamilyRequestCount: number;
  openEntityIds: string[];
  offeredForEntity: Map<string, Date[]>;
  declinedForEntity: Map<string, Date[]>;
  offeredForAccount: Date[];
  offersInConversation: number;
};

async function loadSuppressionSnapshot(
  deps: ReconnectDeps,
  input: { userId: string; conversationId: string | null; now: Date; signals: readonly SignalRecord[] },
): Promise<SuppressionSnapshot> {
  const since = new Date(
    input.now.getTime() - detectionSweepConfig.opportunityHistoryLookbackDays * DAY_MS,
  ).toISOString();

  const [accountStartedAt, outstanding, open, recent, presentable] = await Promise.all([
    resolveAccountStart(deps, input.userId, input.now),
    deps.familyRequests.countOutstandingForUser(input.userId, input.now.toISOString()),
    deps.opportunities.listOpenForUser(input.userId, detectionSweepConfig.openOpportunityLimit),
    deps.opportunities.listRecentForUser(
      input.userId,
      since,
      detectionSweepConfig.opportunityHistoryLimit,
    ),
    deps.entities.listPresentableForUser(input.userId, ENTITY_SCAN_LIMIT),
  ]);

  /**
   * HIDING SOMETHING MUST NOT COST THE PERSON ANYTHING (M12e.3).
   *
   * `maxOffersPerWeek` is a global cap: three offers across the whole
   * account. An opportunity belonging to a development-seeded entity is
   * never shown to anyone, so letting it consume one of those three would
   * mean a test row quietly suppressing a real family nudge — a cooldown
   * spent for a card nobody saw.
   *
   * Only the ACCOUNT-WIDE tallies are filtered. A dev entity's own
   * cooldowns are left exactly as they are: they constrain that entity and
   * nothing else, and that entity is invisible either way.
   */
  const presentableIds = new Set(presentable.map((entity) => entity.id));

  const opportunityBySignal = new Map<string, { id: string; status: OpportunityStatus }>();
  for (const opportunity of recent) {
    opportunityBySignal.set(opportunity.signalId, {
      id: opportunity.id,
      status: opportunity.status,
    });
  }

  const offeredForEntity = new Map<string, Date[]>();
  const declinedForEntity = new Map<string, Date[]>();
  const offeredForAccount: Date[] = [];

  const conversationBySignal = new Map<string, string | null>(
    input.signals.map((signal) => [signal.id, readConversationId(signal)]),
  );
  let offersInConversation = 0;

  for (const opportunity of recent) {
    const offeredAt = toDate(opportunity.offeredAt);
    if (offeredAt !== null) {
      if (presentableIds.has(opportunity.entityId)) offeredForAccount.push(offeredAt);
      const forEntity = offeredForEntity.get(opportunity.entityId) ?? [];
      forEntity.push(offeredAt);
      offeredForEntity.set(opportunity.entityId, forEntity);
      // "One offer per conversation" is an OFFER-time rule, and M4 never
      // reaches `offered` — so this count is structurally zero here and the
      // rule only bites in M5. It is wired and unit-tested now rather than
      // later because a pacing rule added after the flow it paces is a rule
      // nobody notices is missing.
      if (
        presentableIds.has(opportunity.entityId) &&
        input.conversationId !== null &&
        conversationBySignal.get(opportunity.signalId) === input.conversationId
      ) {
        offersInConversation += 1;
      }
    }

    if (opportunity.status === "declined") {
      const resolvedAt = toDate(opportunity.resolvedAt);
      if (resolvedAt !== null) {
        const forEntity = declinedForEntity.get(opportunity.entityId) ?? [];
        forEntity.push(resolvedAt);
        declinedForEntity.set(opportunity.entityId, forEntity);
      }
    }
  }

  return {
    accountStartedAt,
    opportunityBySignal,
    outstandingFamilyRequestCount: outstanding,
    openEntityIds: open.map((opportunity) => opportunity.entityId),
    offeredForEntity,
    declinedForEntity,
    offeredForAccount,
    offersInConversation,
  };
}

function suppressionInputFor(
  snapshot: SuppressionSnapshot,
  candidate: SignalCandidate,
  /** Entities that became open earlier in THIS sweep. */
  openedThisSweep: ReadonlySet<string>,
): SuppressionInput {
  const openCount =
    snapshot.openEntityIds.filter((id) => id === candidate.entityId).length +
    (openedThisSweep.has(candidate.entityId) ? 1 : 0);

  return {
    signalType: candidate.signalType,
    entityId: candidate.entityId,
    accountStartedAt: snapshot.accountStartedAt,
    openOpportunityCountForEntity: openCount,
    offeredAtForEntity: snapshot.offeredForEntity.get(candidate.entityId) ?? [],
    declinedAtForEntity: snapshot.declinedForEntity.get(candidate.entityId) ?? [],
    outstandingFamilyRequestCount: snapshot.outstandingFamilyRequestCount,
    offersInConversation: snapshot.offersInConversation,
    offeredAtForAccount: snapshot.offeredForAccount,
  };
}

function toAbsenceInput(row: InteractionEventRecord, eventType: DetectorEventType) {
  return {
    id: row.id,
    entityId: row.entityId,
    eventType,
    polarity: row.polarity,
    windowStart: toDate(row.windowStart),
    windowEnd: toDate(row.windowEnd),
    reportedAt: new Date(row.reportedAt),
    certainty: row.certainty,
  };
}

/**
 * The person's own words for an absence window, or null.
 *
 * Read from the immutable observation the event was derived from - no new
 * column, because the extraction contract already records the PHRASE rather
 * than a date the model computed (docs/02 section 6). A missing observation, a
 * payload that no longer parses, or an ambiguous match all yield null, and
 * null is a perfectly good answer: the proposal then carries the resolved
 * window and makes no claim about wording.
 */
async function recoverPhrase(
  deps: ReconnectDeps,
  input: { userId: string; row: InteractionEventRecord },
): Promise<string | null> {
  const { row } = input;
  if (row.sourceObservationId === null || row.windowStart === null || row.windowEnd === null) {
    return null;
  }
  if (!isDetectorEventType(row.eventType)) return null;

  const observation = await deps.observations.findById(input.userId, row.sourceObservationId);
  if (!observation) return null;

  const parsed = ExtractionV1Schema.safeParse(observation.payload);
  if (!parsed.success) return null;

  return recoverStatedAbsencePhrase({
    extraction: parsed.data,
    eventType: row.eventType,
    windowStart: new Date(row.windowStart),
    windowEnd: new Date(row.windowEnd),
    reportedAt: new Date(row.reportedAt),
  });
}

/**
 * What state, if any, the evidence behind a candidate is already in.
 *
 * The replay policy is deliberately NOT "have we ever seen this key". The
 * detector's identity says WHAT EVIDENCE caused a detection; it says nothing
 * about whether that detection was ever finished. Both halves matter, and
 * collapsing them is how durable work gets silently abandoned:
 *
 *   NONE              never seen -> detect normally.
 *
 *   DETECTED_PENDING  a signal row exists but nothing was materialized. This
 *                     is UNFINISHED WORK, not a running cycle: the row is
 *                     written before the RPC, so a reclaimed runtime leaves
 *                     exactly this. RESUME the same signal - never write a
 *                     second one to retry.
 *
 *   PROPOSED_PENDING  materialized, opportunity exists, draft never persisted.
 *                     Also unfinished. RESUME drafting that same opportunity.
 *
 *   LIVE_COMPLETE     materialized with a drafted/offered/approved
 *                     opportunity. The current stage's work is done; a
 *                     duplicate would be nagging. Write nothing.
 *
 *   RESOLVED          every cycle ended (expired, declined, consumed,
 *                     suppressed). Re-evaluate the current world; a fresh
 *                     signal is allowed if the condition still holds.
 *
 * An opportunity we cannot see in the bounded history read is treated as
 * LIVE_COMPLETE: failing closed costs a missed nudge, failing open costs a
 * duplicate one. (A `proposed` opportunity outside that window is still
 * recovered, by the open-opportunity draft scan at the end of the sweep.)
 */
export type CycleState =
  | { kind: "NONE" }
  | { kind: "DETECTED_PENDING"; signal: SignalRecord }
  | { kind: "PROPOSED_PENDING"; signal: SignalRecord; opportunityId: string }
  | { kind: "LIVE_COMPLETE" }
  | { kind: "RESOLVED" };

export function classifyCycle(
  detectionKey: string,
  signals: readonly SignalRecord[],
  opportunities: ReadonlyMap<string, { id: string; status: OpportunityStatus }>,
): CycleState {
  // Newest first, so the most recent unfinished cycle is the one resumed.
  const prior = [...signals]
    .filter((signal) => readDetectionKey(signal) === detectionKey)
    .sort((a, b) => b.detectedAt.localeCompare(a.detectedAt));
  if (prior.length === 0) return { kind: "NONE" };

  // Unfinished states first: resuming beats both replaying and re-detecting.
  for (const signal of prior) {
    if (signal.status === "detected") return { kind: "DETECTED_PENDING", signal };
  }
  for (const signal of prior) {
    if (signal.status !== "materialized") continue;
    const opportunity = opportunities.get(signal.id);
    if (opportunity?.status === "proposed") {
      return { kind: "PROPOSED_PENDING", signal, opportunityId: opportunity.id };
    }
  }
  for (const signal of prior) {
    if (signal.status !== "materialized") continue;
    const opportunity = opportunities.get(signal.id);
    if (opportunity === undefined || isOpenOpportunity(opportunity.status)) {
      return { kind: "LIVE_COMPLETE" };
    }
  }
  return { kind: "RESOLVED" };
}

async function collectCandidates(
  deps: ReconnectDeps,
  input: { userId: string; conversationId: string | null; now: Date },
): Promise<SignalCandidate[]> {
  const { userId, conversationId, now } = input;
  const candidates: SignalCandidate[] = [];

  // --- explicit absence assertions ------------------------------------------
  // Bounded by a recent REPORTED window, which is also the re-entry path: an
  // absence persisted just before a runtime was reclaimed stays eligible until
  // the window passes, so the next ordinary request finds it.
  const absences = await deps.interactionEvents.listRecentAbsences({
    userId,
    sinceReportedIso: new Date(
      now.getTime() - detectionSweepConfig.absenceLookbackDays * DAY_MS,
    ).toISOString(),
    limit: detectionSweepConfig.maxAbsenceEventsPerSweep,
  });

  for (const row of absences) {
    if (!isDetectorEventType(row.eventType)) continue;
    const stored = await deps.baselines.find({
      userId,
      entityId: row.entityId,
      eventType: row.eventType,
    });
    /**
     * SUPERSESSION (M12e.1). One bounded read per absence row: has the
     * person since reported being in contact with this entity, about the
     * period they said they were not? If so the detector returns nothing —
     * which is what stops the same fourteen-day-old assertion being
     * re-minted into a reviewer-visible offer every sweep.
     */
    const latest =
      row.windowStart === null
        ? null
        : await deps.interactionEvents.latestPositiveSince({
            userId,
            entityId: row.entityId,
            sinceOccurredIso: row.windowStart,
          });

    const candidate = detectAssertedAbsence({
      event: {
        ...toAbsenceInput(row, row.eventType),
        statedPhrase: await recoverPhrase(deps, { userId, row }),
      },
      latestPositive:
        latest === null
          ? null
          : { occurredAtIso: latest.occurredAt, reportedAtIso: latest.reportedAt },
      // Enrichment only. A missing baseline is not a reason to stay silent
      // about something the person told us outright.
      baseline: stored ? fromStored(stored) : null,
      now,
      conversationId,
    });
    if (candidate) candidates.push(candidate);
  }

  // --- cadence gaps ---------------------------------------------------------
  // The sweep is what makes a gap noticeable on a turn where NOTHING was
  // written: "weekly visits, last one 13 days ago, today's chat was about the
  // garden" still reaches the detector, because the trigger is a request, not
  // a new event.
  const stored = await deps.baselines.listForUser(
    userId,
    detectionSweepConfig.maxSeriesPerSweep * 4,
  );
  const series = stored
    .filter((row) => row.status === "ACTIVE" && isDetectorEventType(row.eventType))
    .slice(0, detectionSweepConfig.maxSeriesPerSweep);

  const sinceIso = new Date(now.getTime() - baselineConfig.lookbackDays * DAY_MS).toISOString();

  for (const row of series) {
    if (!isDetectorEventType(row.eventType)) continue;
    const eventType = row.eventType;
    // Read through the lazy-staleness path: a stored ACTIVE row older than the
    // staleness window may no longer be ACTIVE once evidence has aged out, and
    // firing from a rhythm the evidence no longer supports is exactly the
    // rumour `inputs_hash` exists to prevent.
    const read = await readBaseline(deps, { userId, entityId: row.entityId, eventType });
    const events = await deps.interactionEvents.listForSeries({
      userId,
      entityId: row.entityId,
      eventType,
      sinceIso,
    });

    const candidate = detectCadenceGap({
      entityId: row.entityId,
      eventType,
      baseline: read.baseline,
      events: events.map(toBaselineInput),
      now,
      conversationId,
    });
    if (candidate) candidates.push(candidate);
  }

  return candidates;
}

/**
 * Related entities safe to name outbound (docs/03 section 15).
 *
 * Confirmed edges only, and only `pet` edges to an entity that really is a
 * pet. Naming another PERSON in a message to a family member is a different
 * and much larger consent question than naming the dog, so V1 does not do it.
 * If the relationship is not safe to assert, it is omitted rather than
 * guessed — an LLM is never asked who should be mentioned.
 */
function relatedNames(input: {
  entityId: string;
  entities: readonly EntityRecord[];
  relationships: readonly RelationshipRecord[];
}): string[] {
  const byId = new Map(input.entities.map((entity) => [entity.id, entity]));

  return input.relationships
    .filter(
      (edge) =>
        edge.status === "confirmed" &&
        edge.fromEntityId === input.entityId &&
        edge.kind === "pet" &&
        byId.get(edge.toEntityId)?.type === "pet",
    )
    .map((edge) => byId.get(edge.toEntityId)?.displayName)
    .filter((name): name is string => typeof name === "string" && name.length > 0)
    .sort()
    .slice(0, detectionSweepConfig.maxRelatedEntities);
}

export async function runDetectionSweep(
  deps: ReconnectDeps,
  input: { userId: string; conversationId: string | null },
): Promise<DetectionSweepResult> {
  const now = deps.clock.now();
  const { userId } = input;

  const candidates = await collectCandidates(deps, { ...input, now });
  const { selected, discarded } = resolveDetections(candidates);

  for (const drop of discarded) {
    logEvent({
      event: "detection.discarded",
      detector: drop.candidate.signalType,
      entityId: drop.candidate.entityId,
      reason: drop.reason,
      winner: drop.winnerDetectionKey,
    });
  }

  // Replay: evidence that has already produced a signal is not new news.
  const signalsSince = new Date(
    now.getTime() - detectionSweepConfig.signalHistoryLookbackDays * DAY_MS,
  ).toISOString();
  const recentSignals = await deps.signals.listRecent(
    userId,
    signalsSince,
    detectionSweepConfig.signalHistoryLimit,
  );
  const snapshot = await loadSuppressionSnapshot(deps, {
    userId,
    conversationId: input.conversationId,
    now,
    signals: recentSignals,
  });

  const results: SweepSignalResult[] = [];
  const openedThisSweep = new Set<string>();
  const proposedIds: string[] = [];
  let processed = 0;
  let replayed = 0;

  // Loaded once per sweep, not once per candidate. Both are already bounded,
  // and a user's cast of characters is small by nature.
  const [entities, relationships] =
    selected.length === 0
      ? [[], []]
      : await Promise.all([
          // The names in here become the proposal, the draft and the card.
          // A development-seeded entity gets no signal carried through to an
          // opportunity at all (M12e.3) — `entity_missing`, which is exactly
          // what it is from the presentation side.
          deps.entities.listPresentableForUser(userId, ENTITY_SCAN_LIMIT),
          deps.relationships.listForUser(userId, RELATIONSHIP_SCAN_LIMIT),
        ]);

  /**
   * Carry ONE signal - freshly detected or recovered - through to an
   * opportunity. Shared by both paths on purpose: a resumed cycle must reach
   * exactly the same outcomes, with exactly the same audit rows, as one that
   * never crashed.
   */
  const carryToOpportunity = async (ctx: {
    signalId: string;
    explanation: ReconnectExplanation;
    candidate: SignalCandidate;
    entityName: string;
    baselineRow: Awaited<ReturnType<BaselinesRepo["find"]>>;
    resumed: boolean;
  }): Promise<void> => {
    const { candidate } = ctx;
    const base = {
      signalId: ctx.signalId,
      detectionKey: candidate.detectionKey,
      signalType: candidate.signalType,
      entityId: candidate.entityId,
    };

    const proposal: ReconnectProposal = buildProposal({
      // A resumed cycle is completed with ITS OWN stored explanation, not a
      // freshly computed one, so `opportunity.proposal` always corresponds to
      // the `signal.explanation` it hangs off. If the world has moved far
      // enough for that to matter, the opportunity's own 24h expiry retires it
      // and the detector re-arms with current numbers.
      explanation: ctx.explanation,
      entityName: ctx.entityName,
      alsoMention: relatedNames({ entityId: candidate.entityId, entities, relationships }),
      baseline: ctx.baselineRow ? fromStored(ctx.baselineRow) : null,
    });

    const materialized = await deps.opportunities.materialize({
      signalId: ctx.signalId,
      userId,
      entityId: candidate.entityId,
      proposal,
      expiresAt: new Date(
        now.getTime() + detectionConfig.opportunityOfferabilityHours * MS_PER_HOUR,
      ).toISOString(),
      now: now.toISOString(),
    });

    if (materialized.outcome === "blocked_open_opportunity") {
      // The transaction saw something the snapshot could not: another open
      // opportunity for this entity. Recorded with the same reason code the
      // pure policy would have used, so the audit row reads the same either
      // way - including when this signal was written by a process that died.
      await deps.signals.markSuppressed(ctx.signalId, "open_opportunity_exists");
      logEvent({
        event: "detection.suppressed",
        signalId: ctx.signalId,
        entityId: candidate.entityId,
        reason: "open_opportunity_exists",
        resumed: ctx.resumed,
      });
      results.push({
        ...base,
        outcome: ctx.resumed ? "resumed_suppressed" : "suppressed",
        suppressionReason: "open_opportunity_exists",
      });
      return;
    }

    if (
      materialized.outcome === "signal_entity_mismatch" ||
      materialized.outcome === "entity_not_found" ||
      materialized.outcome === "invalid_expiry"
    ) {
      // The arguments did not describe a consistent, owned row. That is a bug
      // in this service, not a product state, so it is logged loudly and the
      // signal is LEFT `detected` for investigation and retry - never
      // disguised as a suppression reason that would read like a policy
      // decision a person made.
      console.error(
        JSON.stringify({
          event: "reconnect.materialize_rejected",
          signalId: ctx.signalId,
          entityId: candidate.entityId,
          outcome: materialized.outcome,
          resumed: ctx.resumed,
        }),
      );
      results.push({ ...base, outcome: "rejected" });
      return;
    }

    if (materialized.opportunityId !== null) {
      openedThisSweep.add(candidate.entityId);
      proposedIds.push(materialized.opportunityId);
    }

    logEvent({
      event: "reconnect.materialized",
      signalId: ctx.signalId,
      entityId: candidate.entityId,
      opportunityId: materialized.opportunityId,
      outcome: materialized.outcome,
      resumed: ctx.resumed,
    });

    results.push({
      ...base,
      outcome: ctx.resumed ? "resumed_materialized" : (materialized.outcome as SignalOutcome),
      opportunityId: materialized.opportunityId ?? undefined,
    });
  };

  /**
   * Classification is pure - it reads the signals and opportunities already
   * loaded above - so every candidate is classified BEFORE any budget is
   * spent. That ordering is what lets the sweep report on candidates it did
   * not get to, instead of losing them.
   */
  const classified = selected.map((candidate) => ({
    candidate,
    cycle: classifyCycle(candidate.detectionKey, recentSignals, snapshot.opportunityBySignal),
  }));

  /**
   * UNFINISHED WORK FIRST.
   *
   * `selected` arrives sorted by detector precedence, which puts every
   * absence candidate ahead of every cadence one. Taking the first N of that
   * list means a cadence gap is starved whenever enough absence assertions are
   * present - including a cadence signal that is sitting `detected` and
   * waiting to be resumed. Recovery of durable work is never less important
   * than a fresh detection, so it is ordered first, and detector precedence
   * only breaks ties within a group.
   */
  const RECOVERY_FIRST: Record<CycleState["kind"], number> = {
    DETECTED_PENDING: 0,
    PROPOSED_PENDING: 0,
    NONE: 1,
    RESOLVED: 1,
    LIVE_COMPLETE: 2,
  };
  const ordered = classified
    .map((entry, index) => ({ entry, index }))
    .sort(
      (a, b) =>
        RECOVERY_FIRST[a.entry.cycle.kind] - RECOVERY_FIRST[b.entry.cycle.kind] ||
        a.index - b.index,
    )
    .map(({ entry }) => entry);

  /**
   * The per-sweep work budget, spent only on work that actually WRITES: a
   * signal insert, a suppression transition, or a materialization call.
   * Replays, deferrals and rejections are free.
   *
   * That distinction is load-bearing. Charging a rejection would let a handful
   * of permanently unreadable rows drain the budget on every sweep and starve
   * everything behind them forever - the durable version of the same bug.
   */
  const spendBudget = (): boolean => {
    if (processed >= detectionSweepConfig.maxSignalsPerSweep) return false;
    processed += 1;
    return true;
  };

  for (const { candidate, cycle } of ordered) {
    const base = {
      detectionKey: candidate.detectionKey,
      signalType: candidate.signalType,
      entityId: candidate.entityId,
    };

    // The current stage's work is already done. A second one would be nagging.
    if (cycle.kind === "LIVE_COMPLETE") {
      replayed += 1;
      results.push({ ...base, signalId: null, outcome: "replayed_live" });
      continue;
    }

    // Materialized, but the draft never landed. Hand that SAME opportunity
    // back to the drafter rather than detecting anything again. Free: it
    // writes no signal and calls no RPC; drafting has its own budget.
    if (cycle.kind === "PROPOSED_PENDING") {
      if (!proposedIds.includes(cycle.opportunityId)) proposedIds.push(cycle.opportunityId);
      logEvent({
        event: "detection.resumed",
        stage: "proposed",
        signalId: cycle.signal.id,
        opportunityId: cycle.opportunityId,
        entityId: candidate.entityId,
      });
      results.push({
        ...base,
        signalId: cycle.signal.id,
        outcome: "resumed_draft",
        opportunityId: cycle.opportunityId,
      });
      continue;
    }

    const entity = entities.find((row) => row.id === candidate.entityId);
    if (!entity) {
      // An entity deleted between detection and persistence has no name to put
      // in a proposal, and inventing one is not an option. Recorded rather
      // than skipped: "the entity went away" is an answer, silence is not.
      logEvent({
        event: "detection.entity_missing",
        entityId: candidate.entityId,
        detectionKey: candidate.detectionKey,
      });
      results.push({ ...base, signalId: null, outcome: "entity_missing" });
      continue;
    }

    const baselineRow = await deps.baselines.find({
      userId,
      entityId: candidate.entityId,
      eventType: candidate.eventType,
    });

    // Suppression is EVALUATED before anything is written, and persisted
    // after. The reason for the ordering is audit quality, not policy: when a
    // previous cycle already recorded this refusal and it still stands, a
    // second identical row answers no new question and would accumulate one
    // per turn for as long as a cooldown runs. One row per suppression
    // episode, not one per sweep.
    const decision = evaluateSuppression(
      suppressionInputFor(snapshot, candidate, openedThisSweep),
      now,
    );

    // A signal row exists but nothing was materialized: the row is committed
    // BEFORE the RPC, so a reclaimed runtime leaves exactly this. It is
    // unfinished durable work, not a completed cycle, and it is resumed -
    // never retried by writing a second signal.
    if (cycle.kind === "DETECTED_PENDING") {
      const existing = cycle.signal;

      logEvent({
        event: "detection.resumed",
        stage: "detected",
        signalId: existing.id,
        entityId: candidate.entityId,
        detectionKey: candidate.detectionKey,
      });

      if (!decision.allowed) {
        if (!spendBudget()) {
          results.push({ ...base, signalId: existing.id, outcome: "deferred" });
          continue;
        }
        // The world moved on while the work was abandoned. The SAME signal
        // records the refusal - markSuppressed is conditional on the row still
        // being `detected`, so a concurrent resume cannot double-write it.
        await deps.signals.markSuppressed(existing.id, decision.reason);
        logEvent({
          event: "detection.suppressed",
          signalId: existing.id,
          entityId: candidate.entityId,
          reason: decision.reason,
          detail: decision.detail,
          resumed: true,
        });
        results.push({
          ...base,
          signalId: existing.id,
          outcome: "resumed_suppressed",
          suppressionReason: decision.reason,
        });
        continue;
      }

      const parsed = ReconnectExplanationSchema.safeParse(existing.explanation);
      if (!parsed.success) {
        // Cannot complete a cycle whose evidence no longer parses. Left
        // `detected` and logged, for the same reason an integrity failure is.
        // Free, deliberately: a stuck row must not consume the budget that
        // everything behind it is waiting for.
        console.error(
          JSON.stringify({
            event: "detection.unreadable_explanation",
            signalId: existing.id,
            issues: parsed.error.issues.length,
          }),
        );
        results.push({ ...base, signalId: existing.id, outcome: "rejected" });
        continue;
      }

      if (!spendBudget()) {
        results.push({ ...base, signalId: existing.id, outcome: "deferred" });
        continue;
      }

      await carryToOpportunity({
        signalId: existing.id,
        explanation: parsed.data,
        candidate,
        entityName: entity.displayName,
        baselineRow,
        resumed: true,
      });
      continue;
    }

    // NONE or RESOLVED from here: a genuinely new cycle.
    if (!decision.allowed && cycle.kind === "RESOLVED") {
      replayed += 1;
      results.push({
        ...base,
        signalId: null,
        outcome: "replayed_suppressed",
        suppressionReason: decision.reason,
      });
      continue;
    }

    if (!spendBudget()) {
      // Nothing durable was written for this candidate, and the detector is
      // deterministic, so the next ordinary request recomputes it and picks it
      // up. Deferred work is never lost work - but it is always reported.
      results.push({ ...base, signalId: null, outcome: "deferred" });
      continue;
    }

    const signal = await deps.signals.insert({
      userId,
      entityId: candidate.entityId,
      baselineId: baselineRow?.id ?? null,
      signalType: candidate.signalType,
      explanation: candidate.explanation,
      detectedAt: now.toISOString(),
      // `score` is deliberately left null. An opaque wellbeing or risk number
      // is the first step towards the monitoring product this design refuses
      // to be (docs/06 section 19); the explanation carries the evidence
      // instead, and it is readable.
    });

    logEvent({
      event: "detection.signal",
      signalId: signal.id,
      detector: candidate.signalType,
      entityId: candidate.entityId,
      eventType: candidate.eventType,
      detectionKey: candidate.detectionKey,
      // A fresh cycle on evidence that already had one. The explanation was
      // recomputed from the current world, not copied from the earlier signal.
      rearmed: cycle.kind === "RESOLVED",
    });

    if (!decision.allowed) {
      await deps.signals.markSuppressed(signal.id, decision.reason);
      logEvent({
        event: "detection.suppressed",
        signalId: signal.id,
        entityId: candidate.entityId,
        reason: decision.reason,
        detail: decision.detail,
      });
      results.push({
        ...base,
        signalId: signal.id,
        outcome: "suppressed",
        suppressionReason: decision.reason,
      });
      continue;
    }

    await carryToOpportunity({
      signalId: signal.id,
      explanation: candidate.explanation,
      candidate,
      entityName: entity.displayName,
      baselineRow,
      resumed: false,
    });
  }


  // Drafting. Anything this sweep materialized, then anything a previous
  // runtime left at `proposed` — the second half is the re-entry path for a
  // materialization whose draft never ran.
  const draftTargets = [...proposedIds];
  if (draftTargets.length < detectionSweepConfig.maxDraftsPerSweep) {
    const open = await deps.opportunities.listOpenForUser(
      userId,
      detectionSweepConfig.openOpportunityLimit,
    );
    for (const opportunity of open) {
      if (opportunity.status === "proposed" && !draftTargets.includes(opportunity.id)) {
        draftTargets.push(opportunity.id);
      }
    }
  }

  const drafts: DraftResult[] = [];
  for (const opportunityId of draftTargets.slice(0, detectionSweepConfig.maxDraftsPerSweep)) {
    drafts.push(await draftOpportunity(deps, { userId, opportunityId }));
  }

  return {
    candidates: candidates.length,
    discarded: discarded.length,
    replayed,
    signals: results,
    drafts,
  };
}

/**
 * Thrown to leave the render block without calling a provider. A control
 * signal, never logged as a failure — see `modelMayRender`.
 */
class SkipRenderer extends Error {
  readonly name = "SkipRenderer";
}

/** The fallback, re-guarded. Sanitized labels make this total in practice. */
function guardedFallback(payload: SharePayload): string {
  const template = buildFallbackText(payload);
  const verdict = checkOutboundText(template, {
    question: payload.question,
    aboutEntityName: payload.aboutEntityName,
  });
  if (verdict.accepted) return template;
  return lastResortText(payload.question);
}

/**
 * proposed -> drafted (docs/04 section 11.2).
 *
 * Everything that can generate happens here, once, BEFORE the user is ever
 * asked. That ordering is the consent guarantee: the person approves a
 * finished artefact, and there is no model call between approval and send.
 */
export async function draftOpportunity(
  deps: ReconnectDeps,
  input: { userId: string; opportunityId: string },
): Promise<DraftResult> {
  const opportunity = await deps.opportunities.findById(input.opportunityId);
  const base = {
    opportunityId: input.opportunityId,
    rendererCalled: false,
    fallbackUsed: false,
    guardFailures: [] as string[],
  };

  if (!opportunity) return { ...base, outcome: "not_draftable" };

  // Already drafted: return the STORED bytes and call nothing. M5's consent
  // attaches to these exact bytes, so a second render would silently move the
  // thing the user is about to approve.
  if (opportunity.status !== "proposed") {
    return {
      ...base,
      outcome: opportunity.status === "drafted" ? "already_drafted" : "not_draftable",
      renderedTextHash: opportunity.renderedTextHash ?? undefined,
    };
  }

  const now = deps.clock.now();
  if (Date.parse(opportunity.expiresAt) <= now.getTime()) {
    await deps.opportunities.markExpired(opportunity.id, now.toISOString());
    return { ...base, outcome: "expired" };
  }

  const parsed = ReconnectProposalSchema.safeParse(opportunity.proposal);
  if (!parsed.success) {
    logEvent({
      event: "reconnect.invalid_proposal",
      opportunityId: opportunity.id,
      issues: parsed.error.issues.length,
    });
    return { ...base, outcome: "invalid_proposal" };
  }

  const profile = await deps.profiles.find(input.userId);
  const payload = minimize({
    proposal: parsed.data,
    profile: { familyDisplayName: profile?.familyDisplayName ?? null },
  });

  /**
   * A WELLBEING SHARE IS NEVER MODEL-RENDERED (M12e).
   *
   * Not "rendered and then guarded" — not rendered. This is the one topic
   * where the message is about the person's own body, and a sentence a model
   * wrote about that is a sentence nobody can account for. The deterministic
   * text in `buildFallbackText` is the whole renderer, it interpolates one
   * already-sanitized label, and it is still put through the same outbound
   * guard as everything else.
   *
   * `rendererCalled: false` on this path is therefore a fact worth logging
   * rather than an omission: "no model wrote this" is checkable in the log.
   */
  const modelMayRender = payload.topic !== "wellbeing";

  // ONE attempt. A failure is not retried with a repair prompt: repairing
  // unsafe output with the same kind of component that produced it is a retry,
  // not a safety mechanism.
  let candidate: string | null = null;
  let rendererCalled = false;
  try {
    if (!modelMayRender) throw new SkipRenderer();
    rendererCalled = true;
    const rendered = await deps.familyRender.render({
      promptRef: familyRenderPromptV2.ref,
      payload,
    });
    candidate = rendered.text;
  } catch (error) {
    if (!(error instanceof SkipRenderer)) {
      logEvent({
        event: "reconnect.render_failed",
        opportunityId: opportunity.id,
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
    }
  }

  const verdict =
    candidate === null
      ? null
      : checkOutboundText(candidate, {
          question: payload.question,
          // The companion, so the guard can check the visit RELATION rather
          // than merely the vocabulary.
          aboutEntityName: payload.aboutEntityName,
        });
  const guardFailures = verdict && !verdict.accepted ? verdict.failures.map((f) => f.code) : [];
  const accepted = verdict !== null && verdict.accepted;
  const text = accepted ? verdict.text : guardedFallback(payload);

  logEvent({
    event: "reconnect.guard",
    opportunityId: opportunity.id,
    promptRef: familyRenderPromptV2.ref,
    rendererCalled,
    guardOutcome: accepted
      ? "accepted"
      : !modelMayRender
        ? "renderer_not_permitted"
        : candidate === null
          ? "render_unavailable"
          : "rejected",
    guardFailures,
    fallbackUsed: !accepted,
  });

  // Expiry is re-checked AFTER the model call: the opportunity may have
  // expired while it was in flight, and a fresh draft on an expired
  // opportunity would be an offerable claim the clock has already retired.
  // `expires_at` is never extended (docs/04 section 11.5).
  const afterRender = deps.clock.now();
  if (Date.parse(opportunity.expiresAt) <= afterRender.getTime()) {
    await deps.opportunities.markExpired(opportunity.id, afterRender.toISOString());
    return { ...base, rendererCalled, fallbackUsed: !accepted, guardFailures, outcome: "expired" };
  }

  const renderedTextHash = sha256Hex(text);
  const saved = await deps.opportunities.saveDraft({
    id: opportunity.id,
    sharePayload: payload,
    renderedText: text,
    renderedTextHash,
    now: afterRender.toISOString(),
  });

  if (!saved) {
    // Lost the conditional update. Somebody else's bytes are stored, and
    // theirs are the ones consent will attach to — so this attempt reloads
    // rather than overwriting.
    const reloaded = await deps.opportunities.findById(opportunity.id);
    return {
      ...base,
      rendererCalled,
      fallbackUsed: !accepted,
      guardFailures,
      outcome: reloaded?.status === "drafted" ? "lost_race" : "not_draftable",
      renderedTextHash: reloaded?.renderedTextHash ?? undefined,
    };
  }

  logEvent({
    event: "reconnect.drafted",
    opportunityId: opportunity.id,
    entityId: opportunity.entityId,
    promptRef: familyRenderPromptV2.ref,
    fallbackUsed: !accepted,
    // The hash, never the text. The draft is user-derived content.
    renderedTextHash,
  });

  return {
    ...base,
    rendererCalled,
    fallbackUsed: !accepted,
    guardFailures,
    outcome: "drafted",
    renderedTextHash,
  };
}
