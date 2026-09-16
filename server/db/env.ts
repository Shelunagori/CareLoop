import "server-only";

/**
 * Environment access for the database seam.
 *
 * Read lazily inside functions, never at module load: a missing variable must
 * fail the request that needs it, not the build. `SUPABASE_SERVICE_ROLE_KEY`
 * has no NEXT_PUBLIC_ prefix and this module is `server-only`, so it cannot be
 * pulled into a client bundle (docs/06 §18).
 */

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing required environment variable ${name}. See .env.example.`,
    );
  }
  return value;
}

export const supabaseEnv = {
  url: () => required("NEXT_PUBLIC_SUPABASE_URL"),
  anonKey: () => required("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
  serviceRoleKey: () => required("SUPABASE_SERVICE_ROLE_KEY"),
};
