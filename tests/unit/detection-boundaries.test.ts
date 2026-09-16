import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { authorizeDevSeed } from "@/server/config";
import { assembleContext, EMPTY_MEMORY } from "@/server/services/context";

const read = (path: string) => readFileSync(path, "utf8");

/**
 * Boundaries M4 must not cross. Several are source-level assertions, which is
 * deliberate: "detection runs after the response" and "the draft never reaches
 * the conversational model" are properties of WHERE code is called from, and a
 * behavioural test would pass just as happily with the call in the wrong place.
 */
describe("1. detection never touches time-to-first-token", () => {
  const route = read("app/api/chat/route.ts");

  it("runs the sweep inside after(), below the streamed response", () => {
    const afterIndex = route.indexOf("after(async () => {");
    const sweepIndex = route.indexOf("runDetectionSweep(");
    expect(afterIndex).toBeGreaterThan(-1);
    expect(sweepIndex).toBeGreaterThan(afterIndex);
  });

  it("does not construct the reconnect deps before the stream", () => {
    const streamIndex = route.indexOf("const stream = new ReadableStream");
    expect(route.indexOf("createReconnectDeps()")).toBeGreaterThan(streamIndex);
  });

  it("isolates a detection failure from the conversation", () => {
    expect(route).toContain('event: "detection.sweep_failed"');
    // Its own try/catch, so a renderer outage cannot roll back ingestion.
    const sweepIndex = route.indexOf("runDetectionSweep(");
    const catchIndex = route.indexOf("detection.sweep_failed");
    expect(catchIndex).toBeGreaterThan(sweepIndex);
  });
});

describe("2. the conversational model is never given the draft", () => {
  it("MemorySections has no field that could carry the text or the hash", () => {
    const keys = Object.keys(EMPTY_MEMORY);
    for (const forbidden of ["renderedText", "renderedTextHash", "sharePayload", "draft"]) {
      expect(keys).not.toContain(forbidden);
    }
    // The only reconnect-shaped field is a marker, and M4 does not fill it.
    expect(EMPTY_MEMORY.draftedOpportunityMarker).toBeNull();
  });

  it("the marker type is exactly { entityId, entityName, status } (E1)", () => {
    const source = read("server/services/context.ts");
    expect(source).toMatch(/export type DraftedOpportunityMarker = \{\s*entityId: string;\s*entityName: string;\s*status: "drafted";\s*\}/);
  });

  it("assembled context for an ordinary turn contains no draft anywhere", () => {
    const context = assembleContext({
      recentTurns: [
        { id: "m1", role: "user", content: "The garden is coming along", createdAt: "2026-09-16T10:00:00.000Z" },
      ],
    });
    const serialized = JSON.stringify(context);
    for (const leak of ["rendered_text", "renderedText", "sharePayload", "ask_if_visiting"]) {
      expect(serialized).not.toContain(leak);
    }
  });

  it("M4 does not wire the marker: context still refuses one", () => {
    expect(() =>
      assembleContext({
        recentTurns: [],
        memory: {
          ...EMPTY_MEMORY,
          draftedOpportunityMarker: { entityId: "e1", entityName: "John", status: "drafted" },
        },
      }),
    ).toThrow();
  });
});

describe("3. the development detection endpoint is gated exactly like the seeder", () => {
  const route = read("app/api/dev/detect/route.ts");

  it("routes its decision through authorizeDevSeed", () => {
    expect(route).toMatch(/authorizeDevSeed\(\s*process\.env,/);
    expect(route).toContain('request.headers.get("x-careloop-dev-secret")');
  });

  it("answers a refusal with a bare 404 that does not advertise the route", () => {
    expect(route).toMatch(/new NextResponse\("Not Found", \{ status: 404 \}\)/);
    // No reason code, no hint about which of the four conditions failed.
    expect(route).not.toContain("auth.reason");
  });

  it("never accepts a user id from the request", () => {
    expect(route).toContain("getCurrentUserId()");
    expect(route).not.toMatch(/body[^\n]*userId|searchParams[^\n]*user/);
  });

  it("does not return the draft bytes — the sweep result carries only a hash", () => {
    const service = read("server/services/reconnect.ts");
    const draftResult = service.slice(
      service.indexOf("export type DraftResult = {"),
      service.indexOf("export type DetectionSweepResult"),
    );
    expect(draftResult).toContain("renderedTextHash?: string;");
    expect(draftResult).not.toMatch(/\brenderedText\s*[?:]/);
  });

  it("the gate itself is an allow-list and fails closed", () => {
    const SECRET = "s3cret";
    const localDev = { NODE_ENV: "development", CARELOOP_DEV_SEED_SECRET: SECRET };
    expect(authorizeDevSeed(localDev, SECRET)).toEqual({ allowed: true });
    for (const env of ["production", "test", "staging", "prod", undefined]) {
      expect(authorizeDevSeed({ NODE_ENV: env, CARELOOP_DEV_SEED_SECRET: SECRET }, SECRET).allowed).toBe(false);
    }
    expect(authorizeDevSeed({ ...localDev, VERCEL: "1" }, SECRET).allowed).toBe(false);
    expect(authorizeDevSeed({ NODE_ENV: "development" }, SECRET).allowed).toBe(false);
    expect(authorizeDevSeed({ ...localDev, CARELOOP_DEV_SEED_SECRET: "" }, "").allowed).toBe(false);
    expect(authorizeDevSeed(localDev, "wrong").allowed).toBe(false);
    expect(authorizeDevSeed(localDev, null).allowed).toBe(false);
  });
});

describe("4. M5 belongs to M5", () => {
  const reconnect = read("server/services/reconnect.ts");

  it("nothing in M4 creates consent, family requests, tokens or closures", () => {
    for (const forbidden of [
      "consent_grants", "consentGrant", "family_requests\"", "access_token",
      "magic", "notifier", "closure",
    ]) {
      expect(reconnect).not.toContain(forbidden);
    }
  });

  it("no status past `drafted` is ever written", () => {
    for (const forbidden of ['"offered"', '"approved"', '"consumed"', '"declined"']) {
      // They appear in reads (open/terminal partitions) but are never assigned.
      expect(reconnect).not.toContain(`status: ${forbidden}`);
    }
    expect(read("server/repositories/opportunities.ts")).not.toMatch(/status: "(offered|approved|consumed|declined)"/);
  });

  it("the migration is additive and creates no table or column", () => {
    const migration = read("supabase/migrations/20260916140000_m4_materialize_signal.sql");
    expect(migration).not.toMatch(/create table|alter table|drop /i);
    expect(migration).toMatch(/create or replace function public\.materialize_signal/);
    expect(migration).toContain("set search_path = pg_catalog, public, pg_temp");
    expect(migration).toMatch(/revoke all on function public\.materialize_signal[\s\S]*from public, anon, authenticated/);
    expect(migration).toMatch(/grant execute on function public\.materialize_signal[\s\S]*to service_role/);
    expect(migration).not.toMatch(/security definer/i);
  });
});
