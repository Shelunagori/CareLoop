import { beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./pg-harness";

/**
 * The two M5 database functions, against a real Postgres with the real
 * migrations applied.
 *
 * Both exist for the same reason: a set of state changes that must land
 * together or not at all. Split across PostgREST calls they are separate
 * transactions with windows between them, and a reclaimed serverless runtime
 * in any window leaves half-state — consent spent with nothing delivered, or a
 * closure with no response behind it.
 */
const ALICE = "11111111-1111-1111-1111-111111111111";
const BOB = "22222222-2222-2222-2222-222222222222";
const JOHN = "aaaaaaaa-0000-0000-0000-000000000001";
const MARY = "aaaaaaaa-0000-0000-0000-000000000002";
const MARY_BOB = "aaaaaaaa-0000-0000-0000-000000000003";

const NOW = "2026-09-16T12:00:00.000Z";
const TEXT = "Hi John — are you visiting this weekend?";
const PAYLOAD = `'{"fromDisplayName":"Dad","topic":"visit","question":"ask_if_visiting"}'::jsonb`;

let h: Harness;
let seq = 0;

type Setup = { opportunityId: string; grantId: string; contactId: string };
type Chain = Setup & { requestId: string };

/**
 * A fully approved opportunity with a live grant and a contact — and NO
 * family request. Creating that row is the transaction under test (E3), so a
 * fixture must not pre-create it.
 */
async function approvedChain(options: { user?: string } = {}): Promise<Setup> {
  const user = options.user ?? ALICE;
  seq += 1;
  const signal = (
    await h.query<{ id: string }>(
      `insert into public.signals (user_id, entity_id, signal_type, explanation)
       values ($1, $2, 'cadence_gap', '{"detector":"test"}'::jsonb) returning id`,
      [user, JOHN],
    )
  )[0].id;

  const opportunityId = (
    await h.query<{ id: string }>(
      `insert into public.reconnect_opportunities
         (user_id, signal_id, entity_id, proposal, share_payload, rendered_text,
          rendered_text_hash, status, expires_at)
       values ($1, $2, $3, '{}'::jsonb, ${PAYLOAD}, $4, 'hash-1', 'approved',
               now() + interval '1 day')
       returning id`,
      [user, signal, JOHN, TEXT],
    )
  )[0].id;

  const grantId = (
    await h.query<{ id: string }>(
      `insert into public.consent_grants
         (user_id, opportunity_id, scope, payload_snapshot, rendered_text_snapshot,
          rendered_text_hash, granted_at, expires_at)
       values ($1, $2, '{}'::jsonb, ${PAYLOAD}, $3, 'hash-1', $4::timestamptz,
               $4::timestamptz + interval '72 hours')
       returning id`,
      [user, opportunityId, TEXT, NOW],
    )
  )[0].id;

  const contactId = (
    await h.query<{ id: string }>(
      `insert into public.family_contacts (user_id, entity_id, channel, address)
       values ($1, $2, 'dev', $3) returning id`,
      [user, JOHN, `dev-inbox:${seq}`],
    )
  )[0].id;

  return { opportunityId, grantId, contactId };
}

const createRequest = async (
  setup: Setup,
  options: {
    user?: string;
    now?: string;
    body?: string;
    hash?: string;
    payload?: string;
    tokenHash?: string;
  } = {},
) => {
  seq += 1;
  return (
    await h.query<{ r: { outcome: string; requestId?: string; reason?: string; status?: string } }>(
      `select public.create_authorized_family_request(
                $1, $2, $3, $4, $5, ${options.payload ?? PAYLOAD}, $6,
                $7::timestamptz + interval '7 days', $7::timestamptz) as r`,
      [
        setup.opportunityId,
        options.user ?? ALICE,
        setup.contactId,
        options.body ?? TEXT,
        options.hash ?? "hash-1",
        options.tokenHash ?? `token-hash-${seq}`,
        options.now ?? NOW,
      ],
    )
  )[0].r;
};

/** Transport succeeded: the single conditional update the repository makes. */
const markDelivered = async (requestId: string) =>
  h.exec(
    `update public.family_requests
        set status = 'delivered', delivered_at = now()
      where id = '${requestId}' and status = 'pending'`,
  );

/** An approved chain whose obligation already exists and was delivered. */
async function deliveredChain(): Promise<Chain> {
  const setup = await approvedChain();
  const created = await createRequest(setup);
  await markDelivered(created.requestId as string);
  return { ...setup, requestId: created.requestId as string };
}

const respond = async (requestId: string, now = NOW) =>
  (
    await h.query<{ r: { outcome: string; responseId?: string; closureId?: string } }>(
      `select public.record_family_response($1, 'Yes, we are visiting.',
              '{"intent":"yes"}'::jsonb, $2::timestamptz) as r`,
      [requestId, now],
    )
  )[0].r;

beforeAll(async () => {
  h = await createHarness();
  await h.exec(`
    insert into auth.users (id) values ('${ALICE}'), ('${BOB}');
    insert into public.entities (id, user_id, type, display_name)
      values ('${JOHN}', '${ALICE}', 'person', 'John'),
             ('${MARY}', '${ALICE}', 'person', 'Mary'),
             ('${MARY_BOB}', '${BOB}', 'person', 'Mary');
  `);
});

describe("1. create_authorized_family_request is one transaction (frozen E3)", () => {
  it("creates the obligation, spends the consent and consumes the opportunity together", async () => {
    const setup = await approvedChain();
    const result = await createRequest(setup);
    expect(result).toMatchObject({ outcome: "created", status: "pending" });

    const [grant] = await h.query<{ used_at: string | null }>(
      "select used_at from public.consent_grants where id = $1",
      [setup.grantId],
    );
    const [opportunity] = await h.query<{ status: string; resolved_at: string | null }>(
      "select status, resolved_at from public.reconnect_opportunities where id = $1",
      [setup.opportunityId],
    );
    const [request] = await h.query<{ status: string; rendered_body: string; delivered_at: string | null }>(
      "select status, rendered_body, delivered_at from public.family_requests where id = $1",
      [result.requestId as string],
    );

    // The invariant, stated as an assertion: request exists <=> grant consumed
    // <=> opportunity consumed.
    expect(grant.used_at).not.toBeNull();
    expect(opportunity.status).toBe("consumed");
    expect(opportunity.resolved_at).not.toBeNull();
    // ...and delivery has NOT happened yet. Consumption is authorization, not
    // transport.
    expect(request.status).toBe("pending");
    expect(request.delivered_at).toBeNull();
    expect(request.rendered_body).toBe(TEXT);
  });

  it("is idempotent: a replay reloads and spends nothing twice", async () => {
    const setup = await approvedChain();
    const first = await createRequest(setup);
    const again = await createRequest(setup);

    expect(again).toMatchObject({ outcome: "reloaded", requestId: first.requestId });

    const [counts] = await h.query<{ requests: number }>(
      "select count(*)::int as requests from public.family_requests where opportunity_id = $1",
      [setup.opportunityId],
    );
    expect(counts.requests).toBe(1);
  });

  it("refuses another user's opportunity, and says nothing more", async () => {
    const setup = await approvedChain();
    expect(await createRequest(setup, { user: BOB })).toEqual({ outcome: "opportunity_not_found" });
    const [grant] = await h.query<{ used_at: string | null }>(
      "select used_at from public.consent_grants where id = $1",
      [setup.grantId],
    );
    expect(grant.used_at).toBeNull();
  });

  it("refuses an opportunity that is not approved", async () => {
    const setup = await approvedChain();
    await h.exec(
      `update public.reconnect_opportunities set status = 'offered' where id = '${setup.opportunityId}'`,
    );
    expect(await createRequest(setup)).toMatchObject({ outcome: "opportunity_not_approved" });
  });

  it("refuses a used, revoked or expired grant", async () => {
    const used = await approvedChain();
    await h.exec(`update public.consent_grants set used_at = now() where id = '${used.grantId}'`);
    expect(await createRequest(used)).toEqual({
      outcome: "grant_invalid",
      reason: "grant_already_used",
    });

    const revoked = await approvedChain();
    await h.exec(`update public.consent_grants set revoked_at = now() where id = '${revoked.grantId}'`);
    expect(await createRequest(revoked)).toEqual({
      outcome: "grant_invalid",
      reason: "grant_revoked",
    });

    const expired = await approvedChain();
    // Exactly at the 72-hour boundary.
    expect(await createRequest(expired, { now: "2026-09-19T12:00:00.000Z" })).toEqual({
      outcome: "grant_invalid",
      reason: "grant_expired",
    });
    expect(
      await createRequest(expired, { now: "2026-09-19T11:59:59.000Z" }),
    ).toMatchObject({ outcome: "created" });
  });

  it("re-asserts integrity under the locks, not just in TypeScript", async () => {
    // The TypeScript preconditions ran against rows nobody was holding. This
    // is the same question asked again while the grant row is locked, so a
    // change landing in between cannot slip past.
    const body = await approvedChain();
    expect(await createRequest(body, { body: "Hi John - different bytes." })).toEqual({
      outcome: "integrity_rejected",
      reason: "rendered_text_mismatch",
    });

    const hash = await approvedChain();
    expect(await createRequest(hash, { hash: "hash-2" })).toEqual({
      outcome: "integrity_rejected",
      reason: "rendered_text_hash_mismatch",
    });

    const payload = await approvedChain();
    expect(
      await createRequest(payload, {
        payload: `'{"fromDisplayName":"Dad","topic":"visit","question":"ask_if_calling"}'::jsonb`,
      }),
    ).toEqual({ outcome: "integrity_rejected", reason: "payload_mismatch" });
  });

  it("accepts a payload whose keys were re-serialized in another order", async () => {
    // jsonb equality is key-order-insensitive, which is the comparison wanted:
    // the same fields are the same payload, however JSON.stringify ordered it.
    const setup = await approvedChain();
    expect(
      await createRequest(setup, {
        payload: `'{"question":"ask_if_visiting","topic":"visit","fromDisplayName":"Dad"}'::jsonb`,
      }),
    ).toMatchObject({ outcome: "created" });
  });

  it("leaves everything untouched when it refuses", async () => {
    const setup = await approvedChain();
    await h.exec(
      `update public.reconnect_opportunities set status = 'offered' where id = '${setup.opportunityId}'`,
    );
    await createRequest(setup);

    const [grant] = await h.query<{ used_at: string | null }>(
      "select used_at from public.consent_grants where id = $1",
      [setup.grantId],
    );
    const [counts] = await h.query<{ requests: number }>(
      "select count(*)::int as requests from public.family_requests where opportunity_id = $1",
      [setup.opportunityId],
    );
    expect(grant.used_at).toBeNull();
    // No half-state: no obligation was created either.
    expect(counts.requests).toBe(0);
  });

  it("the superseded delivery-consumes-consent function is gone", async () => {
    const rows = await h.query<{ proname: string }>(
      `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'finalize_family_send'`,
    );
    expect(rows).toHaveLength(0);
  });
});

describe("1b. the crash window is unfinished transport, not lost consent", () => {
  it("a crash after creation leaves a retryable obligation", async () => {
    // The exact state a reclaimed runtime leaves behind: authorized, consumed,
    // undelivered. It must NOT look like a state needing fresh consent.
    const setup = await approvedChain();
    const created = await createRequest(setup);

    const [row] = await h.query<{ status: string; used_at: string | null; opp: string }>(
      `select r.status,
              g.used_at,
              o.status as opp
         from public.family_requests r
         join public.consent_grants g on g.opportunity_id = r.opportunity_id
         join public.reconnect_opportunities o on o.id = r.opportunity_id
        where r.id = $1`,
      [created.requestId as string],
    );
    expect(row.status).toBe("pending");
    expect(row.used_at).not.toBeNull();
    expect(row.opp).toBe("consumed");
  });

  it("a rotated token keeps the ORIGINAL window and the original bytes", async () => {
    const setup = await approvedChain();
    const created = await createRequest(setup);
    const id = created.requestId as string;
    const [before] = await h.query<{ token_expires_at: string; rendered_body: string }>(
      "select token_expires_at, rendered_body from public.family_requests where id = $1",
      [id],
    );

    await h.exec(
      `update public.family_requests set access_token_hash = 'rotated-hash'
        where id = '${id}' and status = 'pending'`,
    );

    const [after] = await h.query<{
      token_expires_at: string;
      rendered_body: string;
      access_token_hash: string;
    }>(
      "select token_expires_at, rendered_body, access_token_hash from public.family_requests where id = $1",
      [id],
    );
    // A new capability. NOT a new deadline, and not new bytes.
    expect(after.access_token_hash).toBe("rotated-hash");
    expect(after.token_expires_at).toEqual(before.token_expires_at);
    expect(after.rendered_body).toBe(before.rendered_body);
  });

  it("a DELIVERED request is never re-keyed", async () => {
    // The link is already in the family member's hands. Rotating its hash
    // would break a capability someone was handed, which is a worse failure
    // than the one rotation exists to fix.
    const setup = await deliveredChain();
    const [before] = await h.query<{ access_token_hash: string }>(
      "select access_token_hash from public.family_requests where id = $1",
      [setup.requestId],
    );
    await h.exec(
      `update public.family_requests set access_token_hash = 'should-not-apply'
        where id = '${setup.requestId}' and status = 'pending'`,
    );
    const [after] = await h.query<{ access_token_hash: string }>(
      "select access_token_hash from public.family_requests where id = $1",
      [setup.requestId],
    );
    expect(after.access_token_hash).toBe(before.access_token_hash);
  });

  it("retrying delivery never mints a second request or a second grant", async () => {
    const setup = await approvedChain();
    await createRequest(setup);
    await createRequest(setup);
    await createRequest(setup);

    const [counts] = await h.query<{ requests: number; grants: number }>(
      `select
         (select count(*)::int from public.family_requests where opportunity_id = $1) as requests,
         (select count(*)::int from public.consent_grants where opportunity_id = $1) as grants`,
      [setup.opportunityId],
    );
    expect(counts).toEqual({ requests: 1, grants: 1 });
  });
});

describe("1c. the whole approved artefact is re-checked under the locks", () => {
  // The drift these close: consent is given against a rendered sentence, and
  // the opportunity that produced it is a live row. If it is re-rendered,
  // re-hashed or re-minimized between the approval and the send, the grant and
  // the opportunity no longer agree - and a request built from a grant that
  // disagrees with its opportunity is exactly what the exact-text chain exists
  // to prevent. Checked under the locks, because TypeScript checked an earlier
  // moment.
  const assertRefused = async (setup: Setup, expected: string) => {
    const result = await createRequest(setup);
    expect(result).toEqual({ outcome: "integrity_rejected", reason: expected });

    const [state] = await h.query<{ used_at: string | null; status: string; requests: number }>(
      `select g.used_at,
              o.status,
              (select count(*)::int from public.family_requests
                where opportunity_id = o.id) as requests
         from public.reconnect_opportunities o
         join public.consent_grants g on g.opportunity_id = o.id
        where o.id = $1`,
      [setup.opportunityId],
    );
    // Nothing created, nothing spent, nothing consumed - and the notifier is
    // never reached, because it is only called after this returns `created`.
    expect(state.requests).toBe(0);
    expect(state.used_at).toBeNull();
    expect(state.status).toBe("approved");
  };

  it("rejects an opportunity whose rendered_text changed after consent", async () => {
    const setup = await approvedChain();
    await h.exec(
      `update public.reconnect_opportunities
          set rendered_text = 'Hi John - shall I ask about something else?'
        where id = '${setup.opportunityId}'`,
    );
    await assertRefused(setup, "opportunity_rendered_text_mismatch");
  });

  it("rejects an opportunity whose rendered_text_hash changed after consent", async () => {
    const setup = await approvedChain();
    await h.exec(
      `update public.reconnect_opportunities set rendered_text_hash = 'hash-2'
        where id = '${setup.opportunityId}'`,
    );
    await assertRefused(setup, "opportunity_hash_mismatch");
  });

  it("rejects an opportunity whose share_payload changed after consent", async () => {
    const setup = await approvedChain();
    await h.exec(
      `update public.reconnect_opportunities
          set share_payload = '{"fromDisplayName":"Dad","topic":"visit","question":"ask_if_calling"}'::jsonb
        where id = '${setup.opportunityId}'`,
    );
    await assertRefused(setup, "opportunity_payload_mismatch");
  });

  it("the full chain agreeing is what lets a request be created", async () => {
    const setup = await approvedChain();
    expect(await createRequest(setup)).toMatchObject({ outcome: "created" });
  });
});

describe("1d. the recipient is bound structurally, not trusted", () => {
  // Foreign keys prove these ids name real rows. They prove nothing about the
  // rows belonging together, and service_role bypasses RLS - so without this,
  // an application bug that passed a valid contact id for the WRONG person
  // would deliver John's approved sentence to Mary with every constraint in
  // the schema satisfied.
  const contactFor = async (user: string, entityId: string) => {
    seq += 1;
    return (
      await h.query<{ id: string }>(
        `insert into public.family_contacts (user_id, entity_id, channel, address)
         values ($1, $2, 'dev', $3) returning id`,
        [user, entityId, `dev-inbox:bound-${seq}`],
      )
    )[0].id;
  };

  it("refuses a contact belonging to another user, and leaks nothing", async () => {
    const setup = await approvedChain();
    const bobsContact = await contactFor(BOB, MARY_BOB);
    const result = await createRequest({ ...setup, contactId: bobsContact });

    // The same answer a nonexistent id gets: a caller learns nothing about
    // another user's address book, not even that the row exists.
    expect(result).toEqual({ outcome: "contact_not_found" });
    const missing = await createRequest({
      ...setup,
      contactId: "99999999-9999-9999-9999-999999999999",
    });
    expect(missing).toEqual({ outcome: "contact_not_found" });
  });

  it("refuses this user's contact for a DIFFERENT person", async () => {
    const setup = await approvedChain();
    const marysContact = await contactFor(ALICE, MARY);
    expect(await createRequest({ ...setup, contactId: marysContact })).toEqual({
      outcome: "recipient_mismatch",
      reason: "contact_entity_mismatch",
    });
  });

  it("refuses when the consent scope names a different recipient", async () => {
    const setup = await approvedChain();
    // The person agreed to a message to Mary; the contact and opportunity say
    // John. Two out of three is not enough.
    await h.exec(
      `update public.consent_grants
          set scope = '{"recipientEntityId":"${MARY}","purpose":"reconnect_request"}'::jsonb
        where id = '${setup.grantId}'`,
    );
    expect(await createRequest(setup)).toEqual({
      outcome: "recipient_mismatch",
      reason: "consent_scope_recipient_mismatch",
    });
  });

  it("creates the request when scope, contact and opportunity all agree", async () => {
    const setup = await approvedChain();
    await h.exec(
      `update public.consent_grants
          set scope = '{"recipientEntityId":"${JOHN}","purpose":"reconnect_request"}'::jsonb
        where id = '${setup.grantId}'`,
    );
    expect(await createRequest(setup)).toMatchObject({ outcome: "created" });
  });

  it("a refused recipient spends nothing", async () => {
    const setup = await approvedChain();
    const marysContact = await contactFor(ALICE, MARY);
    await createRequest({ ...setup, contactId: marysContact });
    const [state] = await h.query<{ used_at: string | null; status: string }>(
      `select g.used_at, o.status from public.reconnect_opportunities o
         join public.consent_grants g on g.opportunity_id = o.id where o.id = $1`,
      [setup.opportunityId],
    );
    expect(state.used_at).toBeNull();
    expect(state.status).toBe("approved");
  });
});

describe("1e. expiry is a real lifecycle transition", () => {
  // `request_expired` as a return value is not enough. A row that is expired
  // in fact but still says `delivered` keeps counting as an outstanding family
  // request, which silences the companion about that person forever. The
  // status column has to learn what the clock already knows.
  const expireOverdue = (now: string) =>
    h.query<{ id: string }>(
      `update public.family_requests
          set status = 'expired'
        where status in ('pending', 'delivered')
          and token_expires_at <= $1::timestamptz
        returning id`,
      [now],
    );

  const statusOf = async (id: string) =>
    (
      await h.query<{ status: string }>(
        "select status from public.family_requests where id = $1",
        [id],
      )
    )[0].status;

  it("pending → expired at and after the boundary, never before", async () => {
    const inside = await approvedChain();
    const insideId = (await createRequest(inside)).requestId as string;
    await expireOverdue("2026-09-23T11:59:59.000Z");
    expect(await statusOf(insideId)).toBe("pending");

    await expireOverdue("2026-09-23T12:00:00.000Z");
    expect(await statusOf(insideId)).toBe("expired");
  });

  it("delivered but unanswered → expired", async () => {
    const setup = await deliveredChain();
    expect(await statusOf(setup.requestId)).toBe("delivered");
    await expireOverdue("2026-10-01T00:00:00.000Z");
    expect(await statusOf(setup.requestId)).toBe("expired");
  });

  it("answered stays answered", async () => {
    const setup = await deliveredChain();
    await respond(setup.requestId);
    expect(await statusOf(setup.requestId)).toBe("answered");
    await expireOverdue("2026-10-01T00:00:00.000Z");
    expect(await statusOf(setup.requestId)).toBe("answered");
  });

  it("an expired request is not answerable", async () => {
    const setup = await deliveredChain();
    await expireOverdue("2026-10-01T00:00:00.000Z");
    // The token window check fires first and is itself the reason.
    expect(await respond(setup.requestId, "2026-10-01T00:00:00.000Z")).toEqual({
      outcome: "request_expired",
    });
  });
});

describe("2. record_family_response is one transaction", () => {
  it("writes the response, the closure and the `answered` transition together", async () => {
    const setup = await deliveredChain();
    const result = await respond(setup.requestId);

    expect(result.outcome).toBe("recorded");
    expect(result.responseId).toBeTruthy();
    expect(result.closureId).toBeTruthy();

    const [request] = await h.query<{ status: string }>(
      "select status from public.family_requests where id = $1",
      [setup.requestId],
    );
    expect(request.status).toBe("answered");

    const [closure] = await h.query<{ opportunity_id: string; response_id: string }>(
      "select opportunity_id, response_id from public.closures where id = $1",
      [result.closureId as string],
    );
    expect(closure.opportunity_id).toBe(setup.opportunityId);
    expect(closure.response_id).toBe(result.responseId);
  });

  it("a double tap yields one response and one closure", async () => {
    const setup = await deliveredChain();
    const first = await respond(setup.requestId);
    const second = await respond(setup.requestId);

    expect(second.outcome).toBe("already_answered");
    expect(second.responseId).toBe(first.responseId);
    expect(second.closureId).toBe(first.closureId);

    const [counts] = await h.query<{ responses: number; closures: number }>(
      `select
         (select count(*)::int from public.family_responses where request_id = $1) as responses,
         (select count(*)::int from public.closures where opportunity_id = $2) as closures`,
      [setup.requestId, setup.opportunityId],
    );
    expect(counts).toEqual({ responses: 1, closures: 1 });
  });

  it("refuses exactly AT the seven-day token boundary, and PERSISTS the expiry", async () => {
    // Separate chains per side of the boundary: the refusal is no longer a
    // pure read, it retires the row, so reusing one chain would test the
    // second call against a request the first had already expired.
    const atBoundary = await deliveredChain();
    expect(await respond(atBoundary.requestId, "2026-09-23T12:00:00.000Z")).toEqual({
      outcome: "request_expired",
    });
    const [expired] = await h.query<{ status: string }>(
      "select status from public.family_requests where id = $1",
      [atBoundary.requestId],
    );
    // Not merely reported. The row learned it too.
    expect(expired.status).toBe("expired");

    const inside = await deliveredChain();
    expect(
      (await respond(inside.requestId, "2026-09-23T11:59:59.000Z")).outcome,
    ).toBe("recorded");

    const past = await deliveredChain();
    expect(await respond(past.requestId, "2026-10-01T00:00:00.000Z")).toEqual({
      outcome: "request_expired",
    });
  });

  it("an answered request is never retired by a later expiry check", async () => {
    const setup = await deliveredChain();
    await respond(setup.requestId);
    expect(await respond(setup.requestId, "2026-10-01T00:00:00.000Z")).toMatchObject({
      outcome: "request_expired",
    });
    const [row] = await h.query<{ status: string }>(
      "select status from public.family_requests where id = $1",
      [setup.requestId],
    );
    // `answered` is terminal. The expiry transition is conditional on
    // pending|delivered precisely so it cannot walk back over an answer.
    expect(row.status).toBe("answered");
  });

  it("answers a request that was never delivered — the link still works", async () => {
    // A `pending` request whose delivery failed still has a live token; the
    // family member may have the link from an earlier successful attempt.
    const setup = await approvedChain();
    const created = await createRequest(setup);
    expect((await respond(created.requestId as string)).outcome).toBe("recorded");
  });

  it("refuses an unknown request", async () => {
    expect(await respond("99999999-9999-9999-9999-999999999999")).toEqual({
      outcome: "request_not_found",
    });
  });

  it("the unique index makes a second response structurally impossible", async () => {
    const setup = await deliveredChain();
    await respond(setup.requestId);
    await expect(
      h.exec(
        `insert into public.family_responses (request_id, raw_body)
         values ('${setup.requestId}', 'another answer')`,
      ),
    ).rejects.toThrow(/unique|duplicate key/i);
  });
});

describe("3. the frozen structural invariants still hold", () => {
  it("one consent grant per opportunity", async () => {
    const setup = await approvedChain();
    await expect(
      h.exec(
        `insert into public.consent_grants
           (user_id, opportunity_id, scope, payload_snapshot, rendered_text_snapshot,
            rendered_text_hash, expires_at)
         values ('${ALICE}', '${setup.opportunityId}', '{}'::jsonb, '{}'::jsonb, 'x', 'y', now())`,
      ),
    ).rejects.toThrow(/unique|duplicate key/i);
  });

  it("one family request per opportunity", async () => {
    const setup = await deliveredChain();
    await expect(
      h.exec(
        `insert into public.family_requests
           (opportunity_id, contact_id, rendered_body, rendered_body_hash, payload,
            access_token_hash, token_expires_at)
         values ('${setup.opportunityId}', '${setup.contactId}', 'x', 'y', '{}'::jsonb,
                 'another-token-hash', now())`,
      ),
    ).rejects.toThrow(/unique|duplicate key/i);
  });

  it("one closure per response", async () => {
    const setup = await deliveredChain();
    const result = await respond(setup.requestId);
    await expect(
      h.exec(
        `insert into public.closures (opportunity_id, response_id)
         values ('${setup.opportunityId}', '${result.responseId}')`,
      ),
    ).rejects.toThrow(/unique|duplicate key/i);
  });

  it("family_contacts still carries no token column (R7)", async () => {
    const columns = await h.query<{ column_name: string }>(
      `select column_name from information_schema.columns
        where table_schema = 'public' and table_name = 'family_contacts'`,
    );
    const names = columns.map((c) => c.column_name);
    expect(names).not.toContain("access_token_hash");
    expect(names.some((n) => n.includes("token"))).toBe(false);
  });
});

describe("4. security and privilege posture", () => {
  const signatures = [
    "public.create_authorized_family_request(uuid,uuid,uuid,text,text,jsonb,text,timestamptz,timestamptz)",
    "public.record_family_response(uuid,text,jsonb,timestamptz)",
  ];

  it("is executable by service_role and by nobody else", async () => {
    for (const signature of signatures) {
      for (const role of ["public", "anon", "authenticated"]) {
        const [row] = await h.query<{ ok: boolean }>(
          "select has_function_privilege($1, $2, 'execute') as ok",
          [role, signature],
        );
        expect(row.ok, `${role} on ${signature}`).toBe(false);
      }
      const [svc] = await h.query<{ ok: boolean }>(
        "select has_function_privilege('service_role', $1, 'execute') as ok",
        [signature],
      );
      expect(svc.ok, signature).toBe(true);
    }
  });

  it("is SECURITY INVOKER with a pinned search_path", async () => {
    const rows = await h.query<{ proname: string; prosecdef: boolean; proconfig: string[] | null }>(
      `select p.proname, p.prosecdef, p.proconfig
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and p.proname in ('create_authorized_family_request', 'record_family_response')
        order by 1`,
    );
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.prosecdef, row.proname).toBe(false);
      expect(row.proconfig, row.proname).toEqual(["search_path=pg_catalog, public, pg_temp"]);
    }
  });
});
