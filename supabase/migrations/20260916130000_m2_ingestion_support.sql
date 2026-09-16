-- CareLoop M2 — ingestion support.
--
-- Additive only. No table is created, no column is dropped, and no frozen
-- invariant is altered.
--
-- (1) Provenance on relationships and facts.
--     docs/02 §5 requires all three kinds of structured memory to carry "a link
--     back to the observations that produced them". `facts` already had
--     source_observation_ids; `relationships` did not. Without it, evidence
--     counting cannot be replay-safe: a retried ingest job would re-increment
--     a counter and promote a candidate to confirmed on one conversation's
--     worth of evidence. Storing the contributing ids as sets makes the merge
--     idempotent by construction — re-processing the same observation adds
--     nothing.
alter table public.relationships
  add column if not exists source_observation_ids uuid[] not null default '{}',
  add column if not exists source_conversation_ids uuid[] not null default '{}';

alter table public.facts
  add column if not exists source_conversation_ids uuid[] not null default '{}';

comment on column public.relationships.source_conversation_ids is
  'Distinct conversations that evidenced this edge. evidence_count is its cardinality (docs/02 §5).';

-- (2) Atomic ingest-job claim.
--     R8 gives at-least-once execution; this gives at-most-one-in-flight. The
--     UPDATE ... RETURNING inside one transaction is a compare-and-set lease:
--     a caller either wins the row and gets it back, or gets nothing. The
--     advisory lock serialises claims per conversation so two concurrent
--     attempts cannot interleave entity resolution for the same person, which
--     is the frozen requirement in docs/01 §2.1 step 7. An in-memory mutex
--     cannot do this — serverless instances do not share memory.
create or replace function public.claim_ingest_jobs(
  p_limit integer default 1,
  p_lease_seconds integer default 90
)
returns setof public.jobs
language plpgsql
volatile
-- SECURITY INVOKER (the default) is deliberate: only service_role may execute
-- this, and service_role already has BYPASSRLS. Making it DEFINER would add no
-- capability and would remove a safety net.
-- search_path is pinned with pg_catalog first and pg_temp LAST, so a temporary
-- object can never shadow a referenced relation or operator.
set search_path = pg_catalog, public, pg_temp
as $$
declare
  candidate public.jobs;
  updated   public.jobs;
  claimed   integer := 0;
  conv      text;
  -- Conversations already claimed within THIS call. The NOT EXISTS predicate
  -- below is evaluated against the state at query start, so without this a
  -- single call could hand out two jobs for the same conversation.
  seen      text[] := '{}';
begin
  for candidate in
    select j.*
      from public.jobs j
     where j.kind = 'ingest'
       and j.completed_at is null
       and j.run_after <= now()
       -- Skip conversations that already have an attempt in flight (its lease
       -- has not expired). One ingestion per conversation at a time.
       and not exists (
             select 1
               from public.jobs other
              where other.kind = 'ingest'
                and other.completed_at is null
                and other.id <> j.id
                and other.run_after > now()
                and other.payload ->> 'conversationId' = j.payload ->> 'conversationId'
           )
     order by j.created_at asc
     limit greatest(p_limit * 4, 8)
     for update skip locked
  loop
    exit when claimed >= p_limit;

    conv := coalesce(candidate.payload ->> 'conversationId', candidate.key);
    continue when conv = any(seen);

    if pg_try_advisory_xact_lock(
         hashtextextended(coalesce(candidate.payload ->> 'conversationId', candidate.key), 0)
       ) then
      update public.jobs
         set attempts   = attempts + 1,
             run_after  = now() + make_interval(secs => p_lease_seconds)
       where id = candidate.id
      returning * into updated;

      claimed := claimed + 1;
      seen    := seen || conv;
      return next updated;
    end if;
  end loop;

  return;
end;
$$;

-- Privileges are set explicitly rather than inherited from Supabase's default
-- privileges for the public schema. Two reasons: a REVOKE without a matching
-- GRANT would silently break the server's own calls, and an internal helper
-- should not depend on a platform default to stay internal.
--
-- This function is reachable as POST /rest/v1/rpc/claim_ingest_jobs, so the
-- EXECUTE privilege is the only thing standing between a browser and the job
-- scheduler. It claims leases, increments attempts and returns job payloads,
-- none of which any client has business doing.
revoke all on function public.claim_ingest_jobs(integer, integer)
  from public, anon, authenticated;
grant execute on function public.claim_ingest_jobs(integer, integer)
  to service_role;

-- (3) Episode similarity search.
--     pgvector's <=> operator is not reachable through PostgREST's query
--     syntax, so open-ended episodic recall needs this function. It is INVOKER
--     rights (not security definer), so RLS still applies to any role that is
--     not the service role, and the user filter is in the predicate regardless.
create or replace function public.match_episodes(
  p_user_id uuid,
  p_query   extensions.vector(1536),
  p_limit   integer default 5
)
returns table (
  id                    uuid,
  summary               text,
  occurred_at           timestamptz,
  occurred_at_precision public.time_precision,
  salience              numeric,
  similarity            double precision
)
language sql
stable
-- SECURITY INVOKER (the default) is deliberate. Under invoker rights RLS on
-- `episodes` still applies to any caller that is not the service role, so the
-- user predicate below is the second of three independent layers, not the only
-- one. A DEFINER function here would turn p_user_id into a genuine
-- cross-user read primitive.
--
-- `extensions` must be on the search_path: pgvector lives there, so without it
-- the <=> operator is not resolvable inside the function body. pg_catalog is
-- pinned first and pg_temp last so neither can be shadowed.
set search_path = pg_catalog, public, extensions, pg_temp
as $$
  select e.id,
         e.summary,
         e.occurred_at,
         e.occurred_at_precision,
         e.salience,
         1 - (e.embedding operator(extensions.<=>) p_query) as similarity
    from public.episodes e
   -- The user predicate is unconditional. It holds even for the service role,
   -- which has BYPASSRLS, so scoping never depends on RLS being in force.
   where e.user_id = p_user_id
     and e.embedding is not null
   order by e.embedding operator(extensions.<=>) p_query
   limit greatest(p_limit, 0);
$$;

-- p_user_id is an UNTRUSTED argument by construction: anything that can call
-- this function can name any user. That is precisely why `authenticated` is
-- revoked here as well as `anon` - episodic memory must never be a browser
-- RPC where the caller supplies someone else's UUID. Only trusted server code
-- running as service_role, which has already established who the caller is,
-- may execute it.
revoke all on function public.match_episodes(uuid, extensions.vector, integer)
  from public, anon, authenticated;
grant execute on function public.match_episodes(uuid, extensions.vector, integer)
  to service_role;

-- pgvector lives in `extensions`, and a SECURITY INVOKER function resolves its
-- operators with the CALLER's privileges. Without USAGE on that schema the
-- <=> operator is not resolvable and episodic recall fails at runtime with a
-- confusing "operator does not exist". Supabase grants this by default; it is
-- restated here so the migration does not depend on a platform default for
-- correctness. Idempotent if already present.
grant usage on schema extensions to service_role;
