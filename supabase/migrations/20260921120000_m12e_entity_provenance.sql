-- M12e: where an entity row came from.
--
-- THE PROBLEM THIS REPLACES. A reviewer's browser rendered "RECONNECT WITH
-- M4ABSENCE1789574558". The row was created by the development evidence
-- seeder (app/api/dev/seed-events/route.ts), which calls the ORDINARY
-- entities repository with a caller-supplied name, so nothing downstream
-- could tell it from a person. M12c stopped that particular string by
-- refusing labels containing digits (core/share/minimize.ts sanitizeLabel).
--
-- That fix was a spelling test, and it has a floor it cannot go below:
-- "TestPersonA" is letters, marks and nothing else, exactly like a name
-- somebody really has. Tightening the character class further would start
-- refusing real people before it refused test data. The distinguishing fact
-- was never in the characters — it is that one row was written because a
-- person said something and the other because a developer ran a script.
--
-- So the row records it.
--
--   user  the extraction pipeline created it from the person's own words.
--         The default, and what every existing row becomes.
--   demo  the demo fixture seeded it. PRESENTABLE ON PURPOSE: the seeded
--         demo is the product a reviewer is being shown, and George, John
--         and Simba are meant to appear.
--   dev   a development seeding route or test harness created it. Never
--         presented to a person.
--
-- BACKFILL, DELIBERATELY MINIMAL. Every existing row becomes 'user' — the
-- `default` on the column, applied by the ALTER. That is not a guess dressed
-- up as a migration: nothing stored today records provenance, so no SQL here
-- can prove that a given row came from the fixture or from a dev script, and
-- inventing a rule (a name pattern, an id shape) would be the very thing this
-- column exists to stop. Rows are therefore classified exactly as they behave
-- today, and nothing changes for anyone on deploy.
--
-- HOW EXISTING SEEDED George / John / Simba ARE CLASSIFIED. They are 'user'
-- until the next "Reset demo", which deletes and re-seeds them through
-- createEntityWithId — from that point they are 'demo'. Both values are
-- presentable, so their behaviour is identical either way; the reclassify
-- happens on an operation the operator ran on purpose, not silently underneath
-- them. Entities left behind by the dev evidence seeder are likewise 'user'
-- until re-seeded, and are re-created as 'dev' the next time that route runs.
-- Removing one is the existing `Reset demo`, not a hidden UPDATE in here.
-- RE-RUNNABLE, unlike the frozen schema files above it. Those are applied by
-- `supabase db reset` to an empty database and never twice; this one is
-- applied by hand to a live project, where a half-applied file is a real
-- outcome — the type created, the column not — and a re-run that dies on
-- "type already exists" leaves an operator guessing. Both statements below
-- are therefore safe to run again, and the result is the same either way.
do $$
begin
  create type public.entity_origin as enum ('user', 'demo', 'dev');
exception
  when duplicate_object then null;
end
$$;

alter table public.entities
  add column if not exists origin public.entity_origin not null default 'user';

comment on column public.entities.origin is
  'Who created this row: the extraction pipeline (user), the demo fixture (demo), or a development seeding route (dev). Read on the presentation path; dev rows are never shown to a person.';
