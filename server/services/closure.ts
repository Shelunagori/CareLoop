import type { Clock } from "@/server/adapters/clock";
import { familyConfig } from "@/server/config";
import type { ClosureRecord, ClosuresRepo } from "@/server/repositories/closures";
import type { EntitiesRepo } from "@/server/repositories/entities";
import type { FamilyRequestsRepo } from "@/server/repositories/family-requests";
import type { FamilyResponsesRepo } from "@/server/repositories/family-responses";
import type { OpportunitiesRepo } from "@/server/repositories/opportunities";
import {
  closureMarker,
  renderClosureSentence,
  type ClosureFact,
  type ClosureMarker,
} from "@/core/family/closure";
import { FamilyReplySchema } from "@/core/family/response";
import { SharePayloadSchema } from "@/core/share/payload";

/**
 * Closing the loop back to the older adult (docs/04 section 12.3).
 *
 * An unacknowledged promise - "I'll ask John" - is the most damaging thing
 * this product can do, so a closure is a row with a `surfaced_at`, not
 * something the model is trusted to remember. That column is also what stops
 * the companion telling the same news twice.
 *
 * What reaches conversational context is a MARKER, not the family member's
 * words: `{ type, entityName, response, timeframe }`. The sentence itself is
 * deterministic and factual - it reports what was answered and asserts nothing
 * about what it means.
 */
export type ClosureDeps = {
  clock: Clock;
  closures: ClosuresRepo;
  familyResponses: FamilyResponsesRepo;
  familyRequests: FamilyRequestsRepo;
  opportunities: OpportunitiesRepo;
  entities: EntitiesRepo;
};

export type PendingClosure = {
  closureId: string;
  fact: ClosureFact;
  marker: ClosureMarker;
  /** The factual sentence the companion may say. */
  sentence: string;
};

const ENTITY_SCAN_LIMIT = 400;

export async function loadPendingClosure(
  deps: ClosureDeps,
  input: { userId: string },
): Promise<PendingClosure | null> {
  const pending = await deps.closures.listUnsurfacedForUser(
    input.userId,
    familyConfig.maxClosuresPerTurn,
  );
  const closure = pending[0];
  if (!closure) return null;
  return describeClosure(deps, closure, input.userId);
}

/**
 * The same closure, addressed by id (M8).
 *
 * Reading a closure aloud has to produce the sentence the person was shown,
 * and the only way to guarantee that is to DERIVE it again from the same rows
 * through the same renderer, rather than letting a caller hand over a string.
 * Scoped through the opportunity, so a closure belonging to someone else is
 * indistinguishable from one that does not exist.
 */
export async function loadClosureById(
  deps: ClosureDeps,
  input: { closureId: string; userId: string },
): Promise<PendingClosure | null> {
  const closure = await deps.closures.findOwnedById(input.closureId, input.userId);
  if (!closure) return null;
  return describeClosure(deps, closure, input.userId);
}

async function describeClosure(
  deps: ClosureDeps,
  closure: ClosureRecord,
  userId: string,
): Promise<PendingClosure | null> {
  const response = await deps.familyResponses.findById(closure.responseId);
  if (!response) return null;

  const reply = FamilyReplySchema.safeParse(response.parsed);
  if (!reply.success) return null;

  const opportunity = await deps.opportunities.findOwnedById(closure.opportunityId, userId);
  if (!opportunity) return null;

  const request = await deps.familyRequests.findByOpportunity(opportunity.id);
  if (!request) return null;

  const payload = SharePayloadSchema.safeParse(request.payload);
  if (!payload.success) return null;

  const entities = await deps.entities.listForUser(userId, ENTITY_SCAN_LIMIT);
  const entityName =
    entities.find((entity) => entity.id === opportunity.entityId)?.displayName ?? null;
  if (entityName === null) return null;

  const fact: ClosureFact = {
    opportunityId: opportunity.id,
    familyRequestId: request.id,
    responseId: response.id,
    entityName,
    topic: payload.data.topic,
    responseIntent: reply.data.intent,
    ...(reply.data.timeframe ? { timeframe: reply.data.timeframe } : {}),
    createdAt: closure.createdAt,
  };

  return {
    closureId: closure.id,
    fact,
    marker: closureMarker(fact),
    sentence: renderClosureSentence(fact),
  };
}

/** Told once. The row records that it was, so it is never told again. */
export async function acknowledgeClosure(
  deps: ClosureDeps,
  input: { closureId: string; messageId: string | null },
): Promise<boolean> {
  const marked = await deps.closures.markSurfaced({
    id: input.closureId,
    messageId: input.messageId,
    now: deps.clock.now().toISOString(),
  });
  return marked !== null;
}
