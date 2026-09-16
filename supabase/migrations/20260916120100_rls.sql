-- CareLoop — RLS foundations (M0)
--
-- Posture: every table in `public` has an explicit security decision. The
-- trusted write path is server code holding the service-role key, which has
-- BYPASSRLS — so RLS here is defence in depth against any direct client
-- access, not the primary authorization mechanism (docs/06 §18).
--
-- Consequently M0 grants SELECT on own rows and NO write policies at all.
-- That is deliberate: there is no client-side write surface to get wrong, and
-- adding one is a decision for the milestone that needs it.
--
-- The family magic-link path is NOT designed here. It belongs to M5 and will
-- be an unauthenticated, token-scoped server route reading exactly one
-- family_requests row — not an RLS policy widened for anonymous users.

-- --- Direct ownership: tables carrying user_id -----------------------------
alter table public.profiles                enable row level security;
alter table public.conversations           enable row level security;
alter table public.observations            enable row level security;
alter table public.entities                enable row level security;
alter table public.relationships           enable row level security;
alter table public.facts                   enable row level security;
alter table public.episodes                enable row level security;
alter table public.interaction_events      enable row level security;
alter table public.baselines               enable row level security;
alter table public.signals                 enable row level security;
alter table public.reconnect_opportunities enable row level security;
alter table public.consent_grants          enable row level security;
alter table public.family_contacts         enable row level security;

create policy "profiles: owner reads own"
  on public.profiles for select to authenticated
  using (id = (select auth.uid()));

create policy "conversations: owner reads own"
  on public.conversations for select to authenticated
  using (user_id = (select auth.uid()));

create policy "observations: owner reads own"
  on public.observations for select to authenticated
  using (user_id = (select auth.uid()));

create policy "entities: owner reads own"
  on public.entities for select to authenticated
  using (user_id = (select auth.uid()));

create policy "relationships: owner reads own"
  on public.relationships for select to authenticated
  using (user_id = (select auth.uid()));

create policy "facts: owner reads own"
  on public.facts for select to authenticated
  using (user_id = (select auth.uid()));

create policy "episodes: owner reads own"
  on public.episodes for select to authenticated
  using (user_id = (select auth.uid()));

create policy "interaction_events: owner reads own"
  on public.interaction_events for select to authenticated
  using (user_id = (select auth.uid()));

create policy "baselines: owner reads own"
  on public.baselines for select to authenticated
  using (user_id = (select auth.uid()));

create policy "signals: owner reads own"
  on public.signals for select to authenticated
  using (user_id = (select auth.uid()));

create policy "reconnect_opportunities: owner reads own"
  on public.reconnect_opportunities for select to authenticated
  using (user_id = (select auth.uid()));

create policy "consent_grants: owner reads own"
  on public.consent_grants for select to authenticated
  using (user_id = (select auth.uid()));

create policy "family_contacts: owner reads own"
  on public.family_contacts for select to authenticated
  using (user_id = (select auth.uid()));

-- --- Derived ownership: no user_id column, reached through a parent FK ------
-- These tables intentionally follow docs/02 §4.1 rather than denormalizing a
-- user_id onto every row. Ownership is therefore proven by join, not by a
-- weaker policy.

-- messages → conversations.user_id
alter table public.messages enable row level security;
create policy "messages: owner reads own"
  on public.messages for select to authenticated
  using (exists (
    select 1 from public.conversations c
    where c.id = messages.conversation_id
      and c.user_id = (select auth.uid())
  ));

-- episode_entities → episodes.user_id
alter table public.episode_entities enable row level security;
create policy "episode_entities: owner reads own"
  on public.episode_entities for select to authenticated
  using (exists (
    select 1 from public.episodes e
    where e.id = episode_entities.episode_id
      and e.user_id = (select auth.uid())
  ));

-- family_requests → reconnect_opportunities.user_id
alter table public.family_requests enable row level security;
create policy "family_requests: owner reads own"
  on public.family_requests for select to authenticated
  using (exists (
    select 1 from public.reconnect_opportunities o
    where o.id = family_requests.opportunity_id
      and o.user_id = (select auth.uid())
  ));

-- family_responses → family_requests → reconnect_opportunities.user_id
alter table public.family_responses enable row level security;
create policy "family_responses: owner reads own"
  on public.family_responses for select to authenticated
  using (exists (
    select 1
    from public.family_requests r
    join public.reconnect_opportunities o on o.id = r.opportunity_id
    where r.id = family_responses.request_id
      and o.user_id = (select auth.uid())
  ));

-- closures → reconnect_opportunities.user_id
alter table public.closures enable row level security;
create policy "closures: owner reads own"
  on public.closures for select to authenticated
  using (exists (
    select 1 from public.reconnect_opportunities o
    where o.id = closures.opportunity_id
      and o.user_id = (select auth.uid())
  ));

-- --- Infrastructure: no user-facing access at all --------------------------
-- RLS enabled with ZERO policies = deny all for anon and authenticated.
-- jobs is scheduling machinery, not user data; only the service role touches it.
alter table public.jobs enable row level security;
