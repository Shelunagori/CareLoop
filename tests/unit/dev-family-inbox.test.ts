import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { authorizeDevSeed, isDebugSurfaceEnabled, isLocalOperatorHost } from "@/server/config";

/**
 * The family inbox is a DEMO PROP, and props are where discipline slips.
 *
 * It exists so the two sides of the reconnect loop can be shown without a
 * terminal: George approves a sentence, and the person it was written for can
 * be seen receiving exactly that sentence. To do that it must display a
 * plaintext capability URL - the one thing the rest of this codebase works
 * hardest to keep out of logs, out of `/debug` and out of every response.
 *
 * So the boundary is the feature. These tests hold two claims: the page cannot
 * exist outside local development, and the demo secret never becomes something
 * a browser has seen.
 */
const DEV = { NODE_ENV: "development", CARELOOP_DEV_SEED_SECRET: "s3cret" };

const source = (file: string) => readFileSync(file, "utf8");

/** Comments explain; only executable text is policy. */
const code = (file: string) =>
  source(file)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");

describe("1. the inbox cannot exist outside local development", () => {
  it("every environment that is not local development is refused", () => {
    // The page's gate is the seed gate, with the secret supplied server-side.
    // An allow-list, so an unexpected NODE_ENV fails closed rather than open.
    const gate = (env: Record<string, string | undefined>) =>
      isDebugSurfaceEnabled(env) &&
      authorizeDevSeed(env, env.CARELOOP_DEV_SEED_SECRET ?? null).allowed;

    expect(gate(DEV)).toBe(true);
    expect(gate({ ...DEV, NODE_ENV: "production" })).toBe(false);
    expect(gate({ ...DEV, NODE_ENV: "test" })).toBe(false);
    expect(gate({ ...DEV, NODE_ENV: undefined })).toBe(false);
    expect(gate({ ...DEV, NODE_ENV: "Development" })).toBe(false);
    // A deployment, even if NODE_ENV were tampered with.
    expect(gate({ ...DEV, VERCEL: "1" })).toBe(false);
    // And it is not enough to be local: the secret must actually be configured.
    expect(gate({ NODE_ENV: "development" })).toBe(false);
    expect(gate({ NODE_ENV: "development", CARELOOP_DEV_SEED_SECRET: "" })).toBe(false);
  });

  it("the page checks that gate itself, rather than trusting its route", () => {
    const page = code("app/dev/family-inbox/page.tsx");
    expect(page).toContain("isDebugSurfaceEnabled");
    expect(page).toContain("authorizeDevSeed");
    expect(page).toContain("notFound()");
  });
});

describe("2. the secret does not become something a browser has seen", () => {
  it("the page reads it on the server and renders none of it", () => {
    const page = source("app/dev/family-inbox/page.tsx");

    // A server component: no "use client", so nothing here is bundled.
    expect(page).not.toContain('"use client"');
    // The secret is read once, as an argument to the gate, and never put in
    // markup, a prop, a link or a query string.
    const uses = page.match(/CARELOOP_DEV_SEED_SECRET/g) ?? [];
    expect(uses).toHaveLength(1);
    expect(page).toMatch(/authorizeDevSeed\(\s*process\.env,\s*process\.env\.CARELOOP_DEV_SEED_SECRET/);
    for (const leak of ["localStorage", "sessionStorage", "searchParams", "?secret", "x-careloop-dev-secret"]) {
      expect(page, leak).not.toContain(leak);
    }
  });

  it("the operator control is a link, not a fetch carrying a header", () => {
    // A browser navigation cannot send `x-careloop-dev-secret`, and the answer
    // to that is NOT to move the secret somewhere a browser can reach.
    const control = code("app/_components/dev-tools.tsx");
    expect(control).not.toContain("CARELOOP_DEV_SEED_SECRET");
    expect(control).not.toContain("x-careloop-dev-secret");
  });

  it("the existing header-gated route is left exactly as it was", () => {
    const route = code("app/api/dev/family-inbox/route.ts");
    expect(route).toContain("x-careloop-dev-secret");
    expect(route).toContain("authorizeDevSeed");
    expect(route).toContain("404");
  });
});

describe("3. the inbox reads the dev notifier, and nothing else", () => {
  it("it does not query the database on its own", () => {
    const page = code("app/dev/family-inbox/page.tsx");

    // The notifier's outbox is the source of truth for the demo. A page that
    // reached for family_requests would be a second delivery record, and the
    // two would disagree the first time one of them was wrong.
    expect(page).toContain("readNotifierInbox");
    for (const forbidden of [
      "familyRequests",
      "createClient",
      "supabase",
      "loadFamilyView",
      "opportunit",
      "baseline",
      "transcript",
      "sharePayload",
      "SharePayload",
      "tokenHash",
    ]) {
      expect(page, forbidden).not.toContain(forbidden);
    }
  });

  it("it goes through the service boundary, not straight to the adapter", () => {
    const page = code("app/dev/family-inbox/page.tsx");
    expect(page).toContain("@/server/services/dev-tools");
    expect(page).not.toContain("@/server/adapters/notifier");
  });
});

describe("4. a reset starts the family side clean too", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("the dev inbox is emptied by the reset, not left showing last run's link", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const { createDevNotifier } = await import("@/server/adapters/notifier");
    const { readNotifierInbox, clearNotifierInbox } = await import("@/server/services/dev-tools");

    await createDevNotifier({ NODE_ENV: "development" }).send({
      requestId: "req-1",
      channel: "sms",
      address: "+15550000",
      recipientDisplayName: "A",
      body: "Are you able to visit soon?",
      responseUrl: "http://localhost:3000/family/respond/plaintext-token",
    });
    expect(readNotifierInbox()).toHaveLength(1);

    clearNotifierInbox();

    // A fresh demo must not offer a reply link from the previous one - which
    // would open a capability page for an opportunity that no longer exists.
    expect(readNotifierInbox()).toEqual([]);
  });

  it("BOTH development reset paths clear it, so neither can quietly forget", () => {
    // The clear lives at the dev entry points rather than inside the shared
    // fixture service, so the shared service does not import a dev adapter.
    // The cost of that choice is two call sites; this is what pays it.
    expect(code("app/_actions/demo.ts")).toContain("clearNotifierInbox()");
    expect(code("app/api/dev/demo/setup/route.ts")).toContain("clearNotifierInbox()");
  });

  it("clearing the inbox is not a database deletion", () => {
    const service = code("server/services/dev-tools.ts");
    // An in-process Map. No family_requests row, no delivery history, nothing
    // that a production reset would have to reason about.
    expect(service).not.toMatch(/delete|drop|truncate/i);
  });
});

describe("5. what the inbox shows, and what it refuses to show", () => {
  const page = source("app/dev/family-inbox/page.tsx");

  it("shows the recipient, the body and a link — and nothing operational", () => {
    expect(page).toContain("recipientDisplayName");
    expect(page).toContain("message.body");
    expect(page).toContain("message.responseUrl");
    expect(page).toContain("Open reply");
    expect(page).toContain("No family messages yet.");

    // The fields a database inspector would show, and this is not one.
    for (const field of ["deliveredAt", "reference", "channel", "createdAt", "status"]) {
      expect(page, `renders ${field}`).not.toMatch(new RegExp(`\\{\\s*message\\.${field}`));
    }
  });

  it("the request id is a React key and never text", () => {
    // `key=` is React bookkeeping and never reaches the document; the same id
    // printed in the markup would be an internal identifier on a demo prop.
    const ids = page.match(/message\.requestId/g) ?? [];
    expect(ids).toHaveLength(1);
    expect(page).toContain("key={message.requestId}");
    expect(page).not.toMatch(/>\s*\{message\.requestId\}/);
  });

  it("the token is a link target, never visible text", () => {
    // The capability URL is the href and only the href. Printed as text it
    // would be read aloud by a screen reader and copied into a screenshot.
    expect(page).toContain("href={message.responseUrl}");
    expect(page).not.toMatch(/>\s*\{message\.responseUrl\}/);
    // And it is used as recorded: this page cannot mint or rebuild a token.
    for (const minting of ["familyRespondUrl", "hashFamilyToken", "randomBytes", "mintToken"]) {
      expect(page, minting).not.toContain(minting);
    }
  });

  it("the body is rendered by the same component the family page uses", () => {
    // Not a second presentation of the approved text. If one of them ever
    // starts wrapping or escaping differently, both change together.
    expect(page).toContain("QuotedText");
    expect(source("app/family/respond/[token]/page.tsx")).toContain("QuotedText");
  });

  it("newest first, which is the order the notifier already returns", () => {
    // Asserted against the adapter rather than restated in the page: a page
    // that re-sorted would be a second opinion about delivery order.
    expect(code("server/adapters/notifier.ts")).toContain(
      "b.deliveredAt.localeCompare(a.deliveredAt)",
    );
    expect(page).not.toContain(".sort(");
    expect(page).not.toContain(".reverse()");
  });
});

describe("6. George's product contains no door into John's inbox", () => {
  it("the page renders the operator control only in development", () => {
    const home = code("app/page.tsx");
    // One server-side decision, used for every dev affordance. Production
    // renders none of them, so none of them reach the bundle.
    expect(home).toContain("isDebugSurfaceEnabled(process.env)");
    expect(home).toMatch(/devTools=\{\s*isDev \?/);
    expect(home).toContain("<FamilyInboxLink />");
  });

  it("the link lives with the operator controls, not in the conversation", () => {
    const link = source("app/_components/dev-operator.tsx");
    const home = code("app/page.tsx");
    const chat = source("app/_components/chat.tsx");

    expect(link).toContain('href="/dev/family-inbox"');
    // Rendered beside the reset control, in the dev-only slot, never inside
    // the conversation itself.
    expect(home).toMatch(/isDev \? \([\s\S]*<FamilyInboxLink \/>[\s\S]*<DemoResetButton/);
    // The chat itself knows nothing about it. George is not being shown a way
    // into his family's messages; the demo operator is.
    expect(chat).not.toContain("family-inbox");
    expect(chat).not.toContain("Open family inbox");
  });

  it("the link is a server component, so production never bundles it", () => {
    // A client component is bundled whether or not anything renders it. This
    // link was written into `dev-tools.tsx` first, and shipped the string to
    // every production browser as dead code - which is the whole reason it
    // lives in its own server-rendered file.
    // The comment explains why there is no directive; only executable text
    // decides whether there is one.
    expect(code("app/_components/dev-operator.tsx")).not.toContain('"use client"');
    expect(code("app/_components/dev-hint.tsx")).not.toContain('"use client"');
    expect(source("app/_components/dev-tools.tsx")).not.toContain("family-inbox");
  });

  it("and the built client bundle proves it", () => {
    // Checks the actual build output when there is one, rather than trusting
    // the reasoning above. Skipped on a machine that has not built yet.
    const dir = ".next/static";
    if (!existsSync(dir)) return;

    const offenders: string[] = [];
    const walk = (path: string) => {
      for (const entry of readdirSync(path)) {
        const full = join(path, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (entry.endsWith(".js")) {
          const text = readFileSync(full, "utf8");
          for (const needle of ["family-inbox", "Open family inbox", "No family messages"]) {
            if (text.includes(needle)) offenders.push(`${full}: ${needle}`);
          }
        }
      }
    };
    walk(dir);
    expect(offenders).toEqual([]);
  });
});


describe("7. the viewer is reachable only from the operator's own machine", () => {
  /**
   * WHAT THIS BOUNDARY IS, AND WHAT IT IS NOT.
   *
   * The gate above proves the demo secret is CONFIGURED. It does not prove the
   * caller knows it - a browser navigating to a page cannot present a header,
   * and putting the secret in a URL to fix that would be worse than the problem.
   * So the page is development-gated, not caller-authenticated, and saying
   * otherwise would be inventing a security property.
   *
   * What it does have is a host check. `next dev` prints a LAN URL beside the
   * localhost one, and this page puts a live family capability link in an
   * href; anyone on the same coffee-shop network could otherwise open it. The
   * Host header is supplied by the client and a determined caller can forge
   * it, so this stops casual reachability, not an attacker. It is a demo aid
   * with a door, never an authentication mechanism, and it is only ever one of
   * five conditions - none of which exist outside local development.
   */
  it("the hosts the demo actually runs on are allowed", () => {
    for (const host of ["localhost:3000", "localhost", "127.0.0.1:3000", "127.0.0.1", "[::1]:3000", "[::1]"]) {
      expect(isLocalOperatorHost({ host }), host).toBe(true);
    }
  });

  it("the LAN URL `next dev` prints beside it is not", () => {
    for (const host of [
      "192.168.1.14:3000",   // the one next dev prints
      "10.0.0.5:3000",
      "172.16.4.9:3000",
      "careloop.example.com",
      "0.0.0.0:3000",        // bound everywhere is not the same as loopback
      "localhost.example.com",
      "notlocalhost",
      "127.0.0.1.example.com",
      "evil-localhost",
    ]) {
      expect(isLocalOperatorHost({ host }), host).toBe(false);
    }
  });

  it("an absent or empty Host fails closed", () => {
    expect(isLocalOperatorHost({ host: null })).toBe(false);
    expect(isLocalOperatorHost({ host: "" })).toBe(false);
    expect(isLocalOperatorHost({ host: "   " })).toBe(false);
  });

  it("a proxy in front of it fails closed, whatever it rewrote Host to", () => {
    // `x-forwarded-host` present at all means the request did not arrive
    // directly, so the Host header is whatever the hop decided it should be.
    expect(isLocalOperatorHost({ host: "localhost:3000", forwardedHost: "careloop.example.com" })).toBe(false);
    expect(isLocalOperatorHost({ host: "localhost:3000", forwardedHost: "192.168.1.14" })).toBe(false);
    // A loopback forward is still loopback, and is allowed.
    expect(isLocalOperatorHost({ host: "localhost:3000", forwardedHost: "localhost:3000" })).toBe(true);
  });

  it("host casing does not decide it", () => {
    expect(isLocalOperatorHost({ host: "LOCALHOST:3000" })).toBe(true);
    expect(isLocalOperatorHost({ host: "LocalHost" })).toBe(true);
  });

  it("the page composes all five conditions, and the host is one of them", () => {
    const page = code("app/dev/family-inbox/page.tsx");
    expect(page).toContain("isDebugSurfaceEnabled");
    expect(page).toContain("authorizeDevSeed");
    expect(page).toContain("isLocalOperatorHost");
    // Read from the request, not from configuration.
    expect(page).toMatch(/await headers\(\)/);
    expect(page).toContain('"host"');
    expect(page).toContain('"x-forwarded-host"');
    // Every failure is the same 404. A different answer per reason would tell
    // a prober which condition they had satisfied.
    expect((page.match(/notFound\(\)/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });

  it("the page does not claim the caller presented the secret", () => {
    // The comment is part of the deliverable here: an overclaimed security
    // note is how a reviewer is talked out of checking.
    const doc = source("app/dev/family-inbox/page.tsx");
    expect(doc).toMatch(/not caller-authenticated|does not prove the caller|not authentication/i);
  });

  it("the operator link is a bare local path with nothing attached to it", () => {
    const link = source("app/_components/dev-operator.tsx");
    expect(link).toContain('href="/dev/family-inbox"');
    // No query string, no secret, no absolute LAN origin baked in.
    expect(link).not.toMatch(/href="[^"]*\?/);
    expect(link).not.toContain("http://");
    expect(link).not.toContain("CARELOOP_DEV_SEED_SECRET");
  });
});
