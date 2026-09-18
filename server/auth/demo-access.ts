/**
 * Who may start a public demo, and who may reset one.
 *
 * Pure decision rules: no I/O, no `server-only`, no framework — so the
 * authorization that guards a destructive operation can be enumerated in
 * tests rather than mocked, the same way `resolve-user.ts` is.
 *
 * ANONYMOUS IS NOT UNAUTHENTICATED. A Supabase anonymous user holds a real
 * validated session with its own UUID and the ordinary `authenticated` role;
 * it simply has no email or password attached. So `isAnonymous` is not a
 * weaker form of signed-in — it is a statement about what KIND of account this
 * is, and that is exactly what the reset needs to know.
 *
 * `isAnonymous` must come from validated Auth claims (`is_anonymous`), never
 * from `user_metadata`, which the user themselves can write.
 */
export type DemoIdentity = {
  userId: string | null;
  isAnonymous: boolean;
};

export type DemoStartDecision =
  | { action: "create" }
  | { action: "reuse"; userId: string }
  | { action: "refuse"; reason: "demo_disabled" };

/**
 * An account is created only when demo mode is on AND nobody is signed in.
 *
 * Every other case reuses what is already there. That is the anti-abuse
 * property, and it is deliberately a decision rather than a side effect: a
 * reviewer who double-clicks, refreshes, or returns to the tab tomorrow must
 * not mint a second Auth user, and someone who already has a real account must
 * never be handed a demo one on top of it.
 */
export function authorizeDemoStart(input: {
  demoMode: boolean;
  identity: DemoIdentity;
}): DemoStartDecision {
  if (!input.demoMode) return { action: "refuse", reason: "demo_disabled" };
  if (input.identity.userId) return { action: "reuse", userId: input.identity.userId };
  return { action: "create" };
}

export type DemoResetDecision =
  | { allowed: true; userId: string }
  | { allowed: false; reason: "demo_disabled" | "unauthenticated" | "not_anonymous" };

/**
 * Reset deletes the caller's fixture-owned rows and writes the fixture back.
 *
 * Three conditions, in this order, all required. Demo mode first, so a
 * deployment that is not a demo has no reset at all and the refusal cannot be
 * used to learn anything about the caller. Then a real session. Then - the one
 * that matters - the account must be anonymous: on a permanent account those
 * same fixture ids would belong to a real person's data, and "restore the
 * demo" would be "delete their history".
 */
export function authorizeDemoReset(input: {
  demoMode: boolean;
  identity: DemoIdentity;
}): DemoResetDecision {
  if (!input.demoMode) return { allowed: false, reason: "demo_disabled" };

  const { userId, isAnonymous } = input.identity;
  // A flag without an id is not a caller. The two arrive from one claims read,
  // but reading a half-populated identity permissively would be a free reset.
  if (!userId) return { allowed: false, reason: "unauthenticated" };
  if (!isAnonymous) return { allowed: false, reason: "not_anonymous" };

  return { allowed: true, userId };
}
