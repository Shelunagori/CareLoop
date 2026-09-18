import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The public demo's surface: what renders, what can create an account, and
 * what never reaches a browser.
 *
 * Read from source rather than driven, because the claims are structural - a
 * GET that cannot create an Auth user, an action that authorizes itself
 * instead of trusting the page that rendered its button, a secret that has no
 * path to the client. The behavioural rules they rest on are enumerated in
 * demo-access.test.ts and demo-config.test.ts.
 */
const source = (file: string) => readFileSync(file, "utf8");
const code = (file: string) =>
  source(file)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

describe("1. an account is created by a click, never by a page view", () => {
  it("the page offers the door and does not open it", () => {
    const page = code("app/page.tsx");

    // Rendering the Start screen is all a GET does. A bot, a link preview, a
    // prefetch or a refresh would each mint a Supabase user otherwise - and
    // anonymous sign-in is rate-limited per IP, so one crawler could lock out
    // everyone behind it.
    expect(page).toContain("<StartDemo action={startDemoAction} />");
    expect(page, "the page signs someone in during render").not.toContain("signInAnonymously");
    expect(page).not.toContain("seedDemoFixture");
  });

  it("only the server action can sign anyone in", () => {
    const offenders: string[] = [];
    for (const file of [...walk("app"), ...walk("server"), ...walk("core")]) {
      if (file === "app/_actions/demo-session.ts") continue;
      if (code(file).includes("signInAnonymously")) offenders.push(file);
    }
    expect(offenders).toEqual([]);

    const action = source("app/_actions/demo-session.ts");
    expect(action.startsWith('"use server"')).toBe(true);
    // One attempt, no retry loop: a provider hiccup must not become a stream
    // of abandoned accounts.
    expect((action.match(/signInAnonymously/g) ?? [])).toHaveLength(1);
  });

  it("an existing session is reused rather than replaced", () => {
    const action = code("app/_actions/demo-session.ts");
    // The decision is delegated to the pure rule, which is enumerated
    // elsewhere; what matters here is that the action asks before creating.
    const start = action.slice(action.indexOf("export async function startDemoAction"));
    expect(start.indexOf("authorizeDemoStart")).toBeLessThan(start.indexOf("signInAnonymously"));
  });
});

describe("2. both demo operations authorize themselves", () => {
  const action = code("app/_actions/demo-session.ts");

  it("neither trusts the page that rendered its button", () => {
    // A Server Action is a POST endpoint whether or not anything points at
    // it, and Next's own guidance is that a proxy may be skipped by a matcher
    // change. So the gate lives in the action.
    for (const fn of ["startDemoAction", "resetDemoSessionAction"]) {
      const body = action.slice(action.indexOf(`export async function ${fn}`));
      expect(body, `${fn} does not check demo mode`).toContain("isDemoModeEnabled");
      expect(body, `${fn} does not read validated identity`).toContain("getCurrentIdentity");
    }
  });

  it("the reset is scoped to the id the claims returned, never to an argument", () => {
    const reset = action.slice(action.indexOf("export async function resetDemoSessionAction"));
    expect(reset).toContain("const { userId } = decision");
    // No caller-supplied user id anywhere in the signature or the body.
    expect(reset).not.toMatch(/resetDemoSessionAction\(\s*\w/);
    expect(reset).not.toContain("input.userId");
  });

  it("authorization comes from trusted claims, not user_metadata", () => {
    const identity = code("server/auth/current-user.ts");
    expect(identity).toContain("is_anonymous");
    expect(identity).toContain("getClaims");
    // getSession reads the cookie without revalidating: a claim about what the
    // browser sent, not about who the user is.
    expect(identity).not.toContain("getSession");
    expect(identity).not.toContain("user_metadata");
  });
});

describe("3. nothing user-specific is held between requests", () => {
  it("the auth client is built per request, never cached", () => {
    const client = code("server/auth/supabase-request.ts");
    // Fluid Compute reuses server instances across users. A client in module
    // scope would carry one visitor's cookies into another's request.
    expect(client).toContain("export async function createRequestAuthClient");
    expect(client).not.toMatch(/^const \w+ = createServerClient/m);
    expect(client).not.toContain("globalThis");
  });

  it("the proxy builds its own, inside the handler", () => {
    const proxy = code("proxy.ts");
    expect(proxy).toContain("export async function proxy");
    expect(proxy).not.toContain("globalThis");
    // The response `setAll` last built is the one returned - an earlier
    // NextResponse.next() drops the refreshed cookies and signs the user out.
    expect(proxy).toMatch(/return response;\s*}/);
  });

  it("session-bearing pages stay dynamic", () => {
    for (const page of ["app/page.tsx", "app/family/respond/[token]/page.tsx"]) {
      expect(source(page), page).toContain('export const dynamic = "force-dynamic"');
    }
    // No static or revalidated caching anywhere that carries a session.
    expect(code("app/page.tsx")).not.toContain("revalidate");
  });
});

describe("4. demo configuration is a server fact", () => {
  it("the browser is never told whether a demo exists", () => {
    const offenders: string[] = [];
    for (const file of [...walk("app"), ...walk("server"), ...walk("core")]) {
      if (code(file).includes("NEXT_PUBLIC_CARELOOP")) offenders.push(file);
    }
    expect(offenders).toEqual([]);

    // The client components take an action and render; they hold no policy.
    const start = code("app/_components/demo-start.tsx");
    expect(start).not.toContain("CARELOOP_DEMO_MODE");
    expect(start).not.toContain("process.env");
  });

  it("no development surface was weakened to make the demo work", () => {
    // The dev gates are untouched: still development-only, still allow-lists.
    expect(code("app/debug/page.tsx")).toContain("isDebugSurfaceEnabled");
    expect(code("app/dev/family-inbox/page.tsx")).toContain("isLocalOperatorHost");
    for (const route of [
      "app/api/dev/demo/setup/route.ts",
      "app/api/dev/demo/state/route.ts",
      "app/api/dev/detect/route.ts",
      "app/api/dev/seed-events/route.ts",
      "app/api/dev/family-inbox/route.ts",
    ]) {
      expect(code(route), route).toContain('"x-careloop-dev-secret"');
      expect(code(route), route).toContain("authorizeDevSeed");
    }
    // And demo mode cannot open any of them.
    for (const route of ["app/debug/page.tsx", "app/dev/family-inbox/page.tsx"]) {
      expect(code(route), route).not.toContain("isDemoModeEnabled");
    }
  });

  it("the production restart control is not the developer's reset", () => {
    const page = code("app/page.tsx");
    // Different action, different component, different condition.
    expect(page).toContain("canRestartDemo");
    expect(page).toContain("resetDemoSessionAction");
    // Executable text only: the file's comment explains why it must not SAY
    // "development only", and matching prose would punish it for explaining.
    const restart = code("app/_components/demo-start.tsx");
    expect(restart).toContain("Restart demo");
    expect(restart).not.toContain("development only");
    expect(restart).not.toContain("Reset demo");
  });
});

describe("5. no secret has a path to the browser", () => {
  it("the built client bundle carries none of them", () => {
    const dir = ".next/static";
    if (!existsSync(dir)) return;

    const offenders: string[] = [];
    const scan = (path: string) => {
      for (const entry of readdirSync(path)) {
        const full = join(path, entry);
        if (statSync(full).isDirectory()) scan(full);
        else if (entry.endsWith(".js")) {
          const text = readFileSync(full, "utf8");
          for (const needle of [
            "SUPABASE_SERVICE_ROLE_KEY",
            "CARELOOP_DEV_SEED_SECRET",
            "CARELOOP_DEMO_MODE",
            "ELEVENLABS_API_KEY",
            "OPENAI_API_KEY",
          ]) {
            if (text.includes(needle)) offenders.push(`${full}: ${needle}`);
          }
        }
      }
    };
    scan(dir);
    expect(offenders).toEqual([]);
  });

  it("the server-only marker is on every module that reads one", () => {
    for (const file of [
      "server/db/env.ts",
      "server/db/client.ts",
      "server/services/deps.ts",
      "server/auth/current-user.ts",
      "server/auth/supabase-request.ts",
    ]) {
      expect(source(file).split("\n").slice(0, 3).join("\n"), file).toContain("server-only");
    }
  });
});

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, acc);
    else if (/\.(ts|tsx)$/.test(full)) acc.push(full.replace(/\\/g, "/"));
  }
  return acc;
}
