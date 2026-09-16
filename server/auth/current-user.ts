import "server-only";
import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import { supabaseEnv } from "@/server/db/env";
import { resolveUserId } from "./resolve-user";

/**
 * Resolves the companion user for this request, SERVER-SIDE ONLY.
 *
 * The browser never supplies a user id; it is read from the Supabase Auth
 * session cookie. A request body claiming a user_id is ignored everywhere.
 *
 * This module is the I/O shell. The decision itself lives in resolve-user.ts
 * as a pure function, which is what makes the production guard testable.
 */
export async function getCurrentUserId(): Promise<string | null> {
  const sessionUserId = await getSessionUserId();
  return resolveUserId({
    sessionUserId,
    env: {
      NODE_ENV: process.env.NODE_ENV,
      CARELOOP_DEV_USER_ID: process.env.CARELOOP_DEV_USER_ID,
      VERCEL: process.env.VERCEL,
    },
  });
}

async function getSessionUserId(): Promise<string | null> {
  try {
    const cookieStore = await cookies();
    const supabase = createServerClient(
      supabaseEnv.url(),
      supabaseEnv.anonKey(),
      {
        cookies: {
          getAll: () => cookieStore.getAll(),
          // Read-only: M1 never issues or refreshes a session. Sign-in UX is
          // deliberately not part of this milestone.
          setAll: () => {},
        },
      },
    );
    const { data } = await supabase.auth.getUser();
    return data.user?.id ?? null;
  } catch {
    return null;
  }
}
