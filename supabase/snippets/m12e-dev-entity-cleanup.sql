-- ONE-TIME DEVELOPMENT DATA CLEANUP (M12e.1)
--
-- Run by a human, in the Supabase SQL editor, against a DEVELOPMENT project.
-- Nothing in the application calls this file, and nothing in the application
-- infers provenance from what an entity is called — that is the whole reason
-- `entities.origin` exists. This is here because the migration that added
-- that column deliberately refused to guess at history, so rows created
-- before it are classified `user` whatever made them.
--
-- WHAT IT IS FOR. An alphabetic development entity — "TestPersonA" — created
-- through /api/dev/seed-events before the migration is spelled exactly like
-- a person's name, survives the migration as `user`, and can therefore still
-- be named on a reconnect card. Deleting or reclassifying it is a decision
-- about which rows are litter, and only the operator can make it.
--
-- RULES THIS FILE FOLLOWS
--   * inspect before you change anything — step 1 writes nothing;
--   * every statement is scoped to ONE user id you supply;
--   * you name the rows, by id, from what step 1 shows you. There is no
--     LIKE 'Test%' anywhere in here either: a pattern you would not ship in
--     runtime code is not one to run against a database by hand;
--   * nothing here is safe to run against production, and step 0 is the
--     check that stops you.
--
-- HOW TO RUN IT. Replace every :dev_user_id with the development user's UUID
-- in quotes. Run the steps one at a time, top to bottom, reading each result
-- before continuing. Do not run the whole file at once.

-- ---------------------------------------------------------------------------
-- STEP 0 — prove you are where you think you are.
-- ---------------------------------------------------------------------------
-- Run this first, every time. If the count is large, or the email looks like
-- a real person's, STOP: this is not the project you meant.
select
  (select count(*) from public.entities)                          as entities_total,
  (select count(*) from public.entities where user_id = :dev_user_id) as entities_for_this_user,
  (select count(*) from auth.users)                               as users_total;

-- ---------------------------------------------------------------------------
-- STEP 1 — INSPECT. Writes nothing. This is the decision you are making.
-- ---------------------------------------------------------------------------
-- Every entity this user has, with what it is attached to. Read the whole
-- list. The ones to act on are the ones YOU recognise as having come from a
-- seeding run — not the ones whose names look technical.
select
  e.id,
  e.display_name,
  e.type,
  e.origin,
  e.first_seen_at,
  e.last_mentioned_at,
  (select count(*) from public.interaction_events ie where ie.entity_id = e.id)  as events,
  (select count(*) from public.signals s          where s.entity_id = e.id)      as signals,
  (select count(*) from public.reconnect_opportunities o
     join public.signals s2 on s2.id = o.signal_id
    where s2.entity_id = e.id)                                                   as opportunities,
  (select count(*) from public.family_contacts fc where fc.entity_id = e.id)     as contacts
from public.entities e
where e.user_id = :dev_user_id
order by e.first_seen_at;

-- Useful second look: which of them have ever been shown to a person?
select o.id, o.status, o.offered_at, e.display_name, e.origin
from public.reconnect_opportunities o
join public.signals  s on s.id = o.signal_id
join public.entities e on e.id = s.entity_id
where e.user_id = :dev_user_id
order by o.created_at desc;

-- ---------------------------------------------------------------------------
-- STEP 2 — RECLASSIFY (preferred). Keeps the rows, stops them being shown.
-- ---------------------------------------------------------------------------
-- Marking a row `dev` makes it unpresentable everywhere a person could see
-- it — the reconnect card and the wellbeing recipient both refuse it — while
-- leaving its interaction events in place, which is usually what you want:
-- those events are the history a baseline was being tested against.
--
-- Paste the ids you chose in step 1. Nothing else will match.
update public.entities
   set origin = 'dev'
 where user_id = :dev_user_id
   and id in (
     -- '00000000-0000-0000-0000-000000000000',
     -- '00000000-0000-0000-0000-000000000000'
     null
   );

-- ---------------------------------------------------------------------------
-- STEP 3 — DELETE (only when you want the history gone too).
-- ---------------------------------------------------------------------------
-- IRREVERSIBLE. One delete on `entities` cascades through interaction_events,
-- relationships, episode_entities, signals, reconnect_opportunities,
-- consent_grants, family_requests, family_responses and closures — the same
-- cascade `Reset demo` relies on. Conversations and messages are NOT touched;
-- they are yours, and no decision row survives to be resurrected by them.
--
-- Run step 1 again first and read the counts you are about to destroy.
delete from public.entities
 where user_id = :dev_user_id
   and id in (
     -- '00000000-0000-0000-0000-000000000000'
     null
   );

-- ---------------------------------------------------------------------------
-- STEP 4 — VERIFY.
-- ---------------------------------------------------------------------------
-- Expected afterwards: every remaining `user` row is somebody the person
-- actually mentioned, every seeded demo character is `demo` (re-seed with
-- "Reset demo" if they are still `user`), and anything a dev script made is
-- `dev` or gone.
select origin, count(*), array_agg(display_name order by display_name)
from public.entities
where user_id = :dev_user_id
group by origin
order by origin;
