import { beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./pg-harness";

/**
 * The demo reset, against a real Postgres with the real migrations applied.
 *
 * The whole safety argument for the reset is a claim about the SCHEMA: that
 * deleting one entity retires an entire demo run, because the frozen cascades
 * already reach from an entity through events, relationships, signals,
 * opportunities, grants, requests, responses and closures. That claim cannot
 * be checked against a fake - a fake is where I would have written the cascade
 * I expected rather than the one that exists.
 */
const ALICE = "11111111-1111-1111-1111-111111111111";
const BOB = "22222222-2222-2222-2222-222222222222";

let h: Harness;

/** A full demo run for one user: entity, event, baseline, and the whole loop. */
async function demoRun(user: string, name: string) {
  const entity = (
    await h.query<{ id: string }>(
      `insert into public.entities (user_id, type, display_name)
       values ($1, 'person', $2) returning id`,
      [user, name],
    )
  )[0].id;

  await h.query(
    `insert into public.interaction_events
       (user_id, entity_id, event_type, occurred_at, occurred_at_precision,
        certainty, ingest_fingerprint)
     values ($1, $2, 'visit', now(), 'day', 0.9, $3)`,
    [user, entity, `fp-${name}-${user}`],
  );

  const baseline = (
    await h.query<{ id: string }>(
      `insert into public.baselines
         (user_id, entity_id, event_type, status, method_version, inputs_hash, computed_at)
       values ($1, $2, 'visit', 'NO_BASELINE', 'v1', 'hash', now()) returning id`,
      [user, entity],
    )
  )[0].id;

  const signal = (
    await h.query<{ id: string }>(
      `insert into public.signals (user_id, entity_id, baseline_id, signal_type, explanation)
       values ($1, $2, $3, 'cadence_gap', '{}'::jsonb) returning id`,
      [user, entity, baseline],
    )
  )[0].id;

  const opportunity = (
    await h.query<{ id: string }>(
      `insert into public.reconnect_opportunities
         (user_id, signal_id, entity_id, proposal, share_payload, rendered_text,
          rendered_text_hash, status, expires_at)
       values ($1, $2, $3, '{}'::jsonb, '{}'::jsonb, 'text', 'hash', 'approved',
               now() + interval '1 day')
       returning id`,
      [user, signal, entity],
    )
  )[0].id;

  await h.query(
    `insert into public.consent_grants
       (user_id, opportunity_id, scope, payload_snapshot, rendered_text_snapshot,
        rendered_text_hash, expires_at)
     values ($1, $2, '{}'::jsonb, '{}'::jsonb, 'text', 'hash', now() + interval '72 hours')`,
    [user, opportunity],
  );

  const contact = (
    await h.query<{ id: string }>(
      `insert into public.family_contacts (user_id, entity_id, channel, address)
       values ($1, $2, 'dev', $3) returning id`,
      [user, entity, `dev-inbox-${name}-${user}`],
    )
  )[0].id;

  const request = (
    await h.query<{ id: string }>(
      `insert into public.family_requests
         (opportunity_id, contact_id, rendered_body, rendered_body_hash, payload,
          access_token_hash, token_expires_at)
       values ($1, $2, 'text', 'hash', '{}'::jsonb, $3, now() + interval '7 days')
       returning id`,
      [opportunity, contact, `token-${name}-${user}`],
    )
  )[0].id;

  const response = (
    await h.query<{ id: string }>(
      `insert into public.family_responses (request_id, raw_body) values ($1, 'yes')
       returning id`,
      [request],
    )
  )[0].id;

  await h.query(
    `insert into public.closures (opportunity_id, response_id) values ($1, $2)`,
    [opportunity, response],
  );

  const episode = (
    await h.query<{ id: string }>(
      `insert into public.episodes (user_id, summary, occurred_at, occurred_at_precision)
       values ($1, $2, now(), 'day') returning id`,
      [user, `${name} came round.`],
    )
  )[0].id;
  await h.query(`insert into public.episode_entities (episode_id, entity_id) values ($1, $2)`, [
    episode,
    entity,
  ]);

  return { entity, episode, opportunity, request };
}

const count = async (sql: string, params: unknown[] = []) =>
  (await h.query<{ n: number }>(sql, params))[0].n;

beforeAll(async () => {
  h = await createHarness();
  await h.exec(`insert into auth.users (id) values ('${ALICE}'), ('${BOB}');`);
});

describe("1. deleting one demo entity retires the whole run", () => {
  it("cascades through events, signals, opportunities, consent and the family loop", async () => {
    const run = await demoRun(ALICE, "DemoPerson1");

    await h.exec(`delete from public.entities where id = '${run.entity}'`);

    expect(await count("select count(*)::int as n from public.interaction_events")).toBe(0);
    expect(await count("select count(*)::int as n from public.signals")).toBe(0);
    expect(await count("select count(*)::int as n from public.reconnect_opportunities")).toBe(0);
    expect(await count("select count(*)::int as n from public.consent_grants")).toBe(0);
    expect(await count("select count(*)::int as n from public.family_requests")).toBe(0);
    expect(await count("select count(*)::int as n from public.family_responses")).toBe(0);
    expect(await count("select count(*)::int as n from public.closures")).toBe(0);
    expect(await count("select count(*)::int as n from public.episode_entities")).toBe(0);
  });

  it("but does NOT take the episode with it — which is why reset deletes those by id", async () => {
    const run = await demoRun(ALICE, "DemoPerson2");
    await h.exec(`delete from public.entities where id = '${run.entity}'`);

    // The link row cascaded; the episode itself survived. A reset that only
    // deleted entities would leave orphaned demo memories behind, and the
    // second demo run would recall the first one's history.
    const orphan = await count(
      `select count(*)::int as n from public.episodes where id = '${run.episode}'`,
    );
    expect(orphan).toBe(1);
    await h.exec(`delete from public.episodes where id = '${run.episode}'`);
  });
});

describe("1b. identity is a caller-chosen id, not a name", () => {
  const FIXED = "aaaaaaaa-bbbb-8ccc-8ddd-eeeeeeeeeeee";

  it("an entity can be inserted with a deterministic id", async () => {
    await h.exec(
      `insert into public.entities (id, user_id, type, display_name)
       values ('${FIXED}', '${ALICE}', 'person', 'John')`,
    );
    expect(
      await count(`select count(*)::int as n from public.entities where id = '${FIXED}'`),
    ).toBe(1);
  });

  it("two rows can share a display name and remain separate rows", async () => {
    // Exactly the situation that broke the previous design: the user's own
    // John, and the fixture's. Same label, different identity.
    const theirs = (
      await h.query<{ id: string }>(
        `insert into public.entities (user_id, type, display_name)
         values ($1, 'person', 'John') returning id`,
        [ALICE],
      )
    )[0].id;

    expect(theirs).not.toBe(FIXED);
    await h.exec(`delete from public.entities where id = '${FIXED}'`);

    // The fixture's row is gone; the person's own John is untouched, and so
    // is everything that hangs off him.
    expect(
      await count(`select count(*)::int as n from public.entities where id = '${theirs}'`),
    ).toBe(1);
    await h.exec(`delete from public.entities where id = '${theirs}'`);
  });

  it("an episode deleted by id leaves an unrelated one that shares an entity", async () => {
    const entity = (
      await h.query<{ id: string }>(
        `insert into public.entities (user_id, type, display_name)
         values ($1, 'person', 'Shared') returning id`,
        [ALICE],
      )
    )[0].id;

    const ids: string[] = [];
    for (const summary of ["fixture memory", "the user's own memory"]) {
      const episode = (
        await h.query<{ id: string }>(
          `insert into public.episodes (user_id, summary, occurred_at, occurred_at_precision)
           values ($1, $2, now(), 'day') returning id`,
          [ALICE, summary],
        )
      )[0].id;
      await h.query(
        `insert into public.episode_entities (episode_id, entity_id) values ($1, $2)`,
        [episode, entity],
      );
      ids.push(episode);
    }

    // Deleting BY ID, not by what the episode references.
    await h.exec(`delete from public.episodes where user_id = '${ALICE}' and id = '${ids[0]}'`);

    expect(await count(`select count(*)::int as n from public.episodes where id = '${ids[1]}'`)).toBe(1);
    await h.exec(`delete from public.entities where id = '${entity}'`);
    await h.exec(`delete from public.episodes where id = '${ids[1]}'`);
  });
});

describe("1c. the profile is restored, not approximated", () => {
  it("both borrowed fields round-trip, including null", async () => {
    await h.exec(
      `insert into public.profiles (id, display_name, family_display_name)
       values ('${BOB}', 'Margaret Okonjo', 'Nana')`,
    );
    const [before] = await h.query<{ created_at: string }>(
      `select created_at from public.profiles where id = '${BOB}'`,
    );

    await h.exec(
      `update public.profiles set display_name = 'George', family_display_name = 'Dad'
        where id = '${BOB}'`,
    );
    await h.exec(
      `update public.profiles set display_name = 'Margaret Okonjo', family_display_name = 'Nana'
        where id = '${BOB}'`,
    );

    const [after] = await h.query<{
      display_name: string | null;
      family_display_name: string | null;
      created_at: string;
    }>(`select display_name, family_display_name, created_at from public.profiles where id = '${BOB}'`);

    expect(after.display_name).toBe("Margaret Okonjo");
    expect(after.family_display_name).toBe("Nana");
    // Nothing else moved.
    expect(after.created_at).toEqual(before.created_at);

    // And null restores as null rather than being skipped.
    await h.exec(
      `update public.profiles set display_name = null, family_display_name = null
        where id = '${BOB}'`,
    );
    const [nulled] = await h.query<{ display_name: string | null }>(
      `select display_name from public.profiles where id = '${BOB}'`,
    );
    expect(nulled.display_name).toBeNull();
    await h.exec(`delete from public.profiles where id = '${BOB}'`);
  });

  it("a fact anchored to an entity is not a user-level fact", async () => {
    // Where the manifest lives, and why: user-level facts are rendered into
    // the model's profile card, entity-anchored ones are not.
    const entity = (
      await h.query<{ id: string }>(
        `insert into public.entities (user_id, type, display_name)
         values ($1, 'person', 'Anchor') returning id`,
        [ALICE],
      )
    )[0].id;
    await h.exec(
      `insert into public.facts (user_id, subject_entity_id, key, value)
       values ('${ALICE}', '${entity}', 'demo.v1:manifest', '"{}"'::jsonb)`,
    );

    expect(
      await count(
        `select count(*)::int as n from public.facts
          where user_id = '${ALICE}' and subject_entity_id is null`,
      ),
    ).toBe(0);

    // And it cleans itself up with the entity it hangs on.
    await h.exec(`delete from public.entities where id = '${entity}'`);
    expect(await count(`select count(*)::int as n from public.facts where user_id = '${ALICE}'`)).toBe(0);
  });
});

describe("2. the reset is scoped to one user", () => {
  it("another user's identically named demo survives untouched", async () => {
    const mine = await demoRun(ALICE, "SharedName");
    const theirs = await demoRun(BOB, "SharedName");

    // Exactly what the repository does: scoped by user_id AND by id.
    await h.exec(
      `delete from public.episodes where user_id = '${ALICE}' and id = '${mine.episode}'`,
    );
    await h.exec(`delete from public.entities where user_id = '${ALICE}' and id = '${mine.entity}'`);

    expect(
      await count(`select count(*)::int as n from public.entities where id = '${theirs.entity}'`),
    ).toBe(1);
    expect(
      await count(`select count(*)::int as n from public.episodes where id = '${theirs.episode}'`),
    ).toBe(1);
    expect(
      await count(
        `select count(*)::int as n from public.family_requests where id = '${theirs.request}'`,
      ),
    ).toBe(1);
  });

  it("a delete scoped to the wrong user removes nothing", async () => {
    const theirs = await demoRun(BOB, "NotYours");
    const removed = await h.query<{ id: string }>(
      `delete from public.entities where user_id = $1 and id = $2 returning id`,
      [ALICE, theirs.entity],
    );
    expect(removed).toHaveLength(0);
    expect(
      await count(`select count(*)::int as n from public.entities where id = '${theirs.entity}'`),
    ).toBe(1);
  });
});

describe("2b. the state traversal reaches only the fixture's graph", () => {
  it("counts the fixture run and not the unrelated one, for the same user", async () => {
    // The live failure, at the level where it actually has to hold. Two full
    // runs for ONE user: the fixture's, and an earlier acceptance run that the
    // reset is correct to preserve. Counting by user_id conflates them.
    const fixture = await demoRun(ALICE, "FixtureJohn");
    const unrelated = await demoRun(ALICE, "MargaretFromBefore");

    const ids = `'${fixture.entity}'`;

    const scoped = async (sql: string) => (await h.query<{ n: number }>(sql))[0].n;

    expect(
      await scoped(
        `select count(*)::int as n from public.interaction_events
          where user_id = '${ALICE}' and entity_id in (${ids})`,
      ),
    ).toBe(1);
    expect(
      await scoped(
        `select count(*)::int as n from public.baselines
          where user_id = '${ALICE}' and entity_id in (${ids})`,
      ),
    ).toBe(1);

    // opportunity ids -> grants, requests, closures; request ids -> responses.
    const opportunityIds = (
      await h.query<{ id: string }>(
        `select id from public.reconnect_opportunities
          where user_id = '${ALICE}' and entity_id in (${ids})`,
      )
    ).map((row) => row.id);
    expect(opportunityIds).toEqual([fixture.opportunity]);

    expect(
      await scoped(
        `select count(*)::int as n from public.consent_grants
          where opportunity_id in ('${opportunityIds[0]}')`,
      ),
    ).toBe(1);
    expect(
      await scoped(
        `select count(*)::int as n from public.closures
          where opportunity_id in ('${opportunityIds[0]}')`,
      ),
    ).toBe(1);

    const requestIds = (
      await h.query<{ id: string }>(
        `select id from public.family_requests where opportunity_id in ('${opportunityIds[0]}')`,
      )
    ).map((row) => row.id);
    expect(requestIds).toEqual([fixture.request]);
    expect(
      await scoped(
        `select count(*)::int as n from public.family_responses
          where request_id in ('${requestIds[0]}')`,
      ),
    ).toBe(1);

    // Counting by user would have returned two of everything - which is
    // exactly what the operator saw.
    expect(
      await scoped(`select count(*)::int as n from public.consent_grants where user_id = '${ALICE}'`),
    ).toBe(2);

    // And the unrelated run is entirely intact.
    expect(
      await scoped(`select count(*)::int as n from public.entities where id = '${unrelated.entity}'`),
    ).toBe(1);
    await h.exec(`delete from public.entities where id in ('${fixture.entity}', '${unrelated.entity}')`);
    await h.exec(
      `delete from public.episodes where id in ('${fixture.episode}', '${unrelated.episode}')`,
    );
  });

  it("the latest positive event is the one reported, absences ignored", async () => {
    const run = await demoRun(ALICE, "LatestEvent");
    await h.query(
      `insert into public.interaction_events
         (user_id, entity_id, event_type, occurred_at, occurred_at_precision, certainty,
          polarity, window_start, window_end, ingest_fingerprint)
       values ($1, $2, 'visit', now(), 'day', 0.9, 'absence',
               now() - interval '7 days', now(), 'absence-fp')`,
      [ALICE, run.entity],
    );

    const [row] = await h.query<{ polarity: string }>(
      `select polarity from public.interaction_events
        where user_id = $1 and entity_id = $2 and event_type = 'visit' and polarity = 'positive'
        order by occurred_at desc limit 1`,
      [ALICE, run.entity],
    );
    expect(row.polarity).toBe("positive");

    await h.exec(`delete from public.entities where id = '${run.entity}'`);
    await h.exec(`delete from public.episodes where id = '${run.episode}'`);
  });
});

describe("3. the fixture needs no schema of its own", () => {
  it("every table the fixture writes already exists in the frozen schema", async () => {
    const rows = await h.query<{ table_name: string }>(
      `select table_name from information_schema.tables
        where table_schema = 'public'
          and table_name in ('profiles','entities','relationships','facts','episodes',
                             'episode_entities','interaction_events','baselines')`,
    );
    expect(rows).toHaveLength(8);
  });

  it("the demo added no migration", async () => {
    // M6 is a fixture, not a schema change. If this ever needs to grow, that
    // is a conversation, not a commit.
    // Named rather than counted (M12e): the claim is "M6 added nothing", and
    // a count says that only until somebody else adds one. Every migration
    // below belongs to an earlier or a later milestone, and none to the demo.
    const { readdirSync } = await import("node:fs");
    const migrations = readdirSync("supabase/migrations").filter((f) => f.endsWith(".sql"));
    expect(migrations.filter((f) => /demo|fixture|george/i.test(f))).toEqual([]);
    expect(migrations.sort()).toEqual([
      "20260916120000_init_schema.sql",
      "20260916120100_rls.sql",
      "20260916130000_m2_ingestion_support.sql",
      "20260916140000_m4_materialize_signal.sql",
      "20260916150000_m5_consent_and_family.sql",
      "20260921120000_m12e_entity_provenance.sql",
      "20260921120100_m12e_wellbeing_signal.sql",
    ]);
  });
});
