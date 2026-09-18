import { beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./pg-harness";

/**
 * RLS AS BEHAVIOUR, not as SQL somebody wrote once.
 *
 * Every policy in this project was previously asserted by reading the
 * migration: the words `auth.uid()` appear, therefore ownership is enforced.
 * That is not a test. `auth.uid()` was stubbed to return null in the harness,
 * the `authenticated` role was never assumed, and no policy had ever actually
 * decided anything.
 *
 * It matters more now than it did. Supabase ANONYMOUS users take the ordinary
 * `authenticated` Postgres role - the same role these policies name - so every
 * public-demo reviewer is, to Postgres, exactly the kind of caller these
 * policies exist to constrain. CareLoop does not query from the browser, so
 * this is defence in depth rather than the primary control; the point of
 * defence in depth is that it works when the primary control does not.
 *
 * Each test below BECOMES a user and lets the real policies answer.
 */
const A = "11111111-2222-4333-8444-555555555555";
const B = "99999999-8888-4777-8666-555555555555";

let h: Harness;

/** A whole owned graph for one user, written as the trusted role. */
async function seed(user: string, name: string) {
  await h.query(`insert into auth.users (id) values ($1) on conflict do nothing`, [user]);

  const entity = (
    await h.query<{ id: string }>(
      `insert into public.entities (user_id, type, display_name)
       values ($1, 'person', $2) returning id`,
      [user, name],
    )
  )[0].id;

  const conversation = (
    await h.query<{ id: string }>(
      `insert into public.conversations (user_id) values ($1) returning id`,
      [user],
    )
  )[0].id;

  await h.query(
    `insert into public.messages (conversation_id, role, content)
     values ($1, 'user', $2)`,
    [conversation, `private to ${user}`],
  );

  await h.query(
    `insert into public.profiles (id, display_name) values ($1, $2)
     on conflict (id) do update set display_name = excluded.display_name`,
    [user, name],
  );

  return { entity, conversation };
}

const countAs = (user: string | null, sql: string, params: unknown[] = []) =>
  h.asUser(user, async () => (await h.query<{ n: number }>(sql, params))[0].n);

/** As service_role, which bypasses RLS: what is REALLY in the table. */
const count = async (sql: string, params: unknown[] = []) =>
  (await h.query<{ n: number }>(sql, params))[0].n;

beforeAll(async () => {
  h = await createHarness();
  await seed(A, "A's person");
  await seed(B, "B's person");
});

describe("1. a signed-in user sees their own rows, by policy", () => {
  it("the policies are live: A reads A's entity", async () => {
    // If this returned 0 the harness would be wrong, and every negative test
    // below would pass for the wrong reason.
    expect(
      await countAs(A, `select count(*)::int as n from public.entities where user_id = $1`, [A]),
    ).toBe(1);
  });

  it("and the role really is constrained", async () => {
    // `authenticated` has no BYPASSRLS. Selecting the whole table returns only
    // what the policy allows, which is the one row A owns.
    expect(await countAs(A, `select count(*)::int as n from public.entities`)).toBe(1);
  });
});

describe("2. one user cannot reach another's rows", () => {
  const OWNED = [
    ["entities", "user_id"],
    ["conversations", "user_id"],
    ["profiles", "id"],
  ] as const;

  it.each(OWNED)("A cannot see B's %s, even asking for them by id", async (table, column) => {
    expect(
      await countAs(A, `select count(*)::int as n from public.${table} where ${column} = $1`, [B]),
    ).toBe(0);
    // And B can, which proves the row exists and the predicate is not simply
    // matching nothing.
    expect(
      await countAs(B, `select count(*)::int as n from public.${table} where ${column} = $1`, [B]),
    ).toBe(1);
  });

  it("A cannot read B's messages, whose ownership is only reachable by join", async () => {
    // messages carries no user_id; the policy proves ownership through
    // conversations. A weaker policy here would leak the transcript.
    expect(await countAs(A, `select count(*)::int as n from public.messages`)).toBe(1);
    const mine = await h.asUser(A, () =>
      h.query<{ content: string }>(`select content from public.messages`),
    );
    expect(mine.every((row) => !row.content.includes(B))).toBe(true);
  });

  it("an anonymous caller with no session sees nothing at all", async () => {
    // auth.uid() is null, so every `= auth.uid()` predicate fails closed.
    for (const table of ["entities", "conversations", "messages", "profiles"]) {
      expect(await countAs(null, `select count(*)::int as n from public.${table}`), table).toBe(0);
    }
  });
});

describe("3. a signed-in user cannot write anything", () => {
  /**
   * There are no INSERT, UPDATE or DELETE policies anywhere, which means every
   * write is denied for `authenticated` - including to one's own rows. That is
   * deliberate: there is no client write surface, so there is none to get
   * wrong. These tests hold that shut, because "we never added a write policy"
   * is a fact about today and this is the thing that notices tomorrow.
   */
  it("cannot insert, even as the owner", async () => {
    await expect(
      h.asUser(A, () =>
        h.query(`insert into public.entities (user_id, type, display_name) values ($1,'person','x')`, [A]),
      ),
    ).rejects.toThrow();
  });

  /**
   * UPDATE and DELETE do NOT raise here, and that surprised me into checking.
   * With RLS on and no permissive policy for those commands, the rows are
   * simply not visible to modify, so the statement succeeds and affects zero
   * rows - Postgres only raises for an INSERT (or an UPDATE's WITH CHECK) that
   * would create a row the policy forbids. So the assertion is "nothing
   * changed", which is the property that actually protects the data; asserting
   * a throw would have been asserting my assumption about Postgres.
   */
  it("an update as the owner changes nothing", async () => {
    const changed = await h.asUser(A, () =>
      h.query(
        `update public.entities set display_name = 'renamed' where user_id = $1 returning id`,
        [A],
      ),
    );
    expect(changed).toHaveLength(0);
    expect(
      await count(`select count(*)::int as n from public.entities where display_name = 'renamed'`),
    ).toBe(0);
  });

  it("a delete as the owner removes nothing", async () => {
    const before = await count(`select count(*)::int as n from public.entities`);
    const removed = await h.asUser(A, () =>
      h.query(`delete from public.entities where user_id = $1 returning id`, [A]),
    );
    expect(removed).toHaveLength(0);
    expect(await count(`select count(*)::int as n from public.entities`)).toBe(before);
  });

  it("and another user's row is equally untouchable", async () => {
    const changed = await h.asUser(A, () =>
      h.query(
        `update public.entities set display_name = 'hijacked' where user_id = $1 returning id`,
        [B],
      ),
    );
    expect(changed).toHaveLength(0);
    // Checked as the TRUSTED role, so the absence is real rather than merely
    // invisible to A.
    expect(
      await count(`select count(*)::int as n from public.entities where display_name = 'hijacked'`),
    ).toBe(0);
  });
});

describe("4. infrastructure and machinery are not user data", () => {
  it("jobs has RLS on and no policy, so it is closed to everyone", async () => {
    // A ROW HAS TO EXIST for the read to mean anything. Counting an empty
    // table returns 0 whether or not a policy is protecting it - which is how
    // the first version of this test passed while `jobs` was wide open.
    await h.query(`insert into public.jobs (kind, key) values ('ingest', $1)`, [
      `rls-probe-${Date.now()}`,
    ]);
    expect(await count(`select count(*)::int as n from public.jobs`)).toBeGreaterThan(0);

    expect(await countAs(A, `select count(*)::int as n from public.jobs`)).toBe(0);
    expect(await countAs(null, `select count(*)::int as n from public.jobs`)).toBe(0);

    // An INSERT is the case that does raise: it would create a row no policy
    // permits.
    await expect(
      h.asUser(A, () => h.query(`insert into public.jobs (kind, key) values ('ingest', 'x')`)),
    ).rejects.toThrow();
  });

  it("no CareLoop function may be executed by a signed-in user", async () => {
    /**
     * Every RPC grants EXECUTE to service_role only, and a signed-in caller
     * reaching `materialize_signal` could mint an opportunity for any user id
     * it liked.
     *
     * The failure must be a PERMISSION failure. An earlier version asserted
     * only "it throws", which survived granting EXECUTE to `authenticated` -
     * the call then failed for an unrelated reason and the test was happy.
     */
    const calls: Array<[string, unknown[]]> = [
      [`select public.claim_ingest_jobs(1, 30)`, []],
      [
        `select public.match_episodes($1, array_fill(0.1::real, array[1536])::extensions.vector, 5)`,
        [A],
      ],
      [`select public.materialize_signal($1, $2, $3, '{}'::jsonb, now(), now())`, [A, A, A]],
      [`select public.record_family_response($1, 'yes', '{}'::jsonb, now())`, [A]],
    ];

    for (const [call, params] of calls) {
      let message = "";
      try {
        await h.asUser(A, () => h.query(call, params));
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message, `${call} did not fail at all`).not.toBe("");
      expect(message.toLowerCase(), `${call} failed for the wrong reason`).toContain("permission denied");
    }
  });
});
