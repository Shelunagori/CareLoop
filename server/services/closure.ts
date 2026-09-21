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
import { presentableName } from "@/core/memory/provenance";

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

  // The closure sentence is read aloud to the person, so the same
  // provenance rule applies here as to the card (M12e.3).
  const entities = await deps.entities.listPresentableForUser(userId, ENTITY_SCAN_LIMIT);
  const entityName = presentableName(entities.find((entity) => entity.id === opportunity.entityId));
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

/**
 * AWAITING A REPLY — the state that had no voice.
 *
 * A closure tells the companion that a reply ARRIVED. Nothing told it that one
 * had not. Absence of a closure marker is silence, and silence is exactly what
 * a language model fills in: asked "have you heard from him at all?", with a
 * message it knows was sent and nothing saying otherwise, it produced a reply
 * that never happened and told a lonely man his son had been in touch.
 *
 * So the negative is now a stated fact rather than an inference from missing
 * context. It is derived from rows, not from the model: a DELIVERED request,
 * inside its token window, with no response row against it.
 *
 * The response row is checked as well as the status column. `status` moving to
 * `answered` is the RPC's record of a response, and the record and the fact
 * should never disagree - but if they ever did, the one that must win is the
 * one that can invent a reply, and that is the status column.
 */
export type AwaitingFamilyReply = {
  entityName: string;
  familyRequestId: string;
};

export async function loadAwaitingFamilyReply(
  deps: ClosureDeps,
  input: { userId: string },
): Promise<AwaitingFamilyReply | null> {
  const now = deps.clock.now().toISOString();
  const request = await deps.familyRequests.findLatestAwaitingForUser(input.userId, now);
  if (!request) return null;

  // Belt to the status column's braces.
  const response = await deps.familyResponses.findByRequest(request.id);
  if (response) return null;

  const opportunity = await deps.opportunities.findOwnedById(request.opportunityId, input.userId);
  if (!opportunity) return null;

  const entities = await deps.entities.listPresentableForUser(input.userId, ENTITY_SCAN_LIMIT);
  const entityName = presentableName(entities.find((entity) => entity.id === opportunity.entityId));
  // No name, no marker. "A message was sent to someone" is not worth saying,
  // and a placeholder is the kind of thing that ends up read aloud.
  if (entityName === null) return null;

  return { entityName, familyRequestId: request.id };
}
