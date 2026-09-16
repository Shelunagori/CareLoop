-- CareLoop M5 — exact-text consent and the family loop.
--
-- Additive only. No table or column is created or altered; the frozen data
-- model (docs/02 section 4.1) already carries consent_grants, family_contacts,
-- family_requests, family_responses and closures, with the unique constraints
-- that make "one grant per opportunity" and "one request per opportunity"
-- structural.
--
-- This migration adds exactly three things, and each is a STRUCTURAL invariant
-- or an atomicity boundary that cannot be expressed from outside a
-- transaction. No product policy lives here: whether to send, whether consent
-- is valid, what the message says and who may receive it are all decided in
-- TypeScript before either function is called.

-- (1) One response per request, for the POC.
--     `closures` already has UNIQUE(response_id), so without this a second
--     submission of the same link would create a second response and a second
--     closure - the older adult would be told twice. The index makes the
--     duplicate impossible rather than merely guarded against.
create unique index if not exists family_responses_one_per_request_idx
  on public.family_responses (request_id);

-- ---------------------------------------------------------------------------
-- (2) Creating the authorized request (frozen E3, docs/04 section 12.2a).
--
-- Three state changes have to land together or not at all:
--   family_requests           - the row exists, status 'pending'
--   consent_grants.used_at    - the authority is spent
--   reconnect_opportunities   - approved -> consumed
--
-- The invariant this function exists to make STRUCTURAL:
--
--   a family_request exists  <=>  its grant is consumed  <=>  its opportunity
--                                 is consumed
--
-- Split across PostgREST calls these are three transactions with two windows
-- between them, and a reclaimed serverless runtime in either window leaves
-- half-state: an outbound obligation whose consent is still live and
-- re-spendable, or a spent consent with nothing to deliver.
--
-- WHY CREATION AND NOT DELIVERY IS THE CONSUMING EVENT.
--
-- The database cannot transact with an external notifier, so SOMETHING has to
-- be durable before the network call. Consuming at creation makes the request
-- row that durable thing: the user's authorization becomes one stable outbound
-- obligation, and every later attempt is transport work against that same row.
--
-- The alternative - consume after the provider returns success - was tried in
-- an earlier revision of this milestone and is worse, because the dangerous
-- window it opens is the one that reaches a human being:
--
--     provider delivers the message
--       -> process dies before the database is updated
--       -> the database still says the consent is unused
--       -> a retry sends the SAME bytes to the family member AGAIN
--
-- Consuming first inverts the failure: the surviving window is a consumed
-- grant with an undelivered request, which is unfinished TRANSPORT work and is
-- resolved by retrying delivery of that same row. Nobody is messaged twice,
-- and - just as important - the older adult is never asked to approve
-- something they already approved. UNIQUE(family_requests.opportunity_id) is
-- what makes that structural rather than a matter of the retry code being
-- careful.
--
-- Product policy is NOT decided here. Whether the bytes are the approved bytes
-- is decided in TypeScript (core/consent/validation.ts) before this is called;
-- the integrity checks below are the transaction-level re-assertion of that
-- decision, holding the row locks, so nothing can change between the check and
-- the write.
-- ---------------------------------------------------------------------------

-- The delivery-consumes-consent ordering of the previous revision is gone, not
-- merely unused. Dropped explicitly so a database that applied an earlier copy
-- of this migration cannot keep executing the superseded semantics.
drop function if exists public.finalize_family_send(uuid, uuid, uuid, timestamptz);

create or replace function public.create_authorized_family_request(
  p_opportunity_id     uuid,
  p_user_id            uuid,
  p_contact_id         uuid,
  p_rendered_body      text,
  p_rendered_body_hash text,
  p_payload            jsonb,
  p_access_token_hash  text,
  p_token_expires_at   timestamptz,
  p_now                timestamptz default now()
)
returns jsonb
language plpgsql
volatile
-- SECURITY INVOKER (the default). Only service_role may execute this, and
-- service_role already has BYPASSRLS, so DEFINER would add no capability while
-- removing a safety net. search_path is pinned with pg_catalog first and
-- pg_temp LAST, so a temporary object can never shadow a referenced relation.
set search_path = pg_catalog, public, pg_temp
as $$
declare
  opp_row      public.reconnect_opportunities;
  grant_row    public.consent_grants;
  contact_row  public.family_contacts;
  req_row      public.family_requests;
  scope_entity text;
  new_id       uuid;
begin
  -- Identity first, and by (id, user_id) together: a caller naming someone
  -- else's opportunity learns nothing, not even that it exists.
  select o.* into opp_row
    from public.reconnect_opportunities o
   where o.id = p_opportunity_id
     and o.user_id = p_user_id
   for update;
  if not found then
    return jsonb_build_object('outcome', 'opportunity_not_found');
  end if;

  select g.* into grant_row
    from public.consent_grants g
   where g.opportunity_id = p_opportunity_id
     and g.user_id = p_user_id
   for update;
  if not found then
    return jsonb_build_object('outcome', 'grant_invalid', 'reason', 'grant_not_found');
  end if;

  -- Idempotent replay. The obligation already exists, so this call creates
  -- nothing and spends nothing; the caller continues with transport.
  select r.* into req_row
    from public.family_requests r
   where r.opportunity_id = p_opportunity_id
   for update;
  if found then
    return jsonb_build_object(
      'outcome', 'reloaded',
      'requestId', req_row.id,
      'status', req_row.status
    );
  end if;

  -- RECIPIENT BINDING, structural rather than trusted.
  --
  -- The caller supplies a contact id. Foreign keys prove that id names a real
  -- contact and that the opportunity names a real entity; they prove NOTHING
  -- about the two belonging together. Under service_role - which bypasses RLS
  -- - an application bug that passed Mary's perfectly valid contact id would
  -- deliver John's approved sentence to Mary, and every constraint in the
  -- schema would be satisfied. This is the check that makes that impossible.
  select c.* into contact_row
    from public.family_contacts c
   where c.id = p_contact_id
     and c.user_id = p_user_id;
  if not found then
    -- Also the answer for a contact that exists but belongs to someone else.
    -- Same reply either way: a caller learns nothing about another user's
    -- address book, not even whether a row with that id exists.
    return jsonb_build_object('outcome', 'contact_not_found');
  end if;
  if contact_row.entity_id is distinct from opp_row.entity_id then
    return jsonb_build_object('outcome', 'recipient_mismatch', 'reason', 'contact_entity_mismatch');
  end if;

  -- The consent scope names the recipient the person actually agreed to. When
  -- it carries one, it is the third opinion that must agree with the other
  -- two: scope == contact == opportunity, or nothing is sent.
  scope_entity := grant_row.scope->>'recipientEntityId';
  if scope_entity is not null and scope_entity is distinct from contact_row.entity_id::text then
    return jsonb_build_object(
      'outcome', 'recipient_mismatch',
      'reason', 'consent_scope_recipient_mismatch'
    );
  end if;

  -- INTEGRITY, re-asserted under the locks, across the WHOLE chain:
  --
  --   RPC input  ==  grant snapshot  ==  opportunity's stored artefact
  --
  -- TypeScript checked the first half a moment ago against rows nobody was
  -- holding. The second half is checked here and only here: the opportunity
  -- could have been re-rendered, re-hashed or re-minimized between the
  -- approval and this transaction, and a request built from a grant that no
  -- longer matches its opportunity is exactly the drift this milestone exists
  -- to make impossible. Nothing is repaired and nothing is regenerated - a
  -- mismatch is a refusal.
  if opp_row.rendered_text is distinct from grant_row.rendered_text_snapshot then
    return jsonb_build_object(
      'outcome', 'integrity_rejected', 'reason', 'opportunity_rendered_text_mismatch'
    );
  end if;
  if opp_row.rendered_text_hash is distinct from grant_row.rendered_text_hash then
    return jsonb_build_object(
      'outcome', 'integrity_rejected', 'reason', 'opportunity_hash_mismatch'
    );
  end if;
  if opp_row.share_payload is distinct from grant_row.payload_snapshot then
    return jsonb_build_object(
      'outcome', 'integrity_rejected', 'reason', 'opportunity_payload_mismatch'
    );
  end if;

  -- Byte equality against the SNAPSHOT, not a hash comparison: the snapshot is
  -- what the person actually read.
  if p_rendered_body is distinct from grant_row.rendered_text_snapshot then
    return jsonb_build_object('outcome', 'integrity_rejected', 'reason', 'rendered_text_mismatch');
  end if;
  if p_rendered_body_hash is distinct from grant_row.rendered_text_hash then
    return jsonb_build_object('outcome', 'integrity_rejected', 'reason', 'rendered_text_hash_mismatch');
  end if;
  -- jsonb equality is key-order-insensitive, which is the comparison wanted:
  -- a re-serialized payload with the same fields is the same payload.
  if p_payload is distinct from grant_row.payload_snapshot then
    return jsonb_build_object('outcome', 'integrity_rejected', 'reason', 'payload_mismatch');
  end if;

  if grant_row.used_at is not null then
    return jsonb_build_object('outcome', 'grant_invalid', 'reason', 'grant_already_used');
  end if;
  if grant_row.revoked_at is not null then
    return jsonb_build_object('outcome', 'grant_invalid', 'reason', 'grant_revoked');
  end if;
  if grant_row.expires_at <= p_now then
    return jsonb_build_object('outcome', 'grant_invalid', 'reason', 'grant_expired');
  end if;

  if opp_row.status <> 'approved' then
    return jsonb_build_object('outcome', 'opportunity_not_approved', 'status', opp_row.status);
  end if;

  insert into public.family_requests (
    opportunity_id, contact_id, rendered_body, rendered_body_hash, payload,
    access_token_hash, token_expires_at, created_at, status
  ) values (
    p_opportunity_id, p_contact_id, p_rendered_body, p_rendered_body_hash, p_payload,
    p_access_token_hash, p_token_expires_at, p_now, 'pending'
  )
  returning id into new_id;

  update public.consent_grants
     set used_at = p_now
   where id = grant_row.id
     and used_at is null
     and revoked_at is null;

  update public.reconnect_opportunities
     set status = 'consumed', resolved_at = p_now
   where id = p_opportunity_id
     and status = 'approved';

  return jsonb_build_object('outcome', 'created', 'requestId', new_id, 'status', 'pending');

exception
  -- The expected violation is family_requests_opportunity_idx: a concurrent
  -- call won the race. That is the index doing its job, and the right answer
  -- is the one a replay gets. Anything else is an integrity problem we do not
  -- understand, so it is confirmed before being claimed and re-raised
  -- otherwise.
  when unique_violation then
    select r.* into req_row
      from public.family_requests r
     where r.opportunity_id = p_opportunity_id;
    if found then
      return jsonb_build_object(
        'outcome', 'reloaded',
        'requestId', req_row.id,
        'status', req_row.status
      );
    end if;
    raise;
end;
$$;

revoke all on function public.create_authorized_family_request(
  uuid, uuid, uuid, text, text, jsonb, text, timestamptz, timestamptz
) from public, anon, authenticated;
grant execute on function public.create_authorized_family_request(
  uuid, uuid, uuid, text, text, jsonb, text, timestamptz, timestamptz
) to service_role;

-- ---------------------------------------------------------------------------
-- (3) Recording a family reply.
--
-- The response row, the closure and the request's `answered` transition are
-- one unit: a closure without a response is a promise with no evidence, and a
-- response with no closure is an answer the older adult never hears. A family
-- member double-tapping a link must not produce two of either.
-- ---------------------------------------------------------------------------
create or replace function public.record_family_response(
  p_request_id uuid,
  p_raw_body   text,
  p_parsed     jsonb,
  p_now        timestamptz default now()
)
returns jsonb
language plpgsql
volatile
set search_path = pg_catalog, public, pg_temp
as $$
declare
  req_row     public.family_requests;
  existing    public.family_responses;
  closure_row public.closures;
  new_resp    uuid;
  new_closure uuid;
begin
  select r.* into req_row
    from public.family_requests r
   where r.id = p_request_id
   for update;
  if not found then
    return jsonb_build_object('outcome', 'request_not_found');
  end if;

  -- Read authority ends at a defined instant, and it is checked here as well
  -- as at the edge: the endpoint's check is UX, this one is the rule.
  --
  -- And it is PERSISTED, not merely reported. A row that is expired in fact
  -- but still says `delivered` goes on counting as an outstanding family
  -- request for suppression, which would silence the companion about that
  -- person forever. The lifecycle transition happens here, under the lock, on
  -- the way out.
  if req_row.token_expires_at <= p_now then
    update public.family_requests
       set status = 'expired'
     where id = p_request_id
       and status in ('pending', 'delivered');
    return jsonb_build_object('outcome', 'request_expired');
  end if;

  select fr.* into existing
    from public.family_responses fr
   where fr.request_id = p_request_id;

  if found then
    select c.* into closure_row from public.closures c where c.response_id = existing.id;
    return jsonb_build_object(
      'outcome', 'already_answered',
      'responseId', existing.id,
      'closureId', closure_row.id
    );
  end if;

  if req_row.status not in ('pending', 'delivered') then
    return jsonb_build_object('outcome', 'request_not_answerable', 'status', req_row.status);
  end if;

  insert into public.family_responses (request_id, raw_body, parsed, received_at)
  values (p_request_id, p_raw_body, p_parsed, p_now)
  returning id into new_resp;

  insert into public.closures (opportunity_id, response_id, created_at)
  values (req_row.opportunity_id, new_resp, p_now)
  returning id into new_closure;

  update public.family_requests
     set status = 'answered'
   where id = p_request_id;

  return jsonb_build_object(
    'outcome', 'recorded',
    'responseId', new_resp,
    'closureId', new_closure
  );

exception
  -- The expected violation is family_responses_one_per_request_idx: a
  -- concurrent submission won. That is the index doing its job, and the right
  -- answer is the one a replay gets. Anything else is an integrity problem we
  -- do not understand, so it is confirmed before being claimed, and re-raised
  -- otherwise.
  when unique_violation then
    select fr.* into existing
      from public.family_responses fr
     where fr.request_id = p_request_id;
    if found then
      select c.* into closure_row from public.closures c where c.response_id = existing.id;
      return jsonb_build_object(
        'outcome', 'already_answered',
        'responseId', existing.id,
        'closureId', closure_row.id
      );
    end if;
    raise;
end;
$$;

revoke all on function public.record_family_response(uuid, text, jsonb, timestamptz)
  from public, anon, authenticated;
grant execute on function public.record_family_response(uuid, text, jsonb, timestamptz)
  to service_role;
