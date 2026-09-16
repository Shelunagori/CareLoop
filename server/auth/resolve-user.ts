/**
 * Pure identity-resolution rules. No I/O, no `server-only`, no framework —
 * so the one decision that decides who a request belongs to can be tested
 * exhaustively, without mocks.
 */

export type AuthEnv = {
  NODE_ENV?: string;
  CARELOOP_DEV_USER_ID?: string;
  /** Set to "1" on every Vercel deployment, production and preview alike. */
  VERCEL?: string;
};

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The development-only escape hatch, so the hot path can be exercised before
 * sign-in UX exists.
 *
 * This is an ALLOW-LIST, deliberately. An earlier version asked
 * `NODE_ENV !== "production"`, which fails OPEN: an unset, misspelled or
 * unexpected NODE_ENV ("prod", "staging", or undefined — which is what plain
 * Node gives you) would satisfy it and authenticate the request. Here the
 * fallback is refused unless we positively know we are in local development,
 * so every unknown environment fails CLOSED.
 *
 * The Vercel check is belt and braces: even if NODE_ENV were tampered with in
 * a deployment's settings, a deployed environment can never authenticate
 * through an environment variable.
 */
export function resolveDevUserId(env: AuthEnv): string | null {
  if (env.NODE_ENV !== "development") return null;
  if (env.VERCEL) return null;

  const candidate = env.CARELOOP_DEV_USER_ID;
  if (!candidate || !UUID.test(candidate)) return null;
  return candidate;
}

/**
 * A real Supabase session always wins. The development fallback is only ever
 * consulted when there is no session at all.
 */
export function resolveUserId(input: {
  sessionUserId: string | null;
  env: AuthEnv;
}): string | null {
  if (input.sessionUserId) return input.sessionUserId;
  return resolveDevUserId(input.env);
}
