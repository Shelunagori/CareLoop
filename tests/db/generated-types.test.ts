import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./pg-harness";
import { Constants } from "@/server/db/types.generated";

/**
 * The generated types describe the schema that actually exists (M12e.1).
 *
 * `server/db/types.generated.ts` is produced by `supabase gen types` against
 * a live project and is marked never-hand-edit. M12e edited it by hand,
 * because the migration that needs it cannot be applied from here — which
 * is exactly the situation in which a generated file silently stops
 * describing reality, and every `Database["public"]["Enums"][...]` in the
 * codebase quietly starts lying.
 *
 * So this asserts the file against a REAL Postgres with the real migrations
 * applied, rather than against a belief. It is not a substitute for
 * re-running `npm run db:types` after applying to the live project — it
 * cannot see a drift that exists only there — but it does catch the two
 * failures that would otherwise reach a deploy: a hand-edit that does not
 * match the migration, and a migration that does not apply at all.
 */
let h: Harness;

beforeAll(async () => {
  h = await createHarness();
});

async function enumValues(name: string): Promise<string[]> {
  const rows = await h.query<{ label: string }>(
    `select e.enumlabel as label
       from pg_enum e
       join pg_type t on t.oid = e.enumtypid
      where t.typname = $1
      order by e.enumsortorder`,
    [name],
  );
  return rows.map((row) => row.label);
}

describe("1. the migrations apply, in order, and in the repository's own shape", () => {
  it("is a plain timestamped .sql file per change, newest last", () => {
    // The established workflow: no framework, no down-migration, no
    // generated wrapper — a file whose name sorts, applied once.
    for (const name of h.appliedMigrations) {
      expect(name).toMatch(/^\d{14}_[a-z0-9_]+\.sql$/);
    }
    expect([...h.appliedMigrations].sort()).toEqual(h.appliedMigrations);
    expect(h.appliedMigrations.slice(-2)).toEqual([
      "20260921120000_m12e_entity_provenance.sql",
      "20260921120100_m12e_wellbeing_signal.sql",
    ]);
  });

  it("neither M12e file depends on the other", () => {
    // Provenance touches `entities`; the wellbeing file touches
    // `signal_type`. They share nothing, so the order between them is
    // arbitrary and either can be applied alone.
    const provenance = readFileSync(
      "supabase/migrations/20260921120000_m12e_entity_provenance.sql",
      "utf8",
    );
    const wellbeing = readFileSync(
      "supabase/migrations/20260921120100_m12e_wellbeing_signal.sql",
      "utf8",
    );
    expect(provenance).not.toContain("signal_type");
    expect(wellbeing).not.toContain("entities");
    // The new enum value is added and NOT used in the same file, so it is
    // committed before anything references it.
    expect(wellbeing).toContain("add value if not exists 'self_reported_wellbeing'");
    expect(wellbeing.match(/self_reported_wellbeing/g)).toHaveLength(1);
  });
});

describe("1b. the hand-applied file survives being applied twice", () => {
  it("re-running the provenance migration changes nothing and throws nothing", async () => {
    // It is applied to a live project by hand, where a half-applied file is
    // a real outcome. Both statements are guarded, so a re-run is a no-op
    // rather than "type already exists" and an operator guessing.
    const sql = readFileSync(
      "supabase/migrations/20260921120000_m12e_entity_provenance.sql",
      "utf8",
    );
    await h.exec(sql);
    await h.exec(sql);
    expect(await enumValues("entity_origin")).toEqual([...Constants.public.Enums.entity_origin]);
  });

  it("and so does the wellbeing one", async () => {
    const sql = readFileSync(
      "supabase/migrations/20260921120100_m12e_wellbeing_signal.sql",
      "utf8",
    );
    await h.exec(sql);
    await h.exec(sql);
    expect(await enumValues("signal_type")).toEqual([...Constants.public.Enums.signal_type]);
  });
});

describe("2. entity provenance exists as the generated types claim", () => {
  it("the column is present, NOT NULL, and defaults to user", async () => {
    const [column] = await h.query<{
      data_type: string;
      udt_name: string;
      is_nullable: string;
      column_default: string | null;
    }>(
      `select data_type, udt_name, is_nullable, column_default
         from information_schema.columns
        where table_schema = 'public' and table_name = 'entities' and column_name = 'origin'`,
    );
    expect(column).toBeDefined();
    expect(column.udt_name).toBe("entity_origin");
    expect(column.is_nullable).toBe("NO");
    expect(column.column_default).toContain("'user'");
  });

  it("every existing row is classified user — the migration guesses at nothing", async () => {
    await h.exec(`
      insert into auth.users (id) values ('33333333-3333-3333-3333-333333333333');
      insert into public.entities (user_id, type, display_name)
      values ('33333333-3333-3333-3333-333333333333', 'person', 'Somebody');
    `);
    const rows = await h.query<{ origin: string }>(`select origin from public.entities`);
    expect(rows.every((row) => row.origin === "user")).toBe(true);
  });

  it("the enum matches server/db/types.generated.ts exactly", async () => {
    expect(await enumValues("entity_origin")).toEqual([...Constants.public.Enums.entity_origin]);
  });

  it("refuses a value the type does not have", async () => {
    await expect(
      h.exec(`
        insert into public.entities (user_id, type, display_name, origin)
        values ('33333333-3333-3333-3333-333333333333', 'person', 'Nope', 'fixture');
      `),
    ).rejects.toThrow();
  });
});

describe("3. the wellbeing signal type exists as the generated types claim", () => {
  it("the enum matches, with the new value last", async () => {
    const values = await enumValues("signal_type");
    expect(values).toEqual([...Constants.public.Enums.signal_type]);
    expect(values.at(-1)).toBe("self_reported_wellbeing");
  });

  it("a signal row can actually be written with it", async () => {
    await h.exec(`
      insert into auth.users (id) values ('44444444-4444-4444-4444-444444444444');
      insert into public.entities (id, user_id, type, display_name)
      values ('44444444-0000-0000-0000-000000000001',
              '44444444-4444-4444-4444-444444444444', 'person', 'Don');
      insert into public.signals (user_id, entity_id, signal_type, explanation)
      values ('44444444-4444-4444-4444-444444444444',
              '44444444-0000-0000-0000-000000000001',
              'self_reported_wellbeing', '{"detector":"self_reported_wellbeing"}'::jsonb);
    `);
    const [row] = await h.query<{ signal_type: string }>(
      `select signal_type from public.signals
        where user_id = '44444444-4444-4444-4444-444444444444'`,
    );
    expect(row.signal_type).toBe("self_reported_wellbeing");
  });
});
