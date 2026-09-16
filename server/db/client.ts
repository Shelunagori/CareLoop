import "server-only";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "./types.generated";
import { supabaseEnv } from "./env";

/**
 * Minimal database seam (M0).
 *
 * Repositories (M2+) are the only things that should call this; nothing here
 * knows anything about CareLoop's domain. The service-role client bypasses RLS
 * by design — RLS is defence in depth against direct client access, while the
 * trusted path is server code that has already established who the caller is
 * (docs/06 §18).
 *
 * `server-only` makes a client-component import a build error rather than a
 * leaked service-role key.
 *
 * The Database generic comes from types generated off the linked Supabase
 * project (`npm run db:types`). Regenerate it whenever a migration lands, so
 * the frozen schema and the TypeScript view of it cannot drift.
 */
export function createServiceRoleClient() {
  return createClient<Database>(
    supabaseEnv.url(),
    supabaseEnv.serviceRoleKey(),
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
}

export type { Database };
