import "server-only";
import { createRequestAuthClient } from "./supabase-request";
import { resolveUserId } from "./resolve-user";

/**
 * Resolves the companion user for this request, SERVER-SIDE ONLY.
 *
 * The browser never supplies a user id; it is read from the validated Supabase
 * Auth session. A request body claiming a user_id is ignored everywhere.
 *
 * Identity comes from `getClaims()`, which verifies the access token rather
 * than trusting the cookie, and refreshes it when it is close to expiring.
 * `getSession()` is never used in server code: it reads the cookie without
 * revalidating, which is a claim about what the browser sent, not about who
 * the user is.
 *
 * This module is the I/O shell. The decisions live as pure functions - the
 * development fallback in resolve-user.ts, the demo rules in demo-access.ts -
 * which is what makes the production guards testable.
 */
export type CurrentIdentity = {
  userId: string | null;
  /**
   * True for a Supabase ANONYMOUS user: a real validated session with its own
   * UUID and the ordinary `authenticated` role, with no email attached. Read
   * from the trusted `is_anonymous` claim, never from user_metadata.
   */
  isAnonymous: boolean;
};

export async function getCurrentIdentity(): Promise<CurrentIdentity> {
  const claims = await readClaims();

  const userId = resolveUserId({
    sessionUserId: claims?.sub ?? null,
    env: {
      NODE_ENV: process.env.NODE_ENV,
      CARELOOP_DEV_USER_ID: process.env.CARELOOP_DEV_USER_ID,
      VERCEL: process.env.VERCEL,
    },
  });

  return {
    userId,
    // Only a real session can be anonymous. The development fallback is a
    // configured UUID, not an account, and must never look like one.
    isAnonymous: Boolean(claims?.sub) && claims?.is_anonymous === true,
  };
}

/** The id alone, for the many call sites that need nothing else. */
export async function getCurrentUserId(): Promise<string | null> {
  return (await getCurrentIdentity()).userId;
}

type SessionClaims = { sub?: string; is_anonymous?: boolean };

async function readClaims(): Promise<SessionClaims | null> {
  try {
    const supabase = await createRequestAuthClient();
    const { data } = await supabase.auth.getClaims();
    return (data?.claims as SessionClaims | undefined) ?? null;
  } catch {
    return null;
  }
}
