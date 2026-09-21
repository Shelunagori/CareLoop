import "server-only";
import { headers } from "next/headers";
import { authorizeDevSeed, isDebugSurfaceEnabled, isLocalOperatorHost } from "@/server/config";

/**
 * MAY THIS REQUEST SEE OPERATOR CONTROLS? (M12f)
 *
 * The four conditions `/dev/family-inbox` has always used, in one place so
 * that every surface asks the same question:
 *
 *   local development — `NODE_ENV === "development"`;
 *   not a deployment  — `VERCEL` unset, even if NODE_ENV were tampered with;
 *   a dev seed secret is CONFIGURED;
 *   the request arrived on a loopback host.
 *
 * WHY IT MOVED HERE. The demo controls are wanted back on the CareLoop
 * page, and `app/page.tsx` had only the first of those checks
 * (`isDebugSurfaceEnabled`). Copying the other three into a second page is
 * how two gates drift apart; a shared function is how they cannot.
 *
 * THE SECRET NEVER REACHES THE BROWSER. `authorizeDevSeed` is supplied the
 * configured secret against itself, which asserts that ONE EXISTS. That is
 * an environment condition, not caller authentication — nobody is being
 * asked to know anything, and there is no token, header or query parameter
 * that turns this on. The host check is what keeps it off the network; the
 * first two are what keep it out of production.
 *
 * ASYNC because `headers()` is. Called from server components only, which
 * is enforced by `server-only` above: a client bundle that imported this
 * would fail to build rather than ship a gate it cannot honour.
 */
export async function operatorAccessAllowed(
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  if (!isDebugSurfaceEnabled(env)) return false;
  if (!authorizeDevSeed(env, env.CARELOOP_DEV_SEED_SECRET ?? null).allowed) return false;

  const requestHeaders = await headers();
  return isLocalOperatorHost({
    host: requestHeaders.get("host"),
    forwardedHost: requestHeaders.get("x-forwarded-host"),
  });
}
