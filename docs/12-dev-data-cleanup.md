# Development data cleanup and the provenance migration (M12e)

Two things that look like one: a **column** the application reads, and a
**one-time manual cleanup** it deliberately does not.

## The column

`entities.origin` — `user | demo | dev` — records what created a row.

| value | written by | presentable to a person |
|---|---|---|
| `user` | the extraction pipeline, from something the person said (the column default) | yes |
| `demo` | the demo fixture, via `createEntityWithId` | **yes** — the seeded demo IS the product a reviewer is shown |
| `dev` | `/api/dev/seed-events` | no |

**One rule, two layers, every boundary** (M12e.3):

- `core/memory/provenance.ts` — `presentableEntity` / `presentableName`.
  Provenance first, then `sanitizeLabel`. The only place the decision is
  made.
- `entitiesRepo.listPresentableForUser` — the same rule again, `.neq("origin",
  "dev")` in the query, so a presentation path cannot hold a dev row at all.
  `listForUser` still returns everything and is still correct for entity
  RESOLUTION, which must match an existing row whatever created it.

Both, because neither is enough alone: the query is what stops a new caller
leaking one, and the code rule is what holds when a caller reaches for the
unfiltered read. `tests/unit/provenance-boundary.test.ts` tests each with the
other taken away, and pins which services may use which read.

This replaced a version that put the rule in `prepareOffer` and nowhere else.
A reviewer then saw "RECONNECT WITH TESTPERSONA" anyway, because the card
drawn on page load comes from `loadPendingOffer` — a different read, of an
opportunity created while the entity was still `user`. Nothing stored on an
opportunity or its proposal can reveal what its entity has since become; only
re-reading the entity can.

It exists because `sanitizeLabel` cannot close this gap and never could.
That rule is about characters — it refuses `M4ABSENCE1789574558` for having
digits — and `TestPersonA` is letters all the way through, exactly like a
name somebody has. Tightening the character class further starts refusing
real people before it refuses test data. Provenance is a different question,
and it needed somewhere to be stored.

## Why the migration backfills everything as `user`

Because nothing stored today records provenance, so **no SQL in that
migration can prove** that a given row came from the fixture or from a
script. Every rule that could be written — a name pattern, an id shape, a
join to something — is a guess, and a guess encoded in a migration is worse
than no rule at all, because it looks authoritative afterwards.

So the migration changes nobody's behaviour on deploy, and the honest
consequence is stated rather than hidden: **an alphabetic dev entity created
before the migration survives it as `user` and remains presentable.** Closing
that is a decision about which rows are litter, and only an operator looking
at the data can make it.

## Does `Reset demo` clean it up?

**No — it removes fixture-owned rows only, and nothing else.**

`resetDemoFixture` deletes by **deterministic id**: `fixtureUuid(specId,
userId, "entity/<key>")` for each entity in the spec, resolved through
`findEntityIds`. That is the ownership marker, and it is deliberately not the
display name — an earlier version claimed rows by matching names, which meant
a user who happened to know a real "John" had their own person adopted by the
demo and then deleted by the reset.

So:

| row | removed by `Reset demo`? |
|---|---|
| George, John, Simba (fixture ids) | **yes**, and re-seeded on the next start with `origin = 'demo'` |
| `TestPersonA` from `/api/dev/seed-events` | **no** — the reset has never heard of it |
| anything the extraction pipeline created | **no**, and correctly so |

It also does not touch conversations or messages: the operator typed those.
No decision row survives to be resurrected by a stale transcript, because the
entity delete cascades through events, relationships, signals, opportunities,
grants, requests, responses and closures.

## The cleanup, then

`supabase/snippets/m12e-dev-entity-cleanup.sql`. Human-run, in the Supabase
SQL editor, against a **development** project. Four steps, in order:

0. **Prove where you are.** Row counts and a user count. If it looks like a
   real project, stop.
1. **Inspect.** Every entity for one user id, with its origin and how many
   events, signals, opportunities and contacts hang off it. Writes nothing.
2. **Reclassify** the ids you chose to `dev`. Preferred: the rows stop being
   presentable everywhere a person could see them, and their interaction
   events — the history a baseline was being tested against — stay.
3. **Delete** the ids you chose, if you want the history gone too.
   Irreversible, and it cascades.
4. **Verify.** A count per origin with the names, so you can read the result.

You supply the ids. The file contains no name pattern — a rule that would not
be acceptable in runtime code is not one to run by hand against a database
either.

## Reaching the operator surface

The four conditions — local development, not a deployment, a configured
`CARELOOP_DEV_SEED_SECRET`, a loopback host — live in
`server/auth/operator-access.ts` and are asked by every surface that offers
an operator control.

- `/dev` — Reset demo, the family inbox, a link to `/debug`. A bare 404
  otherwise; the route does not advertise its own existence.
- `/` — the same two controls, as **Family view** and **Reset demo**, in the
  CareLoop header (M12f). No "(dev)", no "development only": the labels were
  what made a recording look like a workbench, and the gate is the same one
  `/dev` uses rather than the single condition the page checked before.

`Family view` links to the real local capability flow — the same component,
the same href. There is no second family UI.

## After cleanup

- `Reset demo` re-seeds George, John and Simba with `origin = 'demo'`; both
  `demo` and `user` are presentable, so nothing about their behaviour changes.
- `/api/dev/seed-events` stamps `origin = 'dev'` on everything it creates
  from now on, so this cleanup is a one-off rather than a habit.
- Nothing about production data was inferred, changed or guessed at.
