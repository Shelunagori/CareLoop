import type { Clock } from "@/server/adapters/clock";
import type { ClosuresRepo } from "@/server/repositories/closures";
import type { ConsentGrantsRepo } from "@/server/repositories/consent-grants";
import type { FamilyRequestsRepo } from "@/server/repositories/family-requests";
import type { FamilyResponsesRepo } from "@/server/repositories/family-responses";
import type { OpportunitiesRepo } from "@/server/repositories/opportunities";
import type { EntitiesRepo } from "@/server/repositories/entities";
import { OPPORTUNITY_STATUSES, type OpportunityStatus } from "@/core/consent/status";
import { grantState, type GrantState } from "@/core/consent/validation";
import { deepEqual } from "@/core/consent/deep-equal";
import { sha256Hex } from "@/core/share/text-hash";
import { tokenHashPrefix } from "@/core/family/token";

/**
 * The consent half of the development inspector.
 *
 * It exists to answer one question in front of someone: "prove that what was
 * shown is what was approved is what was sent." So it RECOMPUTES the hashes
 * and re-runs the comparisons rather than restating stored values - a chain of
 * custody you cannot check is a claim, not evidence.
 *
 * It never shows a token. The plaintext exists only in the family member's
 * link; what appears here is an eight-character hash prefix, which is enough
 * to correlate a row with a log line and useless as a credential.
 */
export type ConsentDebugDeps = {
  clock: Clock;
  opportunities: OpportunitiesRepo;
  consentGrants: ConsentGrantsRepo;
  familyRequests: FamilyRequestsRepo;
  familyResponses: FamilyResponsesRepo;
  closures: ClosuresRepo;
  entities: EntitiesRepo;
};

export type ConsentDebugRow = {
  opportunityId: string;
  entityName: string;
  status: OpportunityStatus;
  offeredAt: string | null;
  resolvedAt: string | null;
  expiresAt: string;
  expired: boolean;
  renderedText: string | null;
  renderedTextHash: string | null;
  grant: {
    id: string;
    state: GrantState;
    grantedAt: string;
    expiresAt: string;
    usedAt: string | null;
    revokedAt: string | null;
    scope: unknown;
    /** sha256(snapshot) recomputed here. */
    snapshotHashRecomputes: boolean;
    /** The approved bytes still equal the opportunity's stored bytes. */
    matchesOpportunityText: boolean;
    matchesOpportunityPayload: boolean;
  } | null;
  request: {
    id: string;
    status: string;
    createdAt: string;
    deliveredAt: string | null;
    openedAt: string | null;
    tokenExpiresAt: string;
    tokenExpired: boolean;
    deliveryAttempts: number;
    lastDeliveryError: string | null;
    /** Never the token. A prefix of its hash, for log correlation only. */
    tokenHashPrefix: string;
    /** The outbound bytes still equal the approved bytes. */
    bodyMatchesGrant: boolean;
  } | null;
  response: { id: string; receivedAt: string; parsed: unknown } | null;
  closure: { id: string; createdAt: string; surfacedAt: string | null } | null;
};

const ENTITY_SCAN_LIMIT = 400;
const OPPORTUNITY_LIMIT = 20;

export async function loadConsentDebug(
  deps: ConsentDebugDeps,
  input: { userId: string; now: Date },
): Promise<ConsentDebugRow[]> {
  const [opportunities, entities] = await Promise.all([
    deps.opportunities.listByStatusForUser(
      input.userId,
      OPPORTUNITY_STATUSES,
      OPPORTUNITY_LIMIT,
    ),
    deps.entities.listForUser(input.userId, ENTITY_SCAN_LIMIT),
  ]);
  const nameById = new Map(entities.map((entity) => [entity.id, entity.displayName]));

  const rows: ConsentDebugRow[] = [];
  for (const opportunity of opportunities) {
    const grant = await deps.consentGrants.findByOpportunity(opportunity.id);
    const request = await deps.familyRequests.findByOpportunity(opportunity.id);
    const response = request ? await deps.familyResponses.findByRequest(request.id) : null;
    const closure = response ? await deps.closures.findByResponse(response.id) : null;

    rows.push({
      opportunityId: opportunity.id,
      entityName: nameById.get(opportunity.entityId) ?? "(deleted entity)",
      status: opportunity.status,
      offeredAt: opportunity.offeredAt,
      resolvedAt: opportunity.resolvedAt,
      expiresAt: opportunity.expiresAt,
      expired: Date.parse(opportunity.expiresAt) <= input.now.getTime(),
      renderedText: opportunity.renderedText,
      renderedTextHash: opportunity.renderedTextHash,
      grant: grant
        ? {
            id: grant.id,
            state: grantState(grant, input.now),
            grantedAt: grant.grantedAt,
            expiresAt: grant.expiresAt,
            usedAt: grant.usedAt,
            revokedAt: grant.revokedAt,
            scope: grant.scope,
            snapshotHashRecomputes:
              sha256Hex(grant.renderedTextSnapshot) === grant.renderedTextHash,
            matchesOpportunityText: grant.renderedTextSnapshot === opportunity.renderedText,
            matchesOpportunityPayload: deepEqual(
              grant.payloadSnapshot,
              opportunity.sharePayload,
            ),
          }
        : null,
      request: request
        ? {
            id: request.id,
            status: request.status,
            createdAt: request.createdAt,
            deliveredAt: request.deliveredAt,
            openedAt: request.openedAt,
            tokenExpiresAt: request.tokenExpiresAt,
            tokenExpired: Date.parse(request.tokenExpiresAt) <= input.now.getTime(),
            deliveryAttempts: request.deliveryAttempts,
            lastDeliveryError: request.lastDeliveryError,
            tokenHashPrefix: tokenHashPrefix(request.accessTokenHash),
            bodyMatchesGrant: grant ? request.renderedBody === grant.renderedTextSnapshot : false,
          }
        : null,
      response: response
        ? { id: response.id, receivedAt: response.receivedAt, parsed: response.parsed }
        : null,
      closure: closure
        ? { id: closure.id, createdAt: closure.createdAt, surfacedAt: closure.surfacedAt }
        : null,
    });
  }

  return rows;
}
