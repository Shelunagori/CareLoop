import type { Notifier, NotifierMessage } from "@/server/adapters/notifier";
import type { Db } from "@/server/repositories/db";
import type { ConsentGrantRecord, ConsentGrantsRepo } from "@/server/repositories/consent-grants";
import { sha256Hex } from "@/core/share/text-hash";
import type { FamilyContactRecord, FamilyContactsRepo } from "@/server/repositories/family-contacts";
import type { FamilyRequestRecord, FamilyRequestsRepo } from "@/server/repositories/family-requests";
import type { FamilyResponseRecord, FamilyResponsesRepo } from "@/server/repositories/family-responses";
import type { ClosureRecord, ClosuresRepo } from "@/server/repositories/closures";
import type { ConsentDeps } from "@/server/services/consent";
import type { FamilySendDeps } from "@/server/services/family-send";
import type { FamilyResponseDeps } from "@/server/services/family-response";
import type { ClosureDeps } from "@/server/services/closure";
import type { Clock } from "@/server/adapters/clock";
import { fakeReconnectDeps, type ReconnectStore } from "./detection-fakes";

/**
 * M5 fakes.
 *
 * The two database FUNCTIONS are modelled, not stubbed:
 * `create_authorized_family_request` and `record_family_response` are
 * reimplemented here with the same
 * preconditions, the same ordering and the same idempotent replays as the SQL,
 * so a service test cannot pass against semantics the database does not have.
 * The SQL itself is proved separately, against a real Postgres, in tests/db.
 */
export type M5Store = ReconnectStore & {
  grants: Array<ConsentGrantRecord & { userId: string }>;
  contacts: Array<FamilyContactRecord & { userId: string }>;
  requests: FamilyRequestRecord[];
  responses: FamilyResponseRecord[];
  familyClosures: ClosureRecord[];
  /** Everything handed to the notifier, for exact-byte and privacy assertions. */
  delivered: NotifierMessage[];
};

let seq = 0;
export function resetM5Ids() {
  seq = 0;
}
const nextId = (prefix: string) => `${prefix}-${++seq}`;

export function withM5(store: ReconnectStore): M5Store {
  return Object.assign(store, {
    grants: [],
    contacts: [],
    requests: [],
    responses: [],
    familyClosures: [],
    delivered: [],
  });
}

export function fakeConsentGrants(store: M5Store): ConsentGrantsRepo {
  return {
    async create(input) {
      const existing = store.grants.find((g) => g.opportunityId === input.opportunityId);
      // UNIQUE(opportunity_id): the user consented once.
      if (existing) return { grant: existing, created: false };
      const row = {
        id: nextId("grant"),
        userId: input.userId,
        opportunityId: input.opportunityId,
        scope: input.scope,
        payloadSnapshot: input.payloadSnapshot,
        renderedTextSnapshot: input.renderedTextSnapshot,
        renderedTextHash: input.renderedTextHash,
        grantingMessageId: input.grantingMessageId,
        grantedAt: input.grantedAt,
        expiresAt: input.expiresAt,
        usedAt: null as string | null,
        revokedAt: null as string | null,
      };
      store.grants.push(row);
      return { grant: row, created: true };
    },
    async findByOpportunity(opportunityId) {
      return store.grants.find((g) => g.opportunityId === opportunityId) ?? null;
    },
    async markUsed({ id, now }) {
      const row = store.grants.find((g) => g.id === id);
      if (!row || row.usedAt !== null || row.revokedAt !== null || row.expiresAt <= now) return null;
      row.usedAt = now;
      return row;
    },
    async markRevoked({ id, now }) {
      const row = store.grants.find((g) => g.id === id);
      if (!row || row.usedAt !== null || row.revokedAt !== null) return null;
      row.revokedAt = now;
      return row;
    },
  };
}

export function fakeFamilyContacts(store: M5Store): FamilyContactsRepo {
  return {
    async findForEntity(userId, entityId) {
      return store.contacts.find((c) => c.userId === userId && c.entityId === entityId) ?? null;
    },
    async findForEntityAndChannel(userId, entityId, channel) {
      return (
        store.contacts.find(
          (c) => c.userId === userId && c.entityId === entityId && c.channel === channel,
        ) ?? null
      );
    },
    async findById(id) {
      return store.contacts.find((c) => c.id === id) ?? null;
    },
    async ensure(input) {
      const existing = store.contacts.find(
        (c) =>
          c.userId === input.userId &&
          c.entityId === input.entityId &&
          c.channel === input.channel &&
          c.address === input.address,
      );
      if (existing) return existing;
      const row = { id: nextId("contact"), ...input };
      store.contacts.push(row);
      return row;
    },
  };
}

export function fakeFamilyRequests(store: M5Store): FamilyRequestsRepo {
  const repo: FamilyRequestsRepo = {
    async countOutstandingForUser(_userId, now) {
      return store.requests.filter(
        (r) =>
          (r.status === "pending" || r.status === "delivered") &&
          // Expiry is a fact about the clock; the status column only records
          // it. The real repository filters the same way.
          r.tokenExpiresAt > now,
      ).length;
    },
    async markExpired({ id, now }) {
      const row = store.requests.find((r) => r.id === id);
      if (!row) return null;
      if (row.status !== "pending" && row.status !== "delivered") return null;
      if (row.tokenExpiresAt > now) return null;
      row.status = "expired";
      return row;
    },
    async expireOverdueForUser({ userId, now, limit }) {
      const owned = new Set(
        store.opportunities.filter((o) => o.userId === userId).map((o) => o.id),
      );
      const overdue = store.requests
        .filter(
          (r) =>
            owned.has(r.opportunityId) &&
            (r.status === "pending" || r.status === "delivered") &&
            r.tokenExpiresAt <= now,
        )
        .slice(0, limit);
      for (const row of overdue) row.status = "expired";
      return overdue.length;
    },
    async create(input) {
      // UNIQUE(opportunity_id): one approved opportunity, at most one request.
      const existing = store.requests.find((r) => r.opportunityId === input.opportunityId);
      if (existing) return { request: existing, created: false };
      const row: FamilyRequestRecord = {
        id: nextId("req"),
        opportunityId: input.opportunityId,
        contactId: input.contactId,
        renderedBody: input.renderedBody,
        renderedBodyHash: input.renderedBodyHash,
        payload: input.payload,
        accessTokenHash: input.accessTokenHash,
        tokenExpiresAt: input.tokenExpiresAt,
        status: "pending",
        deliveryAttempts: 0,
        lastDeliveryError: null,
        createdAt: input.createdAt,
        deliveredAt: null,
        openedAt: null,
      };
      store.requests.push(row);
      return { request: row, created: true };
    },
    async findByOpportunity(opportunityId) {
      return store.requests.find((r) => r.opportunityId === opportunityId) ?? null;
    },
    async findById(id) {
      return store.requests.find((r) => r.id === id) ?? null;
    },
    async findByTokenHash(tokenHash) {
      return store.requests.find((r) => r.accessTokenHash === tokenHash) ?? null;
    },
    async markDelivered({ id, now }) {
      const row = store.requests.find((r) => r.id === id);
      // Conditional on `pending`, exactly as the SQL is.
      if (!row || row.status !== "pending") return null;
      row.status = "delivered";
      row.deliveredAt = now;
      row.lastDeliveryError = null;
      return row;
    },
    async recordDeliveryFailure({ id, error }) {
      const row = store.requests.find((r) => r.id === id);
      if (!row) return;
      row.deliveryAttempts += 1;
      row.lastDeliveryError = error.slice(0, 500);
    },
    async markOpened({ id, now }) {
      const row = store.requests.find((r) => r.id === id);
      if (row && row.openedAt === null) row.openedAt = now;
    },
    async rotateToken({ id, accessTokenHash }) {
      const row = store.requests.find((r) => r.id === id);
      // Undelivered only: a delivered link is already in someone's hands.
      if (!row || row.status !== "pending") return null;
      // Same request, same bytes, same original window. New capability only.
      row.accessTokenHash = accessTokenHash;
      return row;
    },
  };
  return repo;
}

export function fakeFamilyResponses(store: M5Store): FamilyResponsesRepo {
  return {
    async findByRequest(requestId) {
      return store.responses.find((r) => r.requestId === requestId) ?? null;
    },
    async findById(id) {
      return store.responses.find((r) => r.id === id) ?? null;
    },
  };
}

export function fakeClosures(store: M5Store): ClosuresRepo {
  return {
    async listUnsurfacedForUser(userId, limit) {
      const owned = new Set(
        store.opportunities.filter((o) => o.userId === userId).map((o) => o.id),
      );
      return store.familyClosures
        .filter((c) => owned.has(c.opportunityId) && c.surfacedAt === null)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .slice(0, limit);
    },
    async findByResponse(responseId) {
      return store.familyClosures.find((c) => c.responseId === responseId) ?? null;
    },
    async findOwnedById(id, userId) {
      // Ownership through the opportunity, exactly as the join does.
      const owned = new Set(
        store.opportunities.filter((o) => o.userId === userId).map((o) => o.id),
      );
      const row = store.familyClosures.find((c) => c.id === id);
      return row && owned.has(row.opportunityId) ? row : null;
    },
    async markSurfaced({ id, messageId, now }) {
      const row = store.familyClosures.find((c) => c.id === id);
      if (!row || row.surfacedAt !== null) return null;
      row.surfacedAt = now;
      row.surfacedMessageId = messageId;
      return row;
    },
  };
}

export type FakeNotifierOptions = { failWith?: Error };

export function fakeNotifier(store: M5Store, options: FakeNotifierOptions = {}): Notifier {
  return {
    async send(message) {
      // Captured BEFORE the failure, so a test can assert what a failing
      // provider was nonetheless handed.
      store.delivered.push(message);
      if (options.failWith) throw options.failWith;
      return {
        channel: message.channel,
        reference: `fake:${message.requestId}`,
        deliveredAt: new Date().toISOString(),
      };
    },
  };
}

/**
 * The database functions, modelled.
 *
 * `db.rpc(name, args)` — same shape, same receiver, same outcomes as the SQL.
 */
export function fakeDb(store: M5Store): Db {
  const client = {
    async rpc(name: string, args: Record<string, unknown>) {
      if (name === "create_authorized_family_request") {
        return { data: createAuthorizedRequest(store, args), error: null };
      }
      if (name === "record_family_response") {
        return { data: recordResponse(store, args as Record<string, string>), error: null };
      }
      throw new Error(`unexpected rpc ${name}`);
    },
  };
  return client as unknown as Db;
}

/**
 * `create_authorized_family_request`, modelled.
 *
 * The one thing this must reproduce faithfully is the ATOMICITY: either the
 * request row exists AND the grant is spent AND the opportunity is consumed,
 * or none of the three happened. A fake that consumed the grant without
 * inserting the row would let a service test pass against a database that
 * cannot behave that way.
 */
function createAuthorizedRequest(store: M5Store, args: Record<string, unknown>) {
  const now = args.p_now as string;
  const opportunity = store.opportunities.find(
    (o) => o.id === args.p_opportunity_id && o.userId === args.p_user_id,
  );
  if (!opportunity) return { outcome: "opportunity_not_found" };

  const grant = store.grants.find((g) => g.opportunityId === args.p_opportunity_id);
  if (!grant) return { outcome: "grant_invalid", reason: "grant_not_found" };

  // Idempotent replay: the obligation exists, so nothing is created or spent.
  const existing = store.requests.find((r) => r.opportunityId === args.p_opportunity_id);
  if (existing) {
    return { outcome: "reloaded", requestId: existing.id, status: existing.status };
  }

  // Recipient binding: the contact must be this user's, and must name the
  // same entity as the opportunity and the consent scope.
  const contact = store.contacts.find(
    (c) => c.id === args.p_contact_id && c.userId === args.p_user_id,
  );
  if (!contact) return { outcome: "contact_not_found" };
  if (contact.entityId !== opportunity.entityId) {
    return { outcome: "recipient_mismatch", reason: "contact_entity_mismatch" };
  }
  const scopeEntity = (grant.scope as { recipientEntityId?: string } | null)?.recipientEntityId;
  if (scopeEntity != null && scopeEntity !== contact.entityId) {
    return { outcome: "recipient_mismatch", reason: "consent_scope_recipient_mismatch" };
  }

  // The whole chain under lock: input == grant snapshot == opportunity.
  if (opportunity.renderedText !== grant.renderedTextSnapshot) {
    return { outcome: "integrity_rejected", reason: "opportunity_rendered_text_mismatch" };
  }
  if (opportunity.renderedTextHash !== grant.renderedTextHash) {
    return { outcome: "integrity_rejected", reason: "opportunity_hash_mismatch" };
  }
  if (JSON.stringify(opportunity.sharePayload) !== JSON.stringify(grant.payloadSnapshot)) {
    return { outcome: "integrity_rejected", reason: "opportunity_payload_mismatch" };
  }

  if (args.p_rendered_body !== grant.renderedTextSnapshot) {
    return { outcome: "integrity_rejected", reason: "rendered_text_mismatch" };
  }
  if (args.p_rendered_body_hash !== grant.renderedTextHash) {
    return { outcome: "integrity_rejected", reason: "rendered_text_hash_mismatch" };
  }
  if (JSON.stringify(args.p_payload) !== JSON.stringify(grant.payloadSnapshot)) {
    return { outcome: "integrity_rejected", reason: "payload_mismatch" };
  }

  if (grant.usedAt !== null) return { outcome: "grant_invalid", reason: "grant_already_used" };
  if (grant.revokedAt !== null) return { outcome: "grant_invalid", reason: "grant_revoked" };
  if (grant.expiresAt <= now) return { outcome: "grant_invalid", reason: "grant_expired" };
  if (opportunity.status !== "approved") {
    return { outcome: "opportunity_not_approved", status: opportunity.status };
  }

  const row: FamilyRequestRecord = {
    id: nextId("req"),
    opportunityId: args.p_opportunity_id as string,
    contactId: args.p_contact_id as string,
    renderedBody: args.p_rendered_body as string,
    renderedBodyHash: args.p_rendered_body_hash as string,
    payload: args.p_payload,
    accessTokenHash: args.p_access_token_hash as string,
    tokenExpiresAt: args.p_token_expires_at as string,
    status: "pending",
    deliveryAttempts: 0,
    lastDeliveryError: null,
    createdAt: now,
    deliveredAt: null,
    openedAt: null,
  };
  // All three, together.
  store.requests.push(row);
  grant.usedAt = now;
  opportunity.status = "consumed";
  opportunity.resolvedAt = now;

  return { outcome: "created", requestId: row.id, status: "pending" };
}

function recordResponse(store: M5Store, args: Record<string, string>) {
  const request = store.requests.find((r) => r.id === args.p_request_id);
  if (!request) return { outcome: "request_not_found" };
  if (request.tokenExpiresAt <= args.p_now) {
    // Persisted, not merely reported: an expired row that still says
    // `delivered` goes on suppressing reconnects.
    if (request.status === "pending" || request.status === "delivered") {
      request.status = "expired";
    }
    return { outcome: "request_expired" };
  }

  const existing = store.responses.find((r) => r.requestId === request.id);
  if (existing) {
    const closure = store.familyClosures.find((c) => c.responseId === existing.id);
    return {
      outcome: "already_answered",
      responseId: existing.id,
      closureId: closure?.id ?? null,
    };
  }
  if (request.status !== "pending" && request.status !== "delivered") {
    return { outcome: "request_not_answerable" };
  }

  const response: FamilyResponseRecord = {
    id: nextId("res"),
    requestId: request.id,
    rawBody: args.p_raw_body,
    parsed: args.p_parsed,
    receivedAt: args.p_now,
  };
  store.responses.push(response);
  const closure: ClosureRecord = {
    id: nextId("closure"),
    opportunityId: request.opportunityId,
    responseId: response.id,
    surfacedMessageId: null,
    surfacedAt: null,
    createdAt: args.p_now,
  };
  store.familyClosures.push(closure);
  request.status = "answered";
  return { outcome: "recorded", responseId: response.id, closureId: closure.id };
}

export function m5Deps(input: {
  store: M5Store;
  clock: Clock;
  notifier?: Notifier;
  /** Override to exercise a deployment's addressing rule, or its absence. */
  resolveContact?: FamilySendDeps["resolveContact"];
}): {
  consent: ConsentDeps;
  send: FamilySendDeps;
  family: FamilyResponseDeps;
  closure: ClosureDeps;
} {
  const { store, clock } = input;
  const base = fakeReconnectDeps({ store, clock });
  const requests = fakeFamilyRequests(store);
  const responses = fakeFamilyResponses(store);
  const db = fakeDb(store);

  return {
    consent: {
      clock,
      opportunities: base.opportunities,
      consentGrants: fakeConsentGrants(store),
      entities: base.entities,
    },
    send: {
      clock,
      db,
      opportunities: base.opportunities,
      consentGrants: fakeConsentGrants(store),
      familyRequests: requests,
      familyContacts: fakeFamilyContacts(store),
      entities: base.entities,
      notifier: input.notifier ?? fakeNotifier(store),
      // The tests exercise the LOCAL addressing rule unless one overrides it,
      // which is what every existing M5 assertion was written against.
      resolveContact:
        input.resolveContact ??
        (async ({ userId, entityId, entityDisplayName }) =>
          fakeFamilyContacts(store).ensure({
            userId,
            entityId,
            channel: "dev",
            // Digested, exactly as the real dev resolver does: an internal id
            // must not travel to a transport, and a fake that leaked one
            // would hide that rule rather than test it.
            address: `dev-inbox:${sha256Hex(`${userId}:${entityId}`).slice(0, 16)}`,
            displayName: entityDisplayName,
          })),
    },
    family: { clock, db, familyRequests: requests, familyResponses: responses },
    closure: {
      clock,
      closures: fakeClosures(store),
      familyResponses: responses,
      familyRequests: requests,
      opportunities: base.opportunities,
      entities: base.entities,
    },
  };
}
