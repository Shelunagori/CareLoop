import type { Database, Json } from "@/server/db/types.generated";
import type { Db } from "./db";

/**
 * M4 reads family_requests and never writes to them — creating one is M5's
 * single transaction (E3). The one question detection needs to ask is whether
 * a loop is already in flight with the family, because starting another while
 * John has been asked something and not answered is the nagging the
 * suppression rules exist to prevent (docs/03 section 10.3).
 *
 * family_requests carries no user_id; ownership is reached through the
 * opportunity, exactly as the RLS policy does (docs/02 section 4.1).
 */
export type FamilyRequestStatus = Database["public"]["Enums"]["family_request_status"];

export type FamilyRequestRecord = {
  id: string;
  opportunityId: string;
  contactId: string;
  /** Copied byte-for-byte from the consent grant. Never generated here. */
  renderedBody: string;
  renderedBodyHash: string;
  payload: unknown;
  accessTokenHash: string;
  tokenExpiresAt: string;
  status: FamilyRequestStatus;
  deliveryAttempts: number;
  lastDeliveryError: string | null;
  createdAt: string;
  deliveredAt: string | null;
  openedAt: string | null;
};

export type FamilyRequestsRepo = {
  /**
   * Outstanding = asked and not yet answered. `now` is required and not
   * optional: a request whose token window has closed must stop counting the
   * instant it closes, whether or not the lazy transition has persisted yet.
   * A stale row that kept counting would suppress reconnects for that person
   * indefinitely, which is the failure this argument exists to prevent.
   */
  countOutstandingForUser(userId: string, now: string): Promise<number>;
  /**
   * The most recent DELIVERED request this user is still waiting on.
   *
   * `delivered` specifically, not `pending`: the companion is about to be told
   * a message "was sent", and for a pending row that is not yet true. And not
   * `answered` either - `record_family_response` moves the row there the
   * instant a reply lands, so this cannot return a request that has one.
   *
   * Expiry is checked against the CLOCK rather than the status column, for the
   * same reason `countOutstandingForUser` does it: the lazy transition may not
   * have run, and a closed window must stop being "waiting" the moment it
   * closes.
   */
  findLatestAwaitingForUser(userId: string, now: string): Promise<FamilyRequestRecord | null>;
  /**
   * The lazy lifecycle transition: pending | delivered -> expired, for
   * requests whose token window has closed. Bounded, idempotent, and safe to
   * run from any request path.
   */
  expireOverdueForUser(input: { userId: string; now: string; limit: number }): Promise<number>;
  /** The same transition for ONE request already in hand. */
  markExpired(input: { id: string; now: string }): Promise<FamilyRequestRecord | null>;
  /**
   * Idempotent on UNIQUE(opportunity_id): one approved opportunity yields at
   * most one request, whatever a retry does. A loser reloads the winner, so a
   * repeated send never mints a second token or a second set of bytes.
   */
  create(input: {
    opportunityId: string;
    contactId: string;
    renderedBody: string;
    renderedBodyHash: string;
    payload: Json;
    accessTokenHash: string;
    tokenExpiresAt: string;
    createdAt: string;
  }): Promise<{ request: FamilyRequestRecord; created: boolean }>;
  findByOpportunity(opportunityId: string): Promise<FamilyRequestRecord | null>;
  findById(id: string): Promise<FamilyRequestRecord | null>;
  /** Lookup is by HASH; the plaintext never reaches the database. */
  findByTokenHash(tokenHash: string): Promise<FamilyRequestRecord | null>;
  /**
   * Transport succeeded. Conditional on `pending` so a duplicate callback
   * cannot re-stamp `delivered_at` or move an already-answered request back.
   */
  markDelivered(input: { id: string; now: string }): Promise<FamilyRequestRecord | null>;
  recordDeliveryFailure(input: { id: string; error: string }): Promise<void>;
  markOpened(input: { id: string; now: string }): Promise<void>;
  /**
   * Same request, same bytes, same consent, same original expiry - a new
   * token only. Used when delivery never completed and the plaintext is gone.
   *
   * PENDING ONLY. Once a request is `delivered` the link is already in the
   * family member's hands, and rotating the hash would silently break a
   * capability someone was handed. Rotation is recovery for a token that was
   * never successfully issued, not a way to re-key a live one.
   */
  rotateToken(input: {
    id: string;
    accessTokenHash: string;
  }): Promise<FamilyRequestRecord | null>;
};


const SELECT =
  "id, opportunity_id, contact_id, rendered_body, rendered_body_hash, payload, access_token_hash, token_expires_at, status, delivery_attempts, last_delivery_error, created_at, delivered_at, opened_at";

type Row = {
  id: string;
  opportunity_id: string;
  contact_id: string;
  rendered_body: string;
  rendered_body_hash: string;
  payload: Json;
  access_token_hash: string;
  token_expires_at: string;
  status: FamilyRequestStatus;
  delivery_attempts: number;
  last_delivery_error: string | null;
  created_at: string;
  delivered_at: string | null;
  opened_at: string | null;
};

const toRecord = (row: Row): FamilyRequestRecord => ({
  id: row.id,
  opportunityId: row.opportunity_id,
  contactId: row.contact_id,
  renderedBody: row.rendered_body,
  renderedBodyHash: row.rendered_body_hash,
  payload: row.payload,
  accessTokenHash: row.access_token_hash,
  tokenExpiresAt: row.token_expires_at,
  status: row.status,
  deliveryAttempts: row.delivery_attempts,
  lastDeliveryError: row.last_delivery_error,
  createdAt: row.created_at,
  deliveredAt: row.delivered_at,
  openedAt: row.opened_at,
});

export function familyRequestsRepo(db: Db): FamilyRequestsRepo {
  return {
    async countOutstandingForUser(userId, now) {
      const { count, error } = await db
        .from("family_requests")
        .select("id, reconnect_opportunities!inner(user_id)", {
          count: "exact",
          head: true,
        })
        // Outstanding = created or delivered but not yet answered, and not
        // expired. `expired` is terminal on both sides and must not silence
        // the companion forever.
        .in("status", ["pending", "delivered"])
        // Defensive against the lazy transition not having run yet: expiry is
        // a fact about the CLOCK, and the status column is only its record.
        .gt("token_expires_at", now)
        .eq("reconnect_opportunities.user_id", userId);
      if (error) throw new Error(`countOutstandingFamilyRequests failed: ${error.message}`);
      return count ?? 0;
    },

    async findLatestAwaitingForUser(userId, now) {
      const { data, error } = await db
        .from("family_requests")
        .select(`${SELECT}, reconnect_opportunities!inner(user_id)`)
        .eq("status", "delivered")
        .gt("token_expires_at", now)
        .eq("reconnect_opportunities.user_id", userId)
        .order("created_at", { ascending: false })
        .limit(1);
      if (error) throw new Error(`findLatestAwaitingFamilyRequest failed: ${error.message}`);
      const row = data?.[0];
      return row ? toRecord(row as Row) : null;
    },

    async markExpired({ id, now }) {
      const { data, error } = await db
        .from("family_requests")
        .update({ status: "expired" })
        .eq("id", id)
        .in("status", ["pending", "delivered"])
        // The clock is the authority. Never expire a request that is still
        // inside its window, whatever the caller believed.
        .lte("token_expires_at", now)
        .select(SELECT)
        .maybeSingle();
      if (error) throw new Error(`markFamilyRequestExpired failed: ${error.message}`);
      return data ? toRecord(data) : null;
    },

    async expireOverdueForUser({ userId, now, limit }) {
      // Two steps because family_requests carries no user_id: ownership is
      // reached through the opportunity, and PostgREST cannot filter an UPDATE
      // through a join. The select is bounded; the update is by id.
      const { data: overdue, error: findError } = await db
        .from("family_requests")
        .select("id, reconnect_opportunities!inner(user_id)")
        .in("status", ["pending", "delivered"])
        .lte("token_expires_at", now)
        .eq("reconnect_opportunities.user_id", userId)
        .limit(limit);
      if (findError) throw new Error(`findOverdueFamilyRequests failed: ${findError.message}`);
      if (!overdue || overdue.length === 0) return 0;

      const ids = overdue.map((row) => row.id);
      const { data, error } = await db
        .from("family_requests")
        .update({ status: "expired" })
        .in("id", ids)
        // Re-stated on the write: between the select and here another path may
        // have answered one of them, and an answered request is terminal.
        .in("status", ["pending", "delivered"])
        .lte("token_expires_at", now)
        .select("id");
      if (error) throw new Error(`expireOverdueFamilyRequests failed: ${error.message}`);
      return data?.length ?? 0;
    },

    async create(input) {
      const existing = await this.findByOpportunity(input.opportunityId);
      if (existing) return { request: existing, created: false };

      const { data, error } = await db
        .from("family_requests")
        .insert({
          opportunity_id: input.opportunityId,
          contact_id: input.contactId,
          rendered_body: input.renderedBody,
          rendered_body_hash: input.renderedBodyHash,
          payload: input.payload,
          access_token_hash: input.accessTokenHash,
          token_expires_at: input.tokenExpiresAt,
          created_at: input.createdAt,
          status: "pending",
        })
        .select(SELECT)
        .maybeSingle();

      if (error) {
        const reloaded = await this.findByOpportunity(input.opportunityId);
        if (reloaded) return { request: reloaded, created: false };
        throw new Error(`createFamilyRequest failed: ${error.message}`);
      }
      if (!data) throw new Error("createFamilyRequest returned no row");
      return { request: toRecord(data), created: true };
    },

    async findByOpportunity(opportunityId) {
      const { data, error } = await db
        .from("family_requests")
        .select(SELECT)
        .eq("opportunity_id", opportunityId)
        .maybeSingle();
      if (error) throw new Error(`findFamilyRequest failed: ${error.message}`);
      return data ? toRecord(data) : null;
    },

    async findById(id) {
      const { data, error } = await db
        .from("family_requests")
        .select(SELECT)
        .eq("id", id)
        .maybeSingle();
      if (error) throw new Error(`findFamilyRequestById failed: ${error.message}`);
      return data ? toRecord(data) : null;
    },

    async findByTokenHash(tokenHash) {
      const { data, error } = await db
        .from("family_requests")
        .select(SELECT)
        .eq("access_token_hash", tokenHash)
        .maybeSingle();
      if (error) throw new Error(`findFamilyRequestByToken failed: ${error.message}`);
      return data ? toRecord(data) : null;
    },

    async markDelivered({ id, now }) {
      const { data, error } = await db
        .from("family_requests")
        .update({ status: "delivered", delivered_at: now, last_delivery_error: null })
        .eq("id", id)
        .eq("status", "pending")
        .select(SELECT)
        .maybeSingle();
      if (error) throw new Error(`markFamilyRequestDelivered failed: ${error.message}`);
      return data ? toRecord(data) : null;
    },

    async recordDeliveryFailure({ id, error: message }) {
      const current = await this.findById(id);
      const { error } = await db
        .from("family_requests")
        .update({
          // Truncated: an error string is diagnostics, not a place for content.
          last_delivery_error: message.slice(0, 500),
          delivery_attempts: (current?.deliveryAttempts ?? 0) + 1,
        })
        .eq("id", id);
      if (error) throw new Error(`recordDeliveryFailure failed: ${error.message}`);
    },

    async markOpened({ id, now }) {
      const { error } = await db
        .from("family_requests")
        .update({ opened_at: now })
        .eq("id", id)
        .is("opened_at", null);
      if (error) throw new Error(`markFamilyRequestOpened failed: ${error.message}`);
    },

    async rotateToken({ id, accessTokenHash }) {
      const { data, error } = await db
        .from("family_requests")
        .update({ access_token_hash: accessTokenHash })
        .eq("id", id)
        // Undelivered only. A delivered, answered or expired request keeps the
        // token it had: the first because its link is already out there, the
        // other two because rotating one would revive a dead capability.
        .eq("status", "pending")
        .select(SELECT)
        .maybeSingle();
      if (error) throw new Error(`rotateFamilyToken failed: ${error.message}`);
      return data ? toRecord(data) : null;
    },
  };
}

/**
 * The slice M4 detection needs: one question, "is a loop already in flight
 * with the family?". Narrowing it keeps the detection service from depending
 * on M5's write surface, so a change to sending cannot ripple into detection.
 */
export type FamilyRequestsReadRepo = Pick<FamilyRequestsRepo, "countOutstandingForUser">;
