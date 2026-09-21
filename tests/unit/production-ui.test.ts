import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isDebugSurfaceEnabled } from "@/server/config";

/**
 * 16. NOTHING DEVELOPMENT-SHAPED IN A REVIEWER'S BROWSER (M12e).
 *
 * A real recording showed "Reset demo — development only" sitting in the
 * product chrome. Almost everything was in fact already gated; the audit
 * that followed found one thing that was not, and it was the worst of them:
 * the no-session screen printed an environment variable name, a local
 * config file name and Supabase dashboard instructions to ANY visitor,
 * because it was gated on `!userId` rather than on being a development
 * environment. Those are not the same condition.
 *
 * These tests pin the gate rather than the wording, and then check the
 * built output rather than trusting the reasoning.
 */

const read = (path: string) => readFileSync(path, "utf8");

/** Source with comments stripped: only executable text decides anything. */
function code(path: string): string {
  return read(path)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("the environment predicate is the only switch", () => {
  it("is false for anything that is not local development", () => {
    expect(isDebugSurfaceEnabled({ NODE_ENV: "production" })).toBe(false);
    expect(isDebugSurfaceEnabled({ NODE_ENV: "development", VERCEL: "1" })).toBe(false);
    expect(isDebugSurfaceEnabled({})).toBe(false);
    expect(isDebugSurfaceEnabled({ NODE_ENV: "development" })).toBe(true);
  });
});

describe("every development affordance on the home page is behind it", () => {
  const home = code("app/page.tsx");

  it("M12e.3: there are none left — they moved to the operator surface", () => {
    // Gating them was correct and was not enough. This is the page a
    // reviewer records; a control labelled "(dev)" is still in shot.
    for (const needle of ["DemoResetControl", "FamilyInboxLink", "DemoHint", "demoHint"]) {
      expect(home).not.toContain(needle);
    }
    // And they really are somewhere, behind the same four conditions.
    const operator = code("app/dev/page.tsx");
    expect(operator).toContain("<DemoResetControl");
    expect(operator).toContain("<FamilyInboxLink />");
    expect(operator).toContain("isDebugSurfaceEnabled(process.env)");
    expect(operator).toContain("authorizeDevSeed(process.env");
    expect(operator).toContain("isLocalOperatorHost");
    // Three notFound() calls: no token, no query parameter, no way in.
    expect(operator.match(/notFound\(\)/g)).toHaveLength(3);
  });

  it("and so is the setup guidance on the no-session screen", () => {
    // The regression this test exists for: these strings used to render for
    // anybody with no session, including on a deployment.
    expect(home).toMatch(/const setupHint = isDebugSurfaceEnabled\(process\.env\)/);
    expect(home).toMatch(/\{setupHint && \([\s\S]*CARELOOP_DEV_USER_ID/);
    // And the sentence a real visitor sees says nothing about any of it.
    expect(home).toContain("Please sign in to continue.");
  });

  it("names no local config file anywhere in what it renders", () => {
    // ".env.local" is a developer's file. Printing its name at somebody who
    // is not a developer tells them nothing and looks broken.
    expect(home).not.toContain(".env.local");
  });
});

describe("the dev components are server components, so production never bundles them", () => {
  it.each([
    "app/_components/dev-operator.tsx",
    "app/dev/page.tsx",
  ])("%s carries no client directive", (path) => {
    expect(code(path)).not.toContain('"use client"');
  });

  it("the one client module that IS needed carries no development copy", () => {
    // `dev-tools.tsx` has to be a client component — it owns a pending
    // state and a reload. It must therefore contain no words: the strings
    // come down as props from the server component above it, so they exist
    // only in a render a development environment actually performed.
    const client = code("app/_components/dev-tools.tsx");
    expect(client).toContain('"use client"');
    for (const word of ["Reset demo", "development only", "Resetting"]) {
      expect(client).not.toContain(word);
    }
  });
});

describe("the built client bundle carries no development copy", () => {
  it("contains none of the operator strings", () => {
    // Skipped on a machine that has not built yet; run `npm run build` to
    // arm it. The assertion is the point of the gating above, not a proxy
    // for it.
    const dir = ".next/static";
    if (!existsSync(dir)) return;

    const banned = [
      "Resetting",
      "Reset demo",
      "development only",
      "CARELOOP_DEV_USER_ID",
      ".env.local",
      "Try saying",
      "Family inbox (dev)",
      "Authentication → Users → Add user",
    ];
    const offenders: string[] = [];
    const walk = (path: string) => {
      for (const entry of readdirSync(path)) {
        const full = join(path, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (entry.endsWith(".js")) {
          const text = readFileSync(full, "utf8");
          for (const needle of banned) {
            if (text.includes(needle)) offenders.push(`${full}: ${needle}`);
          }
        }
      }
    };
    walk(dir);
    expect(offenders).toEqual([]);
  });
});
