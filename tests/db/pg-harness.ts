import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite/vector";

/**
 * A real Postgres, in-process, with the real migrations applied.
 *
 * PGlite is Postgres compiled to WASM: the same planner, the same constraint
 * machinery, the same plpgsql, the same privilege system. That matters here
 * because the thing under test IS the database - an advisory lock, a FOR
 * UPDATE, an exception handler, a REVOKE. A mock of those would only ever
 * confirm what we already believed.
 *
 * What it cannot do is real multi-connection concurrency, so the interleaving
 * tests live at the service layer (tests/unit/reconnect-service.test.ts) and
 * this harness proves the SQL's logic, its constraints and its privileges.
 */
const MIGRATIONS = path.join(process.cwd(), "supabase", "migrations");

/**
 * Supabase provides these before any project migration runs. Recreating them
 * is what makes `revoke ... from anon, authenticated` and
 * `grant ... to service_role` executable statements rather than no-ops.
 */
const PLATFORM_BOOTSTRAP = `
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin bypassrls;
  grant usage on schema public to anon, authenticated, service_role;
  alter default privileges in schema public
    grant execute on functions to anon, authenticated, service_role;
  create schema auth;
  create table auth.users (id uuid primary key default gen_random_uuid());
  create function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
`;

export type Harness = {
  db: PGlite;
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  exec(sql: string): Promise<void>;
  appliedMigrations: string[];
};

export async function createHarness(): Promise<Harness> {
  const db = await PGlite.create({ extensions: { vector } });
  await db.exec(PLATFORM_BOOTSTRAP);

  const appliedMigrations: string[] = [];
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) {
    await db.exec(readFileSync(path.join(MIGRATIONS, file), "utf8"));
    appliedMigrations.push(file);
  }

  return {
    db,
    appliedMigrations,
    async query<T = Record<string, unknown>>(sql: string, params?: unknown[]) {
      const result = await db.query<T>(sql, params as never);
      return result.rows;
    },
    async exec(sql: string) {
      await db.exec(sql);
    },
  };
}

export type MaterializeResult = {
  outcome: string;
  opportunityId: string | null;
  signalStatus?: string;
};

export function materializeCaller(harness: Harness) {
  return async (args: {
    signalId: string;
    userId: string;
    entityId: string;
    proposal?: unknown;
    expiresAt: string;
    now: string;
  }): Promise<MaterializeResult> => {
    const rows = await harness.query<{ r: MaterializeResult }>(
      "select public.materialize_signal($1, $2, $3, $4::jsonb, $5::timestamptz, $6::timestamptz) as r",
      [
        args.signalId,
        args.userId,
        args.entityId,
        JSON.stringify(args.proposal ?? { entityName: "John" }),
        args.expiresAt,
        args.now,
      ],
    );
    return rows[0].r;
  };
}
