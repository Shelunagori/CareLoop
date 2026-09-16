-- CareLoop M4 — atomic signal materialization.
--
-- Additive only. No table, column, constraint or index is altered; the frozen
-- data model (docs/02 section 4.1) already carries everything M4 needs,
-- including UNIQUE(reconnect_opportunities.signal_id), which is the structural
-- form of "one signal -> at most one opportunity" (F3).
--
-- WHY THIS FUNCTION EXISTS AT ALL.
-- The frozen architecture requires the opportunity insert and the
-- signals.status transition to happen in ONE transaction (docs/01 section 1.4,
-- docs/02 section 4.1): "a signal is never marked materialized without its
-- opportunity existing, and never has an opportunity without being marked."
-- The Supabase client speaks PostgREST, where every call is its own
-- transaction, so `insert opportunity` followed by `update signal` is two
-- unrelated round trips with a window between them in which a reclaimed
-- serverless runtime leaves exactly the half-state the invariant forbids.
-- There is no application-level transaction facility to use instead, so the
-- smallest correct thing is this: one round trip that IS the transaction.
--
-- WHAT IS DELIBERATELY NOT IN HERE.
-- Suppression policy. Cooldowns, quiet periods and caps are time-dependent
-- product rules that must stay readable and unit-testable in TypeScript
-- (core/detection/suppression.ts). This function enforces only the invariants
-- that cannot be enforced from outside a transaction: identity, one
-- opportunity per signal, at most one OPEN opportunity per entity, and that
-- the supplied offerability window is structurally sane.
--
-- ARGUMENT TRUST MODEL.
-- Every argument is UNTRUSTED. This runs as service_role, which has BYPASSRLS,
-- and the frozen schema gives signals, entities and opportunities INDEPENDENT
-- foreign keys to auth.users - nothing structurally ties a signal's entity to
-- the signal's user. So the identity of the row being acted on is established
-- HERE, from the signal, before anything is locked, read back or written.
create or replace function public.materialize_signal(
  p_signal_id  uuid,
  p_user_id    uuid,
  p_entity_id  uuid,
  p_proposal   jsonb,
  p_expires_at timestamptz,
  -- Time is an input, not an ambient fact: the M6 fixture replays history at
  -- past timestamps through the Clock port, and a hardcoded now() here would
  -- stamp every replayed materialization with the wall clock instead.
  p_now        timestamptz default now()
)
returns jsonb
language plpgsql
volatile
-- SECURITY INVOKER (the default) is deliberate. Only service_role may execute
-- this, and service_role already has BYPASSRLS, so DEFINER would add no
-- capability while removing a safety net: under invoker rights a future caller
-- without BYPASSRLS still gets RLS on signals and reconnect_opportunities.
-- search_path is pinned with pg_catalog first and pg_temp LAST, so a temporary
-- object can never shadow a referenced relation, function or operator.
set search_path = pg_catalog, public, pg_temp
as $$
declare
  sig_status    public.signal_status;
  sig_entity_id uuid;
  existing_id   uuid;
  new_id        uuid;
begin
  -- 1. IDENTITY FIRST. The signal is loaded by (id, user_id) together, so a
  --    caller who names someone else's signal gets `signal_not_found` and
  --    learns nothing - not even that the id exists. FOR UPDATE both pins the
  --    row against a concurrent status change and makes the status read below
  --    a decision rather than a snapshot.
  select s.status, s.entity_id
    into sig_status, sig_entity_id
    from public.signals s
   where s.id = p_signal_id
     and s.user_id = p_user_id
   for update;

  if not found then
    return jsonb_build_object('outcome', 'signal_not_found', 'opportunityId', null);
  end if;

  -- 2. The caller's entity must be the signal's entity. Without this, an
  --    opportunity could be attached to a signal that is about someone else -
  --    and the schema has no composite constraint that would refuse it.
  if sig_entity_id <> p_entity_id then
    return jsonb_build_object('outcome', 'signal_entity_mismatch', 'opportunityId', null);
  end if;

  -- 3. And that entity must belong to the same user. entities.user_id and
  --    signals.user_id are independent FKs; service_role bypasses RLS; so this
  --    is the only thing standing between a data bug and a cross-user write.
  if not exists (
    select 1 from public.entities e
     where e.id = p_entity_id
       and e.user_id = p_user_id
  ) then
    return jsonb_build_object('outcome', 'entity_not_found', 'opportunityId', null);
  end if;

  -- 4. Only now is the identity verified, so only now is it safe to take a
  --    lock named after it. Locking a caller-supplied pair before validation
  --    would let an unauthorised caller serialise, or stall, work on a
  --    relationship they have no business naming.
  --
  --    The lock is on the VERIFIED signal entity, so two DIFFERENT signals for
  --    the same entity serialise against each other - which is what makes the
  --    open-opportunity check below a guarantee rather than a snapshot.
  perform pg_advisory_xact_lock(
    hashtextextended(p_user_id::text || ':' || sig_entity_id::text, 0)
  );

  -- 5. Idempotent replay, scoped to the verified identity. A retried job
  --    asking again about a signal that already materialized is not an error
  --    and must not be a second opportunity: it reloads the one that exists.
  select o.id into existing_id
    from public.reconnect_opportunities o
   where o.signal_id = p_signal_id
     and o.user_id = p_user_id
     and o.entity_id = sig_entity_id;

  if existing_id is not null then
    return jsonb_build_object('outcome', 'reloaded', 'opportunityId', existing_id);
  end if;

  -- 6. Only a freshly detected signal materializes. A suppressed one has
  --    already been answered; a materialized one was handled above.
  if sig_status <> 'detected' then
    return jsonb_build_object(
      'outcome', 'signal_not_detected',
      'opportunityId', null,
      'signalStatus', sig_status
    );
  end if;

  -- 7. Structural sanity on the offerability window. HOW LONG an opportunity
  --    stays offerable is policy and lives in TypeScript
  --    (core/detection/config.ts); that the supplied timestamp is in the
  --    future is arithmetic, and creating a `proposed` row whose window has
  --    already closed would mean a draft that can never be offered and an
  --    entity blocked by an opportunity nobody can act on.
  if p_expires_at <= p_now then
    return jsonb_build_object('outcome', 'invalid_expiry', 'opportunityId', null);
  end if;

  -- 8. At most one OPEN opportunity per entity, rechecked inside the
  --    transaction. The TypeScript suppression pass checked it too, but that
  --    read happened in an earlier round trip and is a snapshot, not a
  --    guarantee. `approved` counts as open (docs/04 section 11.2).
  if exists (
    select 1
      from public.reconnect_opportunities o
     where o.user_id = p_user_id
       and o.entity_id = sig_entity_id
       and o.status in ('proposed', 'drafted', 'offered', 'approved')
  ) then
    return jsonb_build_object('outcome', 'blocked_open_opportunity', 'opportunityId', null);
  end if;

  insert into public.reconnect_opportunities
    (user_id, signal_id, entity_id, proposal, status, expires_at, created_at)
  values
    (p_user_id, p_signal_id, sig_entity_id, p_proposal, 'proposed', p_expires_at, p_now)
  returning id into new_id;

  update public.signals
     set status = 'materialized',
         materialized_at = p_now
   where id = p_signal_id
     and status = 'detected';

  return jsonb_build_object('outcome', 'materialized', 'opportunityId', new_id);

exception
  when unique_violation then
    -- The EXPECTED violation is UNIQUE(reconnect_opportunities.signal_id): a
    -- concurrent transaction created this signal's opportunity between the
    -- replay lookup and the insert. That is the constraint doing its job, and
    -- the right answer is the same one a replay gets.
    --
    -- Anything else is an integrity problem we do not understand, and turning
    -- it into `reloaded` with a null id would hide it behind a shrug. So the
    -- handler CONFIRMS the expected cause before claiming it, and re-raises
    -- otherwise.
    select o.id into existing_id
      from public.reconnect_opportunities o
     where o.signal_id = p_signal_id
       and o.user_id = p_user_id
       and o.entity_id = sig_entity_id;

    if existing_id is not null then
      return jsonb_build_object('outcome', 'reloaded', 'opportunityId', existing_id);
    end if;

    raise;
end;
$$;

-- Reachable as POST /rest/v1/rpc/materialize_signal, so EXECUTE is the only
-- thing between a browser and the ability to mint reconnect opportunities for
-- an arbitrary user id. `authenticated` is revoked as well as `anon`: p_user_id
-- is an untrusted argument by construction, and only server code that has
-- already established who the caller is may execute it.
revoke all on function public.materialize_signal(uuid, uuid, uuid, jsonb, timestamptz, timestamptz)
  from public, anon, authenticated;
grant execute on function public.materialize_signal(uuid, uuid, uuid, jsonb, timestamptz, timestamptz)
  to service_role;
