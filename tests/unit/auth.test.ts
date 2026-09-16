import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  resolveDevUserId,
  resolveUserId,
  type AuthEnv,
} from "@/server/auth/resolve-user";
import { ChatRequestSchema } from "@/server/services/chat-request";

const DEV_USER = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const SESSION_USER = "11111111-2222-3333-4444-555555555555";

const dev = (extra: Partial<AuthEnv> = {}): AuthEnv => ({
  NODE_ENV: "development",
  CARELOOP_DEV_USER_ID: DEV_USER,
  ...extra,
});

describe("1. an authenticated Supabase session always wins", () => {
  it("prefers the session user over a configured dev user in development", () => {
    expect(resolveUserId({ sessionUserId: SESSION_USER, env: dev() })).toBe(
      SESSION_USER,
    );
  });

  it("prefers the session user in production", () => {
    expect(
      resolveUserId({
        sessionUserId: SESSION_USER,
        env: { NODE_ENV: "production" },
      }),
    ).toBe(SESSION_USER);
  });
});

describe("2. the development fallback works when there is no session", () => {
  it("returns the configured dev user id", () => {
    expect(resolveUserId({ sessionUserId: null, env: dev() })).toBe(DEV_USER);
  });

  it("refuses a value that is not a uuid", () => {
    expect(
      resolveDevUserId(dev({ CARELOOP_DEV_USER_ID: "not-a-uuid" })),
    ).toBeNull();
    expect(resolveDevUserId(dev({ CARELOOP_DEV_USER_ID: "" }))).toBeNull();
    expect(
      resolveDevUserId({ NODE_ENV: "development" }),
    ).toBeNull();
  });
});

describe("3. production refuses CARELOOP_DEV_USER_ID", () => {
  it("ignores it even when it is a perfectly valid uuid", () => {
    expect(
      resolveDevUserId({
        NODE_ENV: "production",
        CARELOOP_DEV_USER_ID: DEV_USER,
      }),
    ).toBeNull();
  });

  it("ignores it on Vercel even if NODE_ENV claims development", () => {
    expect(resolveDevUserId(dev({ VERCEL: "1" }))).toBeNull();
  });

  // The guard is an allow-list, so anything that is not local development is
  // refused. A deny-list (`!== "production"`) would authenticate all of these.
  it.each([
    ["undefined", undefined],
    ["empty string", ""],
    ["test", "test"],
    ["staging", "staging"],
    ["prod", "prod"],
    ["Production", "Production"],
    ["PRODUCTION", "PRODUCTION"],
    ["development ", "development "],
  ])("fails closed when NODE_ENV is %s", (_label, value) => {
    expect(
      resolveDevUserId({
        NODE_ENV: value,
        CARELOOP_DEV_USER_ID: DEV_USER,
      }),
    ).toBeNull();
  });

  it("allows it only for exactly NODE_ENV=development off Vercel", () => {
    expect(resolveDevUserId(dev())).toBe(DEV_USER);
  });
});

describe("4. production without a session is unauthenticated", () => {
  it("resolves to null, which the route turns into 401", () => {
    expect(
      resolveUserId({
        sessionUserId: null,
        env: { NODE_ENV: "production", CARELOOP_DEV_USER_ID: DEV_USER },
      }),
    ).toBeNull();
  });

  it("resolves to null on Vercel with no session", () => {
    expect(
      resolveUserId({
        sessionUserId: null,
        env: { NODE_ENV: "production", VERCEL: "1", CARELOOP_DEV_USER_ID: DEV_USER },
      }),
    ).toBeNull();
  });
});

describe("5. the user id is never taken from the request body", () => {
  it("strips user_id, userId and sub from the parsed request", () => {
    const result = ChatRequestSchema.safeParse({
      text: "hello",
      user_id: DEV_USER,
      userId: DEV_USER,
      sub: DEV_USER,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(Object.keys(result.data).sort()).toEqual(["text"]);
    }
  });

  it("the route derives userId from the session, never from parsed input", () => {
    const root = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../..",
    );
    const route = readFileSync(
      path.join(root, "app/api/chat/route.ts"),
      "utf8",
    );

    // Identity comes from getCurrentUserId() and a 401 is returned without it.
    expect(route).toMatch(/const userId = await getCurrentUserId\(\)/);
    expect(route).toMatch(/if \(!userId\) return jsonError\(401/);
    // No assignment of userId from request-derived data.
    expect(route).not.toMatch(/userId\s*[:=]\s*(parsed|body|request)/);
    expect(route).not.toMatch(/parsed\.data\.user/i);
  });
});
