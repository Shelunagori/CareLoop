import "server-only";
import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { supabaseEnv } from "@/server/db/env";

/**
 * A Supabase auth client for ONE request.
 *
 * Built per call and never cached. Vercel's Fluid Compute reuses server
 * instances across users, so a client held in module scope or on `globalThis`
 * would carry one visitor's cookies into another visitor's request - which, in
 * a product whose whole demo is "every reviewer gets their own isolated
 * world", is the worst available bug. There is nothing to memoize here anyway:
 * the cost is constructing an object around the cookie store.
 *
 * This replaces the earlier read-only client whose `setAll` was a no-op. That
 * was honest while the application never created a session; it cannot stay
 * once an anonymous sign-in has a session to persist, because the cookies the
 * SDK asks us to write ARE the session.
 *
 * `setAll` is wrapped: a Server Component is not allowed to write cookies, and
 * calling this from one must not throw. When that happens the write is simply
 * skipped, and the proxy refreshes the session on the next request instead -
 * which is exactly the arrangement Supabase's SSR guidance describes.
 */
export async function createRequestAuthClient() {
  const cookieStore = await cookies();

  return createServerClient(supabaseEnv.url(), supabaseEnv.anonKey(), {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (cookiesToSet) => {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Called from a Server Component. The proxy handles the refresh.
        }
      },
    },
  });
}
