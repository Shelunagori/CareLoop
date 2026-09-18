import { describe, expect, it } from "vitest";
import {
  InvalidPublicBaseUrlError,
  isDemoModeEnabled,
  publicBaseUrl,
} from "@/server/config";

/**
 * The two switches that decide whether a deployment is a public demo, and
 * where a family member's capability link points.
 *
 * Both are allow-lists. A deny-list on "production" is how a misspelled or
 * absent NODE_ENV quietly authenticates a request, and the same reasoning
 * applies to a flag that turns a private deployment into a public one: every
 * value that is not exactly the one we mean must fail closed.
 */
const env = (values: Record<string, string | undefined>) => values as NodeJS.ProcessEnv;

describe("1. demo mode is off unless it is switched on, exactly", () => {
  it("only the literal string enables it", () => {
    expect(isDemoModeEnabled(env({ CARELOOP_DEMO_MODE: "true" }))).toBe(true);
  });

  it("everything else is off", () => {
    for (const value of [
      undefined,
      "",
      "   ",
      "false",
      "FALSE",
      "0",
      "1",
      "yes",
      "on",
      "enabled",
      "True",
      "TRUE",
      " true",
      "true ",
      "truthy",
    ]) {
      expect(isDemoModeEnabled(env({ CARELOOP_DEMO_MODE: value })), JSON.stringify(value)).toBe(
        false,
      );
    }
    // Not configured at all.
    expect(isDemoModeEnabled(env({}))).toBe(false);
  });

  it("nothing else in the environment can turn it on", () => {
    // Not NODE_ENV, not a deployment, not the dev secret. Demo mode is a
    // deliberate act of configuration and has exactly one cause.
    expect(
      isDemoModeEnabled(
        env({ NODE_ENV: "production", VERCEL: "1", CARELOOP_DEV_SEED_SECRET: "s" }),
      ),
    ).toBe(false);
  });
});

describe("2. the capability link points somewhere a family member can reach", () => {
  const DEPLOYED = { NODE_ENV: "production", VERCEL: "1" };

  it("local development keeps its localhost default", () => {
    // Unchanged on purpose: the whole local demo depends on it.
    expect(publicBaseUrl(env({ NODE_ENV: "development" }))).toBe("http://localhost:3000");
    expect(
      publicBaseUrl(env({ NODE_ENV: "development", CARELOOP_PUBLIC_BASE_URL: "http://localhost:4000" })),
    ).toBe("http://localhost:4000");
  });

  it("a deployment must be told, and is never guessed", () => {
    // The old behaviour silently returned localhost here, which would have
    // sent every family member a link to their own machine.
    for (const missing of [undefined, "", "   "]) {
      expect(
        () => publicBaseUrl(env({ ...DEPLOYED, CARELOOP_PUBLIC_BASE_URL: missing })),
        JSON.stringify(missing),
      ).toThrow(InvalidPublicBaseUrlError);
    }
  });

  it("a deployment refuses localhost however it is spelled", () => {
    for (const url of [
      "http://localhost:3000",
      "https://localhost:3000",
      "https://127.0.0.1",
      "https://[::1]:3000",
      "http://0.0.0.0:3000",
    ]) {
      expect(() => publicBaseUrl(env({ ...DEPLOYED, CARELOOP_PUBLIC_BASE_URL: url })), url).toThrow(
        InvalidPublicBaseUrlError,
      );
    }
  });

  it("a deployment requires https, because the link carries a capability", () => {
    for (const url of ["http://careloop.example.com", "ftp://careloop.example.com"]) {
      expect(() => publicBaseUrl(env({ ...DEPLOYED, CARELOOP_PUBLIC_BASE_URL: url })), url).toThrow(
        InvalidPublicBaseUrlError,
      );
    }
  });

  it("a deployment requires an absolute URL", () => {
    for (const url of ["careloop.example.com", "/family", "://nope", "https://"]) {
      expect(() => publicBaseUrl(env({ ...DEPLOYED, CARELOOP_PUBLIC_BASE_URL: url })), url).toThrow(
        InvalidPublicBaseUrlError,
      );
    }
  });

  it("a valid deployment URL is returned without its trailing slash", () => {
    // familyRespondUrl concatenates a path onto this, so one trailing slash
    // is the difference between a working link and a 404 for the one person
    // the whole feature exists for.
    for (const url of ["https://careloop.example.com", "https://careloop.example.com/"]) {
      expect(publicBaseUrl(env({ ...DEPLOYED, CARELOOP_PUBLIC_BASE_URL: url })), url).toBe(
        "https://careloop.example.com",
      );
    }
    expect(
      publicBaseUrl(env({ ...DEPLOYED, CARELOOP_PUBLIC_BASE_URL: "https://careloop.example.com/app/" })),
    ).toBe("https://careloop.example.com/app");
  });

  it("a non-Vercel production build is still a deployment", () => {
    // Self-hosted, a container, anything: the rule is "not local development",
    // not "not Vercel".
    expect(() => publicBaseUrl(env({ NODE_ENV: "production" }))).toThrow(InvalidPublicBaseUrlError);
    expect(() => publicBaseUrl(env({ NODE_ENV: "test" }))).toThrow(InvalidPublicBaseUrlError);
    expect(() => publicBaseUrl(env({}))).toThrow(InvalidPublicBaseUrlError);
  });

  it("the error says what is wrong without printing the value", () => {
    try {
      publicBaseUrl(env({ ...DEPLOYED, CARELOOP_PUBLIC_BASE_URL: "http://localhost:3000" }));
      throw new Error("expected a throw");
    } catch (error) {
      expect(error).toBeInstanceOf(InvalidPublicBaseUrlError);
      expect((error as Error).message).toContain("CARELOOP_PUBLIC_BASE_URL");
      expect((error as Error).message).not.toContain("localhost:3000");
    }
  });
});
