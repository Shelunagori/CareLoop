import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * GET /api/voice/nora/status — the server's word on whether Nora may run.
 *
 * This endpoint exists because a browser must not be the authority on when a
 * wake word stops being allowed. A tab left open across the cutoff, a cached
 * bundle, a device with a wrong clock, a `localStorage` flag from last week:
 * each of those is a client that believes Nora is still available, and each
 * of them asks here before doing anything privileged.
 *
 * It is also the endpoint most likely to leak a credential by accident, so
 * one of these tests is about what it does NOT contain.
 */
let currentUser: string | null = "user-1";
let now = new Date("2026-09-21T10:00:00.000Z");
let env: Record<string, string | undefined> = {
  NEXT_PUBLIC_PICOVOICE_ACCESS_KEY: "pv-access-key-value",
  NEXT_PUBLIC_NORA_KEYWORD_PATH: "/nora/Nora.ppn",
};

vi.mock("@/server/auth/current-user", () => ({
  getCurrentUserId: async () => currentUser,
}));

vi.mock("@/server/services/deps", () => ({
  createNoraStatusDeps: () => ({
    clock: { now: () => now },
    env,
  }),
}));

const { GET } = await import("@/app/api/voice/nora/status/route");

const body = async () => (await GET()).json();

beforeEach(() => {
  currentUser = "user-1";
  now = new Date("2026-09-21T10:00:00.000Z");
  env = {
    NEXT_PUBLIC_PICOVOICE_ACCESS_KEY: "pv-access-key-value",
    NEXT_PUBLIC_NORA_KEYWORD_PATH: "/nora/Nora.ppn",
  };
});

describe("1. the shape the client is promised", () => {
  it("answers available, reason and availableUntil — and nothing else", async () => {
    const json = await body();
    expect(json).toEqual({
      available: true,
      reason: null,
      availableUntil: "2026-09-25T23:59:59.999Z",
    });
  });

  it("names the reason when it is not available", async () => {
    now = new Date("2026-09-26T00:00:00.001Z");
    expect(await body()).toEqual({
      available: false,
      reason: "expired",
      availableUntil: "2026-09-25T23:59:59.999Z",
    });
  });

  it("reports not_configured before anyone has supplied a keyword", async () => {
    env = { NEXT_PUBLIC_PICOVOICE_ACCESS_KEY: "pv-access-key-value" };
    const json = await body();
    expect(json.available).toBe(false);
    expect(json.reason).toBe("not_configured");
  });
});

describe("2. the server's clock decides, not the caller's", () => {
  it("is available at the cutoff instant", async () => {
    now = new Date("2026-09-25T23:59:59.999Z");
    expect((await body()).available).toBe(true);
  });

  it("is unavailable one millisecond later", async () => {
    now = new Date("2026-09-26T00:00:00.000Z");
    expect((await body()).available).toBe(false);
  });

  it("takes no date from the request — there is nothing to take one from", async () => {
    // GET, no body, no query read. A stale client cannot argue about the time.
    expect(GET.length).toBe(0);
  });
});

describe("3. nothing secret leaves through this route", () => {
  it("the response never contains the access key", async () => {
    const response = await GET();
    const text = await response.text();
    expect(text).not.toContain("pv-access-key-value");
    expect(text).not.toMatch(/accessKey|PICOVOICE/i);
  });

  it("the response never contains the keyword path either", async () => {
    // Harmless in itself, but the rule is simpler to keep than to qualify:
    // this endpoint answers a question about time, not about configuration.
    const text = await (await GET()).text();
    expect(text).not.toContain("Nora.ppn");
  });
});

describe("4. it is the person's own endpoint", () => {
  it("refuses an unauthenticated caller", async () => {
    currentUser = null;
    const response = await GET();
    expect(response.status).toBe(401);
  });
});
