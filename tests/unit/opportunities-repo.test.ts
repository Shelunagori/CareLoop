import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { opportunitiesRepo } from "@/server/repositories/opportunities";
import type { Db } from "@/server/repositories/db";

/**
 * The supabase client is stateful, and its methods read that state through
 * `this`. Extracting one — `const rpc = db.rpc` — typechecks perfectly and
 * then dies at runtime with "Cannot read properties of undefined (reading
 * 'rest')", which is exactly what M4 live acceptance hit.
 *
 * So these tests exercise the real repository against a client stand-in that
 * FAILS THE SAME WAY the real one does, rather than asserting on a mocked
 * return value. A test that only stubbed `rpc` to resolve an object would have
 * passed against the broken code.
 */
const UUID = "0f9b6f1e-0000-4000-8000-000000000001";

function clientSpy(result: unknown = { outcome: "materialized", opportunityId: UUID }) {
  const calls: Array<{ name: string; args: Record<string, unknown>; receiverOk: boolean }> = [];

  const client = {
    rpc(this: unknown, name: string, args: Record<string, unknown>) {
      const receiverOk = this === client;
      calls.push({ name, args, receiverOk });
      if (!receiverOk) {
        // The real client reads instance state here. Reproduced verbatim so a
        // detached call fails in the test the way it failed in production.
        throw new TypeError("Cannot read properties of undefined (reading 'rest')");
      }
      return Promise.resolve({ data: result, error: null });
    },
  };

  return { client, calls, asDb: client as unknown as Db };
}

describe("1. materialize calls the RPC on the client itself", () => {
  it("keeps the client as the receiver", async () => {
    const spy = clientSpy();

    const result = await opportunitiesRepo(spy.asDb).materialize({
      signalId: "sig-1",
      userId: "user-1",
      entityId: "entity-1",
      proposal: { entityName: "John" },
      expiresAt: "2026-09-17T12:00:00.000Z",
      now: "2026-09-16T12:00:00.000Z",
    });

    expect(spy.calls).toHaveLength(1);
    // The assertion that would have caught the live failure.
    expect(spy.calls[0].receiverOk).toBe(true);
    expect(result).toEqual({ outcome: "materialized", opportunityId: UUID });
  });

  it("passes exactly the six arguments the function declares", async () => {
    const spy = clientSpy();
    await opportunitiesRepo(spy.asDb).materialize({
      signalId: "sig-1",
      userId: "user-1",
      entityId: "entity-1",
      proposal: { entityName: "John" },
      expiresAt: "2026-09-17T12:00:00.000Z",
      now: "2026-09-16T12:00:00.000Z",
    });

    expect(spy.calls[0].name).toBe("materialize_signal");
    expect(Object.keys(spy.calls[0].args).sort()).toEqual([
      "p_entity_id",
      "p_expires_at",
      "p_now",
      "p_proposal",
      "p_signal_id",
      "p_user_id",
    ]);
    expect(spy.calls[0].args).toMatchObject({
      p_signal_id: "sig-1",
      p_user_id: "user-1",
      p_entity_id: "entity-1",
      p_expires_at: "2026-09-17T12:00:00.000Z",
      p_now: "2026-09-16T12:00:00.000Z",
    });
  });

  it("validates the returned shape rather than trusting it", async () => {
    const spy = clientSpy({ outcome: "something_new", opportunityId: null });
    await expect(
      opportunitiesRepo(spy.asDb).materialize({
        signalId: "sig-1",
        userId: "user-1",
        entityId: "entity-1",
        proposal: {},
        expiresAt: "2026-09-17T12:00:00.000Z",
        now: "2026-09-16T12:00:00.000Z",
      }),
    ).rejects.toThrow(/unrecognised result shape/);
  });

  it("surfaces a database error instead of parsing it", async () => {
    const client = {
      rpc() {
        return Promise.resolve({ data: null, error: { message: "permission denied" } });
      },
    };
    await expect(
      opportunitiesRepo(client as unknown as Db).materialize({
        signalId: "sig-1",
        userId: "user-1",
        entityId: "entity-1",
        proposal: {},
        expiresAt: "2026-09-17T12:00:00.000Z",
        now: "2026-09-16T12:00:00.000Z",
      }),
    ).rejects.toThrow(/materialize_signal failed: permission denied/);
  });
});

describe("2. no repository detaches a method from the client", () => {
  /**
   * The class of bug, not just the instance. Every repository takes the client
   * as a parameter and must call through it; pulling a method into a local
   * loses the binding for `rpc`, `from`, `storage` and anything else stateful.
   */
  const dir = path.join(process.cwd(), "server", "repositories");
  const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));

  it("covers every repository file", () => {
    expect(files.length).toBeGreaterThan(8);
  });

  for (const file of files) {
    it(`does not extract a client method in ${file}`, () => {
      const source = readFileSync(path.join(dir, file), "utf8");
      // `const x = db.rpc` / `let x = db.from` — an assignment that is not a call.
      const detached = /(?:const|let|var)\s+\w+\s*=\s*db\.\w+\s*(?:as[^;]*)?;/.exec(source);
      expect(detached?.[0] ?? null).toBeNull();
    });
  }
});
