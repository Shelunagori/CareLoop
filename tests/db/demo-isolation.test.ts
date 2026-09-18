import { beforeAll, describe, expect, it } from "vitest";
import { fixtureUuid } from "@/server/services/demo-fixture";
import { DEMO_GEORGE } from "@/fixtures/demo/george";
import { createHarness, type Harness } from "./pg-harness";

/**
 * TWO REVIEWERS, TWO WORLDS — against the real schema.
 *
 * The public demo hands every visitor their own anonymous Supabase user and
 * seeds George into it. That only works if "George" is not a shared row, and
 * that claim is enforced in exactly one place: `user_id` columns and the
 * predicates the repositories put on them. So it is proved here, against real
 * Postgres with the real migrations, and not against the memory fakes — those
 * carry no `user_id` at all, so an isolation test written over them would pass
 * while proving nothing, which is the most expensive kind of green.
 *
 * The ids are the fixture's OWN derivation, `fixtureUuid(fixtureId, userId,
 * key)`, because that derivation is the mechanism under test. If it ever
 * stopped including the user, two reviewers would collide on the primary key
 * and this file would say so.
 */
const A = "11111111-2222-4333-8444-555555555555";
const B = "99999999-8888-4777-8666-555555555555";
const KEYS = ["entity/john", "entity/simba"] as const;

let h: Harness;

const id = (user: string, key: string) => fixtureUuid(DEMO_GEORGE.id, user, key);

const count = async (sql: string, params: unknown[] = []) =>
  (await h.query<{ n: number }>(sql, params))[0].n;

/**
 * One reviewer's whole world: the cast, a conversation, history, and the loop.
 *
 * Idempotent, because these tests share one database and a reviewer restarting
 * is exactly "reset, then seed again" - so seeding begins by clearing this
 * user's own fixture rows and nobody else's.
 */
async function seedWorld(user: string) {
  await h.query(`insert into auth.users (id) values ($1) on conflict do nothing`, [user]);
  await resetWorld(user);

  for (const key of KEYS) {
    await h.query(
      `insert into public.entities (id, user_id, type, display_name)
       values ($1, $2, 'person', $3)`,
      [id(user, key), user, key.split("/")[1]],
    );
  }

  const john = id(user, "entity/john");

  await h.query(
    `insert into public.interaction_events
       (user_id, entity_id, event_type, occurred_at, occurred_at_precision,
        certainty, ingest_fingerprint)
     values ($1, $2, 'visit', now() - interval '20 days', 'day', 0.9, $3)`,
    [user, john, `fp-${user}-${Date.now()}-${Math.random()}`],
  );

  const conversation = (
    await h.query<{ id: string }>(
      `insert into public.conversations (user_id) values ($1) returning id`,
      [user],
    )
  )[0].id;

  await h.query(
    `insert into public.messages (conversation_id, role, content)
     values ($1, 'user', $2)`,
    [conversation, `I haven't seen John this week (${user}).`],
  );

  const signal = (
    await h.query<{ id: string }>(
      `insert into public.signals (user_id, entity_id, signal_type, explanation)
       values ($1, $2, 'cadence_gap', '{}'::jsonb) returning id`,
      [user, john],
    )
  )[0].id;

  const opportunity = (
    await h.query<{ id: string }>(
      `insert into public.reconnect_opportunities
         (user_id, signal_id, entity_id, proposal, share_payload, rendered_text,
          rendered_text_hash, status, expires_at)
       values ($1, $2, $3, '{}'::jsonb, '{}'::jsonb, $4, $5, 'drafted',
               now() + interval '1 day')
       returning id`,
      [user, signal, john, `Dad was wondering — could you visit? (${user})`, `hash-${user}`],
    )
  )[0].id;

  return { john, conversation, signal, opportunity };
}

/** Exactly what the reset does: scoped by user_id AND by the fixture's ids. */
async function resetWorld(user: string) {
  await h.query(`delete from public.entities where user_id = $1 and id = any($2::uuid[])`, [
    user,
    KEYS.map((key) => id(user, key)),
  ]);
}

beforeAll(async () => {
  h = await createHarness();
});

describe("1. the fixture's ids are per reviewer, by construction", () => {
  it("the same logical person is a different row for each user", () => {
    expect(id(A, "entity/john")).not.toBe(id(B, "entity/john"));
    // Stable for one user, so a reseed writes the same row rather than a new one.
    expect(id(A, "entity/john")).toBe(id(A, "entity/john"));
  });

  it("two reviewers can hold the same cast at once without colliding", async () => {
    await seedWorld(A);
    await seedWorld(B);

    // Same names...
    expect(
      await count(`select count(*)::int as n from public.entities where display_name = 'john'`),
    ).toBe(2);
    // ...different rows, each owned.
    expect(
      await count(`select count(*)::int as n from public.entities where user_id = $1`, [A]),
    ).toBe(KEYS.length);
    expect(
      await count(`select count(*)::int as n from public.entities where user_id = $1`, [B]),
    ).toBe(KEYS.length);
  });
});

describe("2. nothing one reviewer does appears in the other's read models", () => {
  it("A's message is not in B's conversation", async () => {
    const [a, b] = [await worldOf(A), await worldOf(B)];
    expect(a.conversation).not.toBe(b.conversation);

    const inB = await h.query<{ content: string }>(
      `select m.content from public.messages m
       join public.conversations c on c.id = m.conversation_id
       where c.user_id = $1`,
      [B],
    );
    expect(inB.every((row) => !row.content.includes(A))).toBe(true);
    expect(inB.some((row) => row.content.includes(B))).toBe(true);
  });

  it("A's opportunity is not one of B's", async () => {
    const mine = await h.query<{ id: string }>(
      `select id from public.reconnect_opportunities where user_id = $1`,
      [A],
    );
    const theirs = await h.query<{ id: string }>(
      `select id from public.reconnect_opportunities where user_id = $1`,
      [B],
    );

    expect(mine.length).toBeGreaterThan(0);
    expect(theirs.length).toBeGreaterThan(0);
    const mineIds = new Set(mine.map((row) => row.id));
    expect(theirs.some((row) => mineIds.has(row.id))).toBe(false);
  });

  it("a read scoped to the wrong user returns nothing at all", async () => {
    const john = id(A, "entity/john");
    expect(
      await count(`select count(*)::int as n from public.entities where user_id = $1 and id = $2`, [
        B,
        john,
      ]),
    ).toBe(0);
  });
});

describe("3. a restart restores one world and leaves the other alone", () => {
  it("A's reset takes A's whole graph and nothing of B's", async () => {
    const beforeB = await count(`select count(*)::int as n from public.entities where user_id = $1`, [B]);
    const bOpportunities = await count(
      `select count(*)::int as n from public.reconnect_opportunities where user_id = $1`,
      [B],
    );

    await resetWorld(A);

    // Gone for A, including everything the schema cascades from the entity.
    expect(await count(`select count(*)::int as n from public.entities where user_id = $1`, [A])).toBe(0);
    expect(
      await count(`select count(*)::int as n from public.reconnect_opportunities where user_id = $1`, [A]),
    ).toBe(0);
    expect(
      await count(`select count(*)::int as n from public.interaction_events where user_id = $1`, [A]),
    ).toBe(0);

    // Untouched for B.
    expect(await count(`select count(*)::int as n from public.entities where user_id = $1`, [B])).toBe(
      beforeB,
    );
    expect(
      await count(`select count(*)::int as n from public.reconnect_opportunities where user_id = $1`, [B]),
    ).toBe(bOpportunities);
  });

  it("A can start over, and B's world is still B's", async () => {
    await seedWorld(A);
    expect(await count(`select count(*)::int as n from public.entities where user_id = $1`, [A])).toBe(
      KEYS.length,
    );

    await resetWorld(B);
    expect(await count(`select count(*)::int as n from public.entities where user_id = $1`, [B])).toBe(0);
    // B's reset did not reach into A's fresh world.
    expect(await count(`select count(*)::int as n from public.entities where user_id = $1`, [A])).toBe(
      KEYS.length,
    );
  });

  it("a reset aimed at another user's ids removes nothing", async () => {
    await seedWorld(B);
    // The ids are A's derivation; the predicate says B. Both halves matter.
    const removed = await h.query<{ id: string }>(
      `delete from public.entities where user_id = $1 and id = any($2::uuid[]) returning id`,
      [B, KEYS.map((key) => id(A, key))],
    );
    expect(removed).toHaveLength(0);
    expect(await count(`select count(*)::int as n from public.entities where user_id = $1`, [B])).toBe(
      KEYS.length,
    );
  });
});

async function worldOf(user: string) {
  const conversation = (
    await h.query<{ id: string }>(
      `select id from public.conversations where user_id = $1 order by started_at limit 1`,
      [user],
    )
  )[0].id;
  return { conversation };
}

describe("4. each reviewer's email contact is their own", () => {
  const EMAIL_A = "a@example.test";
  const EMAIL_B = "b@example.test";

  /** Exactly what the demo's setup action writes. */
  const configure = (user: string, email: string) =>
    h.query(
      `insert into public.family_contacts (user_id, entity_id, channel, address, display_name)
       values ($1, $2, 'email', $3, 'John')
       on conflict (user_id, entity_id, channel, address) do nothing`,
      [user, id(user, "entity/john"), email],
    );

  /** Exactly what production send does: (user, entity, channel), never a name. */
  const resolve = async (user: string) =>
    (
      await h.query<{ address: string }>(
        `select address from public.family_contacts
         where user_id = $1 and entity_id = $2 and channel = 'email'`,
        [user, id(user, "entity/john")],
      )
    ).map((row) => row.address);

  it("A's reconnect resolves only A's address, and B's only B's", async () => {
    await seedWorld(A);
    await seedWorld(B);
    await configure(A, EMAIL_A);
    await configure(B, EMAIL_B);

    expect(await resolve(A)).toEqual([EMAIL_A]);
    expect(await resolve(B)).toEqual([EMAIL_B]);
  });

  it("an approval for A can never address B", async () => {
    // The entity id is the whole binding. A's John and B's John are different
    // rows, so there is no query shape that reaches across.
    expect(
      await count(
        `select count(*)::int as n from public.family_contacts
         where user_id = $1 and address = $2`,
        [A, EMAIL_B],
      ),
    ).toBe(0);
    expect(
      await count(
        `select count(*)::int as n from public.family_contacts where entity_id = $1`,
        [id(B, "entity/john")],
      ),
    ).toBe(1);
  });

  it("a reset deletes the contact with the entity, which is why it is restored", async () => {
    // The cascade is the reason the reset has to read the address first: this
    // is the row disappearing.
    await resetWorld(A);
    expect(await resolve(A)).toEqual([]);
    // B untouched.
    expect(await resolve(B)).toEqual([EMAIL_B]);
  });

  it("A's restart gives A back A's address, and leaves B's alone", async () => {
    // The restart: read, reset, reseed, re-bind. The derived id is stable, so
    // the address re-attaches to the same logical John.
    await seedWorld(A);
    await configure(A, EMAIL_A);

    expect(await resolve(A)).toEqual([EMAIL_A]);
    expect(await resolve(B)).toEqual([EMAIL_B]);

    // And B restarting does not disturb A.
    await resetWorld(B);
    await seedWorld(B);
    await configure(B, EMAIL_B);
    expect(await resolve(A)).toEqual([EMAIL_A]);
    expect(await resolve(B)).toEqual([EMAIL_B]);
  });

  it("A's token cannot read B's request", async () => {
    // Token lookup is by hash, and a hash belongs to exactly one request row.
    const requestOf = async (user: string) => {
      const john = id(user, "entity/john");
      const contact = (
        await h.query<{ id: string }>(
          `select id from public.family_contacts where user_id = $1 and entity_id = $2 and channel = 'email'`,
          [user, john],
        )
      )[0].id;
      const opportunity = (
        await h.query<{ id: string }>(
          `select id from public.reconnect_opportunities where user_id = $1 and entity_id = $2 limit 1`,
          [user, john],
        )
      )[0].id;
      return (
        await h.query<{ id: string }>(
          `insert into public.family_requests
             (opportunity_id, contact_id, rendered_body, rendered_body_hash, payload,
              access_token_hash, token_expires_at)
           values ($1, $2, 'text', 'hash', '{}'::jsonb, $3, now() + interval '7 days')
           returning id`,
          [opportunity, contact, `hash-${user}`],
        )
      )[0].id;
    };

    const requestA = await requestOf(A);
    const requestB = await requestOf(B);
    expect(requestA).not.toBe(requestB);

    // A's hash finds A's request and nothing else.
    const found = await h.query<{ id: string }>(
      `select id from public.family_requests where access_token_hash = $1`,
      [`hash-${A}`],
    );
    expect(found.map((row) => row.id)).toEqual([requestA]);
  });
});
