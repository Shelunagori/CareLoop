"use server";

import { getCurrentUserId } from "@/server/auth/current-user";
import { authorizeDevSeed, isDebugSurfaceEnabled } from "@/server/config";
import { createDemoFixtureDeps } from "@/server/services/deps";
import {
  ensureBlankConversation,
  resetDemoFixture,
  seedDemoFixture,
} from "@/server/services/demo-fixture";
import { clearNotifierInbox } from "@/server/services/dev-tools";
import { DEMO_GEORGE } from "@/fixtures/demo/george";

/**
 * Reset and reseed the demo, from the browser, without the secret ever
 * reaching it.
 *
 * A server action rather than a fetch to `/api/dev/demo/setup`, for one
 * reason: that route requires `x-careloop-dev-secret`, and the only way a
 * browser could send it is if it were in the bundle. Here the gate is
 * evaluated on the server and the demo service is called in process, so there
 * is no secret to leak and no new callable surface to defend.
 *
 * The gate is checked HERE as well as at the render site, because a server
 * action is a POST endpoint whether or not a button points at it: "the parent
 * did not render the button" is not a security boundary.
 */
export async function resetDemoAction(): Promise<{ ok: boolean }> {
  if (!isDebugSurfaceEnabled(process.env)) return { ok: false };
  // Reuses the seed authorization, supplying the configured secret server-side:
  // the four conditions are unchanged, including that one must be configured.
  const auth = authorizeDevSeed(process.env, process.env.CARELOOP_DEV_SEED_SECRET ?? null);
  if (!auth.allowed) return { ok: false };

  const userId = await getCurrentUserId();
  if (!userId) return { ok: false };

  const deps = createDemoFixtureDeps();
  await resetDemoFixture(deps, { userId, spec: DEMO_GEORGE });
  await seedDemoFixture(deps, { userId, spec: DEMO_GEORGE });
  await ensureBlankConversation(deps, { userId });
  // The family side starts clean too. Otherwise the next demo opens with a
  // reply link for a request the reset has just removed.
  clearNotifierInbox();
  return { ok: true };
}
