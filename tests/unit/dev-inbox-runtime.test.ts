import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * WHERE THE DEV INBOX ACTUALLY LIVES.
 *
 * Live acceptance found the family inbox empty after a delivery that had
 * plainly succeeded: the request was authorized, consent was spent,
 * `family.delivery` said delivered, and the capability URL worked when opened
 * by hand. Nothing was wrong with the delivery. The inbox was reading a
 * different Map from the one the delivery had written.
 *
 * A module-level `const` is scoped to a MODULE EVALUATION, not to a process.
 * Next 16 with Turbopack builds separate server bundles for a route handler
 * and a server component, and a module reachable from both can be instantiated
 * once per bundle - and again on every hot reload. Two Maps, one of them
 * always empty, and no error anywhere to say so.
 *
 * These tests are written to tell those two lifetimes apart. `vi.resetModules`
 * throws away the module registry, so a re-import RE-EVALUATES the module
 * exactly as a second bundle would, inside this one process. Anything that
 * survives that is process-scoped; anything that does not was never shared in
 * the first place.
 *
 * A test that imported the writer and the reader from one cached module would
 * pass against the bug, which is why the imports below are deliberately split
 * across resets.
 */
const DEV = { NODE_ENV: "development" } as NodeJS.ProcessEnv;

const message = (requestId: string, body: string) => ({
  requestId,
  channel: "sms",
  address: "+15550000",
  recipientDisplayName: "John",
  body,
  responseUrl: `http://localhost:3000/family/respond/token-${requestId}`,
});

/** One module evaluation that sends, then is thrown away. */
async function sendFromAFreshModule(requestId: string, body: string) {
  vi.resetModules();
  const { createDevNotifier } = await import("@/server/adapters/notifier");
  return createDevNotifier(DEV).send(message(requestId, body));
}

/** A different module evaluation that reads, as the page's bundle would. */
async function readFromAFreshModule() {
  vi.resetModules();
  const { readDevInbox } = await import("@/server/adapters/notifier");
  return readDevInbox();
}

async function clearFromAFreshModule() {
  vi.resetModules();
  const { clearDevInbox } = await import("@/server/adapters/notifier");
  clearDevInbox();
}

beforeEach(async () => {
  vi.stubEnv("NODE_ENV", "development");
  await clearFromAFreshModule();
});

afterEach(async () => {
  await clearFromAFreshModule();
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("1. the inbox outlives the module that wrote to it", () => {
  it("one module evaluation can send and read (the case that always worked)", async () => {
    vi.resetModules();
    const { createDevNotifier, readDevInbox } = await import("@/server/adapters/notifier");
    await createDevNotifier(DEV).send(message("req-1", "Hello John"));

    expect(readDevInbox().map((entry) => entry.body)).toEqual(["Hello John"]);
  });

  it("a SECOND module evaluation sees what the first one delivered", async () => {
    // THE BUG. The delivery path and the page are different bundles; this is
    // that, expressed in one process.
    await sendFromAFreshModule("req-1", "Dad was wondering — could you visit?");

    const inbox = await readFromAFreshModule();
    expect(inbox, "the page read a different inbox from the one delivery wrote").toHaveLength(1);
    expect(inbox[0].body).toBe("Dad was wondering — could you visit?");
    expect(inbox[0].responseUrl).toBe("http://localhost:3000/family/respond/token-req-1");
  });

  it("a clear from a fresh module empties the inbox the first one filled", async () => {
    await sendFromAFreshModule("req-1", "Hello John");
    expect(await readFromAFreshModule()).toHaveLength(1);

    // Reset demo runs in a server action - a third module evaluation again.
    await clearFromAFreshModule();

    // If the clear made itself a fresh empty Map and left the real one alone,
    // the next demo opens holding the previous run's reply link.
    expect(await readFromAFreshModule()).toEqual([]);
  });

  it("survives repeated re-evaluation, the way a hot reload repeats it", async () => {
    await sendFromAFreshModule("req-1", "Hello John");
    for (let i = 0; i < 5; i += 1) {
      vi.resetModules();
      await import("@/server/adapters/notifier");
    }

    expect(await readFromAFreshModule()).toHaveLength(1);
  });
});

describe("2. the behaviour that already worked still works across evaluations", () => {
  it("a retry replaces its own entry rather than appending a second", async () => {
    await sendFromAFreshModule("req-1", "Hello John");
    await sendFromAFreshModule("req-1", "Hello John");

    const inbox = await readFromAFreshModule();
    expect(inbox).toHaveLength(1);
    expect(inbox[0].requestId).toBe("req-1");
  });

  it("different requests stay separate", async () => {
    await sendFromAFreshModule("req-1", "First");
    await sendFromAFreshModule("req-2", "Second");

    const inbox = await readFromAFreshModule();
    expect(inbox).toHaveLength(2);
    expect(new Set(inbox.map((entry) => entry.requestId)).size).toBe(2);
  });

  it("newest first", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-16T10:00:00.000Z"));
    await sendFromAFreshModule("req-1", "Older");
    vi.setSystemTime(new Date("2026-09-16T11:00:00.000Z"));
    await sendFromAFreshModule("req-2", "Newer");
    vi.useRealTimers();

    expect((await readFromAFreshModule()).map((entry) => entry.body)).toEqual(["Newer", "Older"]);
  });
});

describe("3. it is memory, and it is development-only", () => {
  it("production cannot construct the notifier at all", async () => {
    vi.resetModules();
    const { createDevNotifier, NotifierUnavailableError } = await import(
      "@/server/adapters/notifier"
    );

    const env = (values: Record<string, string>) => values as NodeJS.ProcessEnv;
    expect(() => createDevNotifier(env({ NODE_ENV: "production" }))).toThrow(
      NotifierUnavailableError,
    );
    expect(() => createDevNotifier(env({ NODE_ENV: "development", VERCEL: "1" }))).toThrow(
      NotifierUnavailableError,
    );
    // An unset NODE_ENV fails closed too - an allow-list, not a deny-list.
    expect(() => createDevNotifier(env({}))).toThrow(NotifierUnavailableError);
  });

  it("nothing was written anywhere durable", async () => {
    const { readFileSync } = await import("node:fs");
    const source = readFileSync("server/adapters/notifier.ts", "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");

    // The capability URL lives in memory for the length of a dev server's
    // life, and nowhere else. Not a column, not a table, not a file.
    for (const persistence of [
      "writeFile",
      "appendFile",
      "readFile",
      "node:fs",
      "localStorage",
      "supabase",
      "from(",
      "insert",
      "upsert",
      "family_requests",
    ]) {
      expect(source, persistence).not.toContain(persistence);
    }
  });
});

describe("4. the capability URL is not written to the terminal", () => {
  it("the console line carries the message, and no token", async () => {
    vi.resetModules();
    const { createDevNotifier } = await import("@/server/adapters/notifier");
    const logged: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((line) => {
      logged.push(String(line));
    });

    await createDevNotifier(DEV).send(message("req-1", "Dad was wondering — could you visit?"));
    spy.mockRestore();

    const printed = logged.join("\n");
    expect(printed).toContain("Dad was wondering");
    // Scrollback is a screen share, a screenshot and a shell history file.
    expect(printed, "a capability token was printed").not.toContain("token-req-1");
    expect(printed).not.toContain("/family/respond/");
    expect(printed).not.toMatch(/https?:\/\//);
  });

  it("the structured delivery log still carries only a hash prefix", async () => {
    vi.resetModules();
    const { logDelivery } = await import("@/server/adapters/notifier");
    const logged: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((line) => {
      logged.push(String(line));
    });

    logDelivery({
      requestId: "req-1",
      opportunityId: "opp-1",
      channel: "sms",
      tokenHash: "a".repeat(64),
      outcome: "delivered",
      latencyMs: 12,
    });
    spy.mockRestore();

    const record = JSON.parse(logged[0]!) as Record<string, unknown>;
    expect(record.event).toBe("family.delivery");
    expect(String(record.tokenHashPrefix).length).toBeLessThan(64);
    expect(JSON.stringify(record)).not.toContain("/family/respond/");
    expect(record).not.toHaveProperty("responseUrl");
    expect(record).not.toHaveProperty("body");
  });
});
