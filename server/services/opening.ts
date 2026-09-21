import "server-only";
import type { Clock } from "@/server/adapters/clock";
import type { EntitiesRepo } from "@/server/repositories/entities";
import type { InteractionEventsRepo } from "@/server/repositories/interaction-events";
import type { MessagesRepo } from "@/server/repositories/messages";
import type { OpportunitiesRepo } from "@/server/repositories/opportunities";
import type { FamilyRequestsRepo } from "@/server/repositories/family-requests";
import { DAY_MS } from "@/core/baseline/day";
import { chatConfig } from "@/server/config";
import { currentSitting } from "@/core/detection/presentation";
import { presentableName } from "@/core/memory/provenance";
import {
  decideOpening,
  renderOpening,
  OPENING_CONFIG,
  type OpeningCandidate,
} from "@/core/opening/opening";

/**
 * The proactive opening, assembled (M12d).
 *
 * This layer does the reads and hands a literal object to the pure decision
 * in `core/opening/opening.ts`. It adds no rule of its own; every "no" it
 * can produce is one of that function's named reasons.
 *
 * THE FACT SOURCE IS ONE TABLE. `interaction_events`, positive polarity,
 * filtered in the query. Those rows exist because the person said the thing
 * happened and the extractor resolved it to an entity — the same evidence
 * the cadence baseline is computed from. Episodes, baselines, absences and
 * family replies are all deliberately out of reach from here.
 */
export type OpeningDeps = {
  clock: Clock;
  interactionEvents: Pick<InteractionEventsRepo, "listRecentPositive">;
  entities: Pick<EntitiesRepo, "listPresentableForUser">;
  messages: Pick<MessagesRepo, "listRecent">;
  opportunities: Pick<OpportunitiesRepo, "listOpenForUser">;
  familyRequests: Pick<FamilyRequestsRepo, "countOutstandingForUser">;
};

const ENTITY_SCAN_LIMIT = 400;
const EVENT_SCAN_LIMIT = 20;
const OPPORTUNITY_SCAN_LIMIT = 5;

function logEvent(record: Record<string, unknown>): void {
  console.log(JSON.stringify(record));
}

export async function loadOpeningLine(
  deps: OpeningDeps,
  input: { userId: string; conversationId: string | null },
): Promise<string | null> {
  const now = deps.clock.now();
  const since = new Date(
    now.getTime() - (OPENING_CONFIG.maxAgeDays + 1) * DAY_MS,
  ).toISOString();

  const [events, entities, openOpportunities, outstandingRequests, recent] = await Promise.all([
    deps.interactionEvents.listRecentPositive({
      userId: input.userId,
      sinceOccurredIso: since,
      limit: EVENT_SCAN_LIMIT,
    }),
    deps.entities.listPresentableForUser(input.userId, ENTITY_SCAN_LIMIT),
    deps.opportunities.listOpenForUser(input.userId, OPPORTUNITY_SCAN_LIMIT),
    deps.familyRequests.countOutstandingForUser(input.userId, now.toISOString()),
    input.conversationId
      ? deps.messages.listRecent(input.conversationId, chatConfig.recentTurnLimit)
      : Promise.resolve([]),
  ]);

  // Provenance first, then the label rule — `presentableEntity` does both,
  // and an entity that fails either simply has no name here, so the
  // candidate filter below drops it (M12e.3).
  const nameById = new Map(
    entities.flatMap((entity) => {
      const name = presentableName(entity);
      return name === null ? [] : [[entity.id, name] as const];
    }),
  );

  const candidates: OpeningCandidate[] = events.flatMap((event) => {
    if (event.eventType !== "visit" && event.eventType !== "call") return [];
    // The same presentation rule the reconnect card uses. An opening that
    // said "How did the visit with M4Absence1789574558 go?" would be the
    // previous milestone's bug with a friendlier voice.
    const entityName = nameById.get(event.entityId) ?? null;
    if (entityName === null) return [];
    return [
      {
        entityId: event.entityId,
        entityName,
        eventType: event.eventType,
        occurredAt: new Date(event.occurredAt),
        occurredAtPrecision: event.occurredAtPrecision,
        certainty: event.certainty,
        polarity: event.polarity,
      },
    ];
  });

  const decision = decideOpening({
    candidates,
    now,
    messagesInSitting: currentSitting(recent).messagesInSitting,
    openConsentFlow: openOpportunities.length > 0 || outstandingRequests > 0,
    // The composer is the browser's; a draft is decided there. The server's
    // job is to say whether there is anything TO open with.
    unresolvedDraft: false,
    alreadySurfaced: false,
  });

  if (!decision.open) {
    logEvent({ event: "opening.withheld", reason: decision.reason });
    return null;
  }

  logEvent({
    event: "opening.offered",
    entityId: decision.entityId,
    eventType: decision.eventType,
    daysAgo: decision.daysAgo,
  });
  return renderOpening(decision);
}
