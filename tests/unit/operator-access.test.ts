import { describe, expect, it, vi } from "vitest";

/**
 * The one gate every operator surface asks (M12f).
 *
 * The demo controls are back on the CareLoop page, which previously
 * checked only `isDebugSurfaceEnabled` — one of the four conditions. This
 * is the function that made putting them back safe, so it is tested as a
 * function rather than by reading the pages that call it.
 */
const requestHeaders = vi.hoisted(() => ({ host: "localhost:3000", forwarded: null as string | null }));
vi.mock("next/headers", () => ({
  headers: async () => ({
    get: (name: string) =>
      name === "host" ? requestHeaders.host : name === "x-forwarded-host" ? requestHeaders.forwarded : null,
  }),
}));

const { operatorAccessAllowed } = await import("@/server/auth/operator-access");

const DEV = { NODE_ENV: "development", CARELOOP_DEV_SEED_SECRET: "s3cret" } as unknown as NodeJS.ProcessEnv;

describe("operatorAccessAllowed", () => {
  it("allows local development, on a loopback host, with a secret configured", async () => {
    requestHeaders.host = "localhost:3000";
    requestHeaders.forwarded = null;
    expect(await operatorAccessAllowed(DEV)).toBe(true);
  });

  it.each(["127.0.0.1:3000", "[::1]:3000"])("allows %s too", async (host) => {
    requestHeaders.host = host;
    requestHeaders.forwarded = null;
    expect(await operatorAccessAllowed(DEV)).toBe(true);
  });

  it("refuses production", async () => {
    expect(
      await operatorAccessAllowed({ ...DEV, NODE_ENV: "production" } as NodeJS.ProcessEnv),
    ).toBe(false);
  });

  it("refuses a deployment even with NODE_ENV tampered with", async () => {
    expect(await operatorAccessAllowed({ ...DEV, VERCEL: "1" } as NodeJS.ProcessEnv)).toBe(false);
  });

  it("refuses when no dev seed secret is configured", async () => {
    expect(
      await operatorAccessAllowed({ NODE_ENV: "development" } as unknown as NodeJS.ProcessEnv),
    ).toBe(false);
  });

  it("refuses a non-loopback host", async () => {
    requestHeaders.host = "careloop.example.com";
    requestHeaders.forwarded = null;
    expect(await operatorAccessAllowed(DEV)).toBe(false);
  });

  it("refuses a forwarded non-loopback host — a proxy is not a loopback", async () => {
    requestHeaders.host = "localhost:3000";
    requestHeaders.forwarded = "careloop.example.com";
    expect(await operatorAccessAllowed(DEV)).toBe(false);
  });

  it("asks for a secret it never puts anywhere a browser could read", async () => {
    // Supplying the configured secret to itself asserts that ONE EXISTS.
    // It is an environment condition, not caller authentication — nobody
    // is asked to know anything, and there is no token, header or query
    // parameter that turns this on.
    const source = (await import("node:fs")).readFileSync(
      "server/auth/operator-access.ts",
      "utf8",
    );
    expect(source).toContain('import "server-only"');
    for (const leak of ["searchParams", "?secret", "localStorage", "NEXT_PUBLIC"]) {
      expect(source, leak).not.toContain(leak);
    }
  });
});
