"use server";

import { redirect } from "next/navigation";
import { getCurrentIdentity } from "@/server/auth/current-user";
import { createRequestAuthClient } from "@/server/auth/supabase-request";
import { authorizeDemoReset, authorizeDemoStart } from "@/server/auth/demo-access";
import { isDemoModeEnabled } from "@/server/config";
import { createDemoFixtureDeps, createFamilyContactDeps } from "@/server/services/deps";
import { readDemoEmail } from "@/core/family/demo-email";
import { familyConfig } from "@/server/config";
import { fixtureUuid } from "@/server/services/demo-fixture";
import {
  ensureBlankConversation,
  resetDemoFixture,
  seedDemoFixture,
} from "@/server/services/demo-fixture";
import { DEMO_GEORGE } from "@/fixtures/demo/george";

/**
 * The public demo's two operations. PRODUCTION, and deliberately narrow.
 *
 * These are the only things in the application that can create an account or
 * delete a user's rows, so both authorize themselves from validated Auth
 * claims rather than trusting that a page chose to render their button. A
 * Server Action is a POST endpoint whether or not anything points at it, and
 * Next's own guidance is that a proxy may be skipped by a matcher change - so
 * "the parent did not render it" is not a boundary.
 *
 * Neither is reachable unless CARELOOP_DEMO_MODE is exactly "true". A
 * deployment that is not a demo does not have a demo.
 */

/**
 * The fixture's John, for one user.
 *
 * DERIVED, never looked up by display name. A name is a label people reuse -
 * an earlier version of this codebase claimed a row because it was called
 * "John" and then deleted it on reset. The contact must bind to exactly the
 * entity this user's fixture created.
 */
function johnEntityId(userId: string): string {
  return fixtureUuid(DEMO_GEORGE.id, userId, "entity/john");
}

/**
 * Creates at most one anonymous Supabase user, then hands them George.
 *
 * ONLY FROM AN EXPLICIT CLICK. Nothing on a GET creates an account: a bot, a
 * link preview, a prefetch or a refresh would each mint an Auth user, and the
 * sign-in rate limit is per IP, so one crawler could exhaust the demo for
 * everyone behind it. Idempotent by decision, not by luck - an existing
 * session is reused and returns without creating anything.
 */
export async function startDemoAction(): Promise<{ ok: boolean; reason?: string }> {
  const demoMode = isDemoModeEnabled(process.env);
  const decision = authorizeDemoStart({ demoMode, identity: await getCurrentIdentity() });

  if (decision.action === "refuse") return { ok: false, reason: decision.reason };
  // Already signed in - anonymous or permanent. Nothing is created, and no
  // fixture is written over whatever is already there.
  if (decision.action === "reuse") redirect("/");

  const supabase = await createRequestAuthClient();
  const { data, error } = await supabase.auth.signInAnonymously();
  const userId = data?.user?.id;
  if (error || !userId) {
    // One attempt. A retry loop here would turn a provider hiccup into a
    // stream of abandoned accounts.
    console.error(
      JSON.stringify({
        event: "demo.start_failed",
        errorName: error?.name ?? "NoUserReturned",
      }),
    );
    return { ok: false, reason: "sign_in_failed" };
  }

  // Their own George. Every fixture id is derived from this UUID, so two
  // reviewers seeded from the same spec share no rows at all.
  const deps = createDemoFixtureDeps();
  await seedDemoFixture(deps, { userId, spec: DEMO_GEORGE });
  await ensureBlankConversation(deps, { userId });

  redirect("/");
}

/**
 * Restores this reviewer's own demo, and nobody else's.
 *
 * Three conditions, checked here rather than inherited: demo mode, a real
 * session, and an ANONYMOUS account. The third is the one that matters - the
 * reset deletes fixture-owned rows, and on a permanent account those ids would
 * belong to a real person's data.
 *
 * Every write below is scoped to the id the claims returned. Nothing accepts a
 * user id from the caller.
 */
export async function resetDemoSessionAction(): Promise<{ ok: boolean; reason?: string }> {
  const demoMode = isDemoModeEnabled(process.env);
  const decision = authorizeDemoReset({ demoMode, identity: await getCurrentIdentity() });
  if (!decision.allowed) return { ok: false, reason: decision.reason };

  const { userId } = decision;

  // Read BEFORE the reset. The reset deletes the fixture's John, and the
  // family_contacts row cascades with it - so a reviewer who restarted would
  // otherwise be asked for their email a second time, mid-demo. Same user,
  // same derived entity, same address; nothing crosses between reviewers
  // because every one of those three is keyed by this user id.
  const email = await readDemoContactAddress(userId);

  const deps = createDemoFixtureDeps();
  await resetDemoFixture(deps, { userId, spec: DEMO_GEORGE });
  await seedDemoFixture(deps, { userId, spec: DEMO_GEORGE });
  await ensureBlankConversation(deps, { userId });

  // Re-bound to the NEW row, which the derivation guarantees has the same id.
  if (email) await saveDemoEmail(userId, email);

  return { ok: true };
}

/**
 * Records where this reviewer's demo message should be sent.
 *
 * Demo configuration, not part of George's conversation: the older adult never
 * sees this, and nothing about it reaches the chat. Authorized exactly like
 * the reset - demo mode, a real session, and an anonymous account - because it
 * writes a row that a later send will hand to a third-party transport.
 *
 * The user id comes only from validated claims. The form supplies one field.
 */
export async function configureDemoContactAction(
  formData: FormData,
): Promise<{ ok: boolean; reason?: string }> {
  const demoMode = isDemoModeEnabled(process.env);
  const decision = authorizeDemoReset({ demoMode, identity: await getCurrentIdentity() });
  if (!decision.allowed) return { ok: false, reason: decision.reason };

  const reading = readDemoEmail(String(formData.get("email") ?? ""));
  if (!reading.ok) return { ok: false, reason: reading.reason };

  await saveDemoEmail(decision.userId, reading.email);
  redirect("/");
}

/** The one write. Bound to the derived entity, on the named channel. */
async function saveDemoEmail(userId: string, email: string): Promise<void> {
  const { familyContacts } = createFamilyContactDeps();
  await familyContacts.ensure({
    userId,
    entityId: johnEntityId(userId),
    channel: familyConfig.emailChannel,
    address: email,
    displayName: "John",
  });
}

/** What the page needs to know: has this reviewer told us where to send? */
export async function readDemoContactAddress(userId: string): Promise<string | null> {
  const { familyContacts } = createFamilyContactDeps();
  const contact = await familyContacts.findForEntityAndChannel(
    userId,
    johnEntityId(userId),
    familyConfig.emailChannel,
  );
  return contact?.address ?? null;
}
