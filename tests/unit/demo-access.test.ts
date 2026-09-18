import { describe, expect, it } from "vitest";
import {
  authorizeDemoReset,
  authorizeDemoStart,
  type DemoIdentity,
} from "@/server/auth/demo-access";

/**
 * Who may start a demo, and who may wipe one.
 *
 * Anonymous does NOT mean unauthenticated. A Supabase anonymous user holds a
 * real validated session with its own UUID; it simply has no email attached.
 * That distinction is the whole security model here: the demo's reset deletes
 * a user's fixture-owned data, so it may run only for someone whose data IS a
 * fixture - never for a person with a permanent account who happens to be
 * signed in.
 *
 * Pure, so every combination can be enumerated rather than mocked. The claim
 * that feeds `isAnonymous` comes from validated Auth claims at the call site,
 * never from user_metadata, which the user can write.
 */
const ANON: DemoIdentity = { userId: "11111111-2222-3333-4444-555555555555", isAnonymous: true };
const PERMANENT: DemoIdentity = { userId: "99999999-8888-7777-6666-555555555555", isAnonymous: false };
const NOBODY: DemoIdentity = { userId: null, isAnonymous: false };

describe("1. starting a demo", () => {
  it("creates an account only when demo mode is on and nobody is signed in", () => {
    expect(authorizeDemoStart({ demoMode: true, identity: NOBODY })).toEqual({ action: "create" });
  });

  it("reuses an existing anonymous session rather than creating a second one", () => {
    // Idempotence is the anti-abuse property: a reviewer who double-clicks,
    // refreshes, or comes back later must not mint Auth users.
    expect(authorizeDemoStart({ demoMode: true, identity: ANON })).toEqual({
      action: "reuse",
      userId: ANON.userId,
    });
  });

  it("never creates a demo account for someone who already has a real one", () => {
    expect(authorizeDemoStart({ demoMode: true, identity: PERMANENT })).toEqual({
      action: "reuse",
      userId: PERMANENT.userId,
    });
  });

  it("refuses entirely when demo mode is off", () => {
    for (const identity of [NOBODY, ANON, PERMANENT]) {
      expect(authorizeDemoStart({ demoMode: false, identity })).toEqual({
        action: "refuse",
        reason: "demo_disabled",
      });
    }
  });
});

describe("2. resetting a demo", () => {
  it("an anonymous demo user may reset, and is told which id that is", () => {
    expect(authorizeDemoReset({ demoMode: true, identity: ANON })).toEqual({
      allowed: true,
      userId: ANON.userId,
    });
  });

  it("a permanent account may not, even in demo mode", () => {
    // This is the one that matters. The reset deletes fixture-owned rows; on a
    // real account those ids belong to a real person's data.
    expect(authorizeDemoReset({ demoMode: true, identity: PERMANENT })).toEqual({
      allowed: false,
      reason: "not_anonymous",
    });
  });

  it("nobody signed in may not", () => {
    expect(authorizeDemoReset({ demoMode: true, identity: NOBODY })).toEqual({
      allowed: false,
      reason: "unauthenticated",
    });
  });

  it("demo mode off refuses every caller", () => {
    for (const identity of [NOBODY, ANON, PERMANENT]) {
      expect(authorizeDemoReset({ demoMode: false, identity })).toEqual({
        allowed: false,
        reason: "demo_disabled",
      });
    }
  });

  it("an anonymous flag without a user id is not a caller", () => {
    // Defensive: the two fields come from one claims read, but a permissive
    // reading of a half-populated identity would be a free reset.
    expect(
      authorizeDemoReset({ demoMode: true, identity: { userId: null, isAnonymous: true } }),
    ).toEqual({ allowed: false, reason: "unauthenticated" });
  });

  it("demo mode is checked before anything about the caller", () => {
    // A deployment that is not a demo has no reset at all, so the reason
    // never reveals whether the caller would otherwise have qualified.
    expect(authorizeDemoReset({ demoMode: false, identity: ANON }).allowed).toBe(false);
    expect(authorizeDemoReset({ demoMode: false, identity: ANON })).toEqual({
      allowed: false,
      reason: "demo_disabled",
    });
  });
});
