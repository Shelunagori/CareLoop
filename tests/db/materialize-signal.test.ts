import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { createHarness, materializeCaller, type Harness } from "./pg-harness";

/**
 * Invariant tests for public.materialize_signal, against a real Postgres with
 * the real migrations applied.
 *
 * The function runs as service_role, which has BYPASSRLS, and the frozen
 * schema gives signals, entities and opportunities INDEPENDENT foreign keys to
 * auth.users. Nothing structurally ties a signal's entity to the signal's
 * user. So every argument is untrusted, and most of what follows is about the
 * function establishing identity for itself before it locks, reads back or
 * writes anything.
 */
const ALICE = "11111111-1111-1111-1111-111111111111";
const BOB = "22222222-2222-2222-2222-222222222222";
const JOHN = "aaaaaaaa-0000-0000-0000-000000000001"; // Alice's entity
const MARY = "aaaaaaaa-0000-0000-0000-000000000002"; // Alice's entity
const BOBS_SON = "bbbbbbbb-0000-0000-0000-000000000001"; // Bob's entity
const MISSING = "99999999-9999-9999-9999-999999999999";

const NOW = "2026-09-16T12:00:00.000Z";
const LATER = "2026-09-17T12:00:00.000Z";
const EARLIER = "2026-09-16T11:00:00.000Z";

let h: Harness;
let materialize: ReturnType<typeof materializeCaller>;

async function newSignal(input: {
  userId: string;
  entityId: string;
  type?: "cadence_gap" | "user_asserted_absence";
}): Promise<string> {
  const rows = await h.query<{ id: string }>(
    `insert into public.signals (user_id, entity_id, signal_type, explanation)
     values ($1, $2, $3, '{"detector":"test"}'::jsonb) returning id`,
    [input.userId, input.entityId, input.type ?? "cadence_gap"],
  );
  return rows[0].id;
}

const opportunityCount = async (): Promise<number> => {
  const rows = await h.query<{ c: number }>(
    "select count(*)::int as c from public.reconnect_opportunities",
  );
  return rows[0].c;
};

const signalRow = async (id: string) =>
  (
    await h.query<{ status: string; materialized_at: string | null; entity_id: string }>(
      "select status, materialized_at, entity_id from public.signals where id = $1",
      [id],
    )
  )[0];

beforeAll(async () => {
  h = await createHarness();
  materialize = materializeCaller(h);
  await h.exec(`
    insert into auth.users (id) values ('${ALICE}'), ('${BOB}');
    insert into public.entities (id, user_id, type, display_name) values
      ('${JOHN}', '${ALICE}', 'person', 'John'),
      ('${MARY}', '${ALICE}', 'person', 'Mary'),
      ('${BOBS_SON}', '${BOB}', 'person', 'Sam');
  `);
});

describe("0. the migrations apply, in order, on a clean database", () => {
  it("applies all four", () => {
    expect(h.appliedMigrations).toEqual([
      "20260916120000_init_schema.sql",
      "20260916120100_rls.sql",
      "20260916130000_m2_ingestion_support.sql",
      "20260916140000_m4_materialize_signal.sql",
    ]);
  });
});

describe("1. identity is established before anything else happens", () => {
  it("a signal that is not this user's is `signal_not_found`, and says nothing more", async () => {
    const before = await opportunityCount();
    const alicesSignal = await newSignal({ userId: ALICE, entityId: JOHN });

    const result = await materialize({
      signalId: alicesSignal, userId: BOB, entityId: JOHN, expiresAt: LATER, now: NOW,
    });

    // Indistinguishable from an id that does not exist at all.
    expect(result).toEqual({ outcome: "signal_not_found", opportunityId: null });
    expect(
      await materialize({ signalId: MISSING, userId: BOB, entityId: JOHN, expiresAt: LATER, now: NOW }),
    ).toEqual({ outcome: "signal_not_found", opportunityId: null });
    expect(await opportunityCount()).toBe(before);
    expect((await signalRow(alicesSignal)).status).toBe("detected");
  });

  it("an ownership failure is answered BEFORE any existing opportunity is disclosed", async () => {
    // Alice legitimately materializes one...
    const signal = await newSignal({ userId: ALICE, entityId: MARY });
    const mine = await materialize({
      signalId: signal, userId: ALICE, entityId: MARY, expiresAt: LATER, now: NOW,
    });
    expect(mine.outcome).toBe("materialized");

    // ...and Bob naming the same signal learns nothing about it. This is the
    // ordering the audit asked for: the replay lookup used to run first, so a
    // mismatched caller could have been handed another user's opportunity id.
    const theirs = await materialize({
      signalId: signal, userId: BOB, entityId: MARY, expiresAt: LATER, now: NOW,
    });
    expect(theirs).toEqual({ outcome: "signal_not_found", opportunityId: null });
    expect(theirs.opportunityId).not.toBe(mine.opportunityId);

    await h.exec(`delete from public.reconnect_opportunities where signal_id = '${signal}'`);
    await h.exec(`update public.signals set status = 'detected', materialized_at = null where id = '${signal}'`);
  });

  it("a caller-supplied entity that is not the signal's entity is refused", async () => {
    const before = await opportunityCount();
    const signal = await newSignal({ userId: ALICE, entityId: JOHN });

    const result = await materialize({
      signalId: signal, userId: ALICE, entityId: MARY, expiresAt: LATER, now: NOW,
    });

    expect(result).toEqual({ outcome: "signal_entity_mismatch", opportunityId: null });
    expect(await opportunityCount()).toBe(before);
    expect((await signalRow(signal)).status).toBe("detected");
  });

  it("an entity belonging to another user is refused, even when named consistently", async () => {
    const before = await opportunityCount();
    // The schema permits this row: signals.user_id and entities.user_id are
    // independent FKs, so a signal for Alice can point at Bob's entity.
    const crossed = await newSignal({ userId: ALICE, entityId: BOBS_SON });

    const result = await materialize({
      signalId: crossed, userId: ALICE, entityId: BOBS_SON, expiresAt: LATER, now: NOW,
    });

    expect(result).toEqual({ outcome: "entity_not_found", opportunityId: null });
    expect(await opportunityCount()).toBe(before);
  });

  it("an entity id that does not exist at all is refused", async () => {
    const signal = await newSignal({ userId: ALICE, entityId: JOHN });
    const result = await materialize({
      signalId: signal, userId: ALICE, entityId: MISSING, expiresAt: LATER, now: NOW,
    });
    // Caught by the mismatch check, which runs first — the id never reaches
    // the entities table, and never reaches a lock name.
    expect(result).toEqual({ outcome: "signal_entity_mismatch", opportunityId: null });
  });
});

describe("2. the offerability window must be structurally sane", () => {
  it("refuses expires_at in the past", async () => {
    const before = await opportunityCount();
    const signal = await newSignal({ userId: ALICE, entityId: JOHN });
    expect(
      await materialize({ signalId: signal, userId: ALICE, entityId: JOHN, expiresAt: EARLIER, now: NOW }),
    ).toEqual({ outcome: "invalid_expiry", opportunityId: null });
    expect(await opportunityCount()).toBe(before);
    expect((await signalRow(signal)).status).toBe("detected");
  });

  it("refuses expires_at exactly equal to now", async () => {
    const signal = await newSignal({ userId: ALICE, entityId: JOHN });
    expect(
      await materialize({ signalId: signal, userId: ALICE, entityId: JOHN, expiresAt: NOW, now: NOW }),
    ).toEqual({ outcome: "invalid_expiry", opportunityId: null });
  });

  it("accepts a window that is still open", async () => {
    const signal = await newSignal({ userId: ALICE, entityId: JOHN });
    const result = await materialize({
      signalId: signal, userId: ALICE, entityId: JOHN, expiresAt: LATER, now: NOW,
    });
    expect(result.outcome).toBe("materialized");
    expect(result.opportunityId).toBeTruthy();
  });
});

describe("3. materialization is one transaction and one opportunity", () => {
  it("writes the opportunity and the signal transition together", async () => {
    await h.exec("delete from public.reconnect_opportunities; delete from public.signals;");
    const signal = await newSignal({ userId: ALICE, entityId: JOHN });

    const result = await materialize({
      signalId: signal, userId: ALICE, entityId: JOHN, expiresAt: LATER, now: NOW,
    });

    expect(result.outcome).toBe("materialized");
    const row = await signalRow(signal);
    expect(row.status).toBe("materialized");
    expect(row.materialized_at).not.toBeNull();

    const opportunity = (
      await h.query<{ status: string; entity_id: string; user_id: string; expires_at: string }>(
        "select status, entity_id, user_id, expires_at from public.reconnect_opportunities where signal_id = $1",
        [signal],
      )
    )[0];
    expect(opportunity.status).toBe("proposed");
    // Written from the VERIFIED signal entity, not from the argument.
    expect(opportunity.entity_id).toBe(JOHN);
    expect(opportunity.user_id).toBe(ALICE);
  });

  it("a replay reloads the same opportunity rather than creating a second", async () => {
    const signal = (
      await h.query<{ signal_id: string }>(
        "select signal_id from public.reconnect_opportunities limit 1",
      )
    )[0].signal_id;
    const first = await h.query<{ id: string }>(
      "select id from public.reconnect_opportunities where signal_id = $1",
      [signal],
    );

    const replay = await materialize({
      signalId: signal, userId: ALICE, entityId: JOHN, expiresAt: LATER, now: NOW,
    });

    expect(replay.outcome).toBe("reloaded");
    expect(replay.opportunityId).toBe(first[0].id);
    expect(await opportunityCount()).toBe(1);
  });

  it("a second signal for the same entity is blocked while one is open", async () => {
    const second = await newSignal({ userId: ALICE, entityId: JOHN, type: "user_asserted_absence" });

    const result = await materialize({
      signalId: second, userId: ALICE, entityId: JOHN, expiresAt: LATER, now: NOW,
    });

    expect(result).toEqual({ outcome: "blocked_open_opportunity", opportunityId: null });
    expect(await opportunityCount()).toBe(1);
    // Left `detected`, for the caller to record as suppressed with a reason.
    expect((await signalRow(second)).status).toBe("detected");
  });

  it("a signal that is not `detected` cannot materialize", async () => {
    const suppressed = await newSignal({ userId: ALICE, entityId: MARY });
    await h.exec(
      `update public.signals set status = 'suppressed', suppression_reason = 'offer_cooldown'
       where id = '${suppressed}'`,
    );
    const result = await materialize({
      signalId: suppressed, userId: ALICE, entityId: MARY, expiresAt: LATER, now: NOW,
    });
    expect(result.outcome).toBe("signal_not_detected");
    expect(result.opportunityId).toBeNull();
  });

  it("a terminal opportunity stops blocking", async () => {
    await h.exec(
      `update public.reconnect_opportunities set status = 'declined', resolved_at = now()
       where entity_id = '${JOHN}'`,
    );
    const next = await newSignal({ userId: ALICE, entityId: JOHN });
    const result = await materialize({
      signalId: next, userId: ALICE, entityId: JOHN, expiresAt: LATER, now: NOW,
    });
    expect(result.outcome).toBe("materialized");
  });
});

describe("4. the unique_violation handler confirms its cause before claiming it", () => {
  it("does not convert an UNRELATED unique violation into a reload", async () => {
    await h.exec("delete from public.reconnect_opportunities; delete from public.signals;");
    // A different unique constraint the insert can hit. Stand-in for any
    // future index whose violation has nothing to do with UNIQUE(signal_id).
    await h.exec(
      "create unique index tmp_one_opportunity_per_entity on public.reconnect_opportunities (entity_id)",
    );

    const first = await newSignal({ userId: ALICE, entityId: JOHN });
    expect(
      (await materialize({ signalId: first, userId: ALICE, entityId: JOHN, expiresAt: LATER, now: NOW }))
        .outcome,
    ).toBe("materialized");
    // Terminal, so the open-opportunity check lets the next one through to the
    // insert — where the temporary index refuses it.
    await h.exec(
      `update public.reconnect_opportunities set status = 'declined', resolved_at = now()
       where entity_id = '${JOHN}'`,
    );

    const second = await newSignal({ userId: ALICE, entityId: JOHN });
    await expect(
      materialize({ signalId: second, userId: ALICE, entityId: JOHN, expiresAt: LATER, now: NOW }),
    ).rejects.toThrow(/unique|duplicate key/i);

    // It surfaced. It was not laundered into `reloaded` with a null id.
    expect((await signalRow(second)).status).toBe("detected");
    await h.exec("drop index tmp_one_opportunity_per_entity");
  });

  it("still reloads when UNIQUE(signal_id) is the genuine cause", async () => {
    await h.exec("delete from public.reconnect_opportunities; delete from public.signals;");
    const signal = await newSignal({ userId: ALICE, entityId: JOHN });
    const first = await materialize({
      signalId: signal, userId: ALICE, entityId: JOHN, expiresAt: LATER, now: NOW,
    });
    const again = await materialize({
      signalId: signal, userId: ALICE, entityId: JOHN, expiresAt: LATER, now: NOW,
    });
    expect(again).toEqual({ outcome: "reloaded", opportunityId: first.opportunityId });
  });

  it("UNIQUE(signal_id) refuses a direct second insert — the constraint is real", async () => {
    const signal = (
      await h.query<{ signal_id: string }>(
        "select signal_id from public.reconnect_opportunities limit 1",
      )
    )[0].signal_id;
    await expect(
      h.exec(
        `insert into public.reconnect_opportunities (user_id, signal_id, entity_id, proposal, expires_at)
         values ('${ALICE}', '${signal}', '${JOHN}', '{}'::jsonb, now() + interval '1 day')`,
      ),
    ).rejects.toThrow(/unique|duplicate key/i);
  });
});

describe("5. the frozen draft constraint still holds", () => {
  it("refuses `drafted` without payload, text and hash", async () => {
    const id = (
      await h.query<{ id: string }>("select id from public.reconnect_opportunities limit 1")
    )[0].id;
    await expect(
      h.exec(`update public.reconnect_opportunities set status = 'drafted' where id = '${id}'`),
    ).rejects.toThrow(/opportunities_offerable_requires_draft/i);

    await h.exec(
      `update public.reconnect_opportunities
          set status = 'drafted',
              share_payload = '{"fromDisplayName":"Dad"}'::jsonb,
              rendered_text = 'hello',
              rendered_text_hash = 'abc'
        where id = '${id}'`,
    );
    const row = (
      await h.query<{ status: string }>(
        "select status from public.reconnect_opportunities where id = $1",
        [id],
      )
    )[0];
    expect(row.status).toBe("drafted");
  });
});

describe("6. security and privilege posture", () => {
  it("is executable by service_role and by nobody else", async () => {
    const signature = "public.materialize_signal(uuid,uuid,uuid,jsonb,timestamptz,timestamptz)";
    const grants: Record<string, boolean> = {};
    for (const role of ["public", "anon", "authenticated", "service_role"]) {
      const rows = await h.query<{ ok: boolean }>(
        "select has_function_privilege($1, $2, 'execute') as ok",
        [role, signature],
      );
      grants[role] = rows[0].ok;
    }
    expect(grants).toEqual({
      public: false,
      anon: false,
      authenticated: false,
      service_role: true,
    });
  });

  it("is SECURITY INVOKER with a pinned search_path", async () => {
    const rows = await h.query<{ prosecdef: boolean; proconfig: string[] | null }>(
      `select p.prosecdef, p.proconfig
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'materialize_signal'`,
    );
    expect(rows[0].prosecdef).toBe(false);
    expect(rows[0].proconfig).toEqual(["search_path=pg_catalog, public, pg_temp"]);
  });

  it("the M2 functions kept their posture too", async () => {
    for (const signature of [
      "public.claim_ingest_jobs(integer,integer)",
      "public.match_episodes(uuid,extensions.vector,integer)",
    ]) {
      for (const role of ["public", "anon", "authenticated"]) {
        const rows = await h.query<{ ok: boolean }>(
          "select has_function_privilege($1, $2, 'execute') as ok",
          [role, signature],
        );
        expect(rows[0].ok, `${role} on ${signature}`).toBe(false);
      }
      const svc = await h.query<{ ok: boolean }>(
        "select has_function_privilege('service_role', $1, 'execute') as ok",
        [signature],
      );
      expect(svc[0].ok, signature).toBe(true);
    }
  });
});

describe("7. the lock is named after VERIFIED identity, and taken after it", () => {
  /**
   * A single-connection Postgres cannot observe a transaction-scoped advisory
   * lock after the statement that took it, so this one is asserted over the
   * source. That is the honest tool for the property in question: "the lock is
   * acquired after validation" is a statement about ORDER, and a behavioural
   * test would pass just as happily with the lock in the wrong place.
   */
  const sql = readFileSync(
    path.join(process.cwd(), "supabase/migrations/20260916140000_m4_materialize_signal.sql"),
    "utf8",
  );

  it("validates ownership, entity and entity-ownership before locking", () => {
    const loadSignal = sql.indexOf("from public.signals s");
    const entityMismatch = sql.indexOf("if sig_entity_id <> p_entity_id then");
    const entityOwnership = sql.indexOf("from public.entities e");
    const lock = sql.indexOf("pg_advisory_xact_lock");
    const replay = sql.indexOf("from public.reconnect_opportunities o");

    for (const index of [loadSignal, entityMismatch, entityOwnership, lock, replay]) {
      expect(index).toBeGreaterThan(-1);
    }
    expect(loadSignal).toBeLessThan(entityMismatch);
    expect(entityMismatch).toBeLessThan(entityOwnership);
    expect(entityOwnership).toBeLessThan(lock);
    // ...and the replay lookup comes after the lock, so it is both authorized
    // and serialised.
    expect(lock).toBeLessThan(replay);
  });

  it("locks on the signal's entity, never on the caller-supplied one", () => {
    const lock = sql.indexOf("pg_advisory_xact_lock");
    const expression = sql.slice(lock, sql.indexOf(");", lock));
    expect(expression).toContain("sig_entity_id");
    expect(expression).not.toContain("p_entity_id");
  });

  it("writes the verified entity, not the argument", () => {
    const insert = sql.slice(sql.indexOf("insert into public.reconnect_opportunities"), sql.indexOf("returning id into new_id"));
    expect(insert).toContain("sig_entity_id");
    expect(insert).not.toContain("p_entity_id");
  });
});
