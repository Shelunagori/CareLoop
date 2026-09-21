import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { computeCadenceThreshold } from "@/core/baseline/compute";
import { DAY_MS } from "@/core/baseline/day";
import {
  ensureBlankConversation,
  fixtureUuid,
  readDemoState,
  resetDemoFixture,
  seedDemoFixture,
  type DemoFixtureDeps,
} from "@/server/services/demo-fixture";
import { DEMO_GEORGE } from "@/fixtures/demo/george";
import { authorizeDevSeed, isDebugSurfaceEnabled } from "@/server/config";
import type { DemoFixtureSpec } from "@/fixtures/demo/types";
import {
  createStore,
  fakeEmbeddings,
  fakeMemoryRepos,
  resetIds,
  type MemoryStore,
} from "./memory-fakes";
import {
  fakeConversations,
  fakeMessages,
  fixtureChat,
  fixtureDecisions,
  fixtureDeps,
  fixtureProfiles,
  resetFixtureFakes,
} from "./demo-fixture-fakes";
import { loadMemoryForTurn } from "@/server/services/memory-retrieval";
import { recoverStatedAbsencePhrase } from "@/core/memory/absence-phrase";
import { EMPTY_EXTRACTION } from "@/core/memory/extraction-contract";
import { resolveAbsenceWindow } from "@/core/memory/temporal";

/**
 * The demo fixture (M6).
 *
 * Two things are being proved here, and they pull in opposite directions. The
 * fixture has to produce state good enough to demo from - which tempts it to
 * write whatever makes the demo look right - and it has to produce only state
 * the ordinary pipeline could have produced, or the demo is a lie about the
 * architecture. Every test below is on one side or the other of that line.
 */
const USER = "user-george";
const OTHER_USER = "user-someone-else";
const NOW = new Date("2026-09-16T12:00:00.000Z");

let store: MemoryStore;

/**
 * The repository fakes now live in ./demo-fixture-fakes, shared with the M10
 * isolation suite. Aliased to their original names here so the assertions
 * below are unchanged - one fake, two suites, no second opinion about how the
 * repositories behave.
 */
const decisions = fixtureDecisions;
const chat = fixtureChat;
const profiles = fixtureProfiles;
const deps = (): DemoFixtureDeps => fixtureDeps({ store, profiles, now: NOW });

const seed = (spec: DemoFixtureSpec = DEMO_GEORGE) =>
  seedDemoFixture(deps(), { userId: USER, spec, now: NOW });

beforeEach(() => {
  resetIds();
  store = createStore();
  resetFixtureFakes();
});

describe("1. one run produces the demo's starting state", () => {
  it("creates the profile, both entities and all three relationships", async () => {
    const result = await seed();

    expect(profiles.get(USER)).toEqual({
      displayName: "George",
      familyDisplayName: "Dad",
    });
    expect(result.entities.map((e) => e.displayName).sort()).toEqual(["John", "Simba"]);
    expect(store.entities.find((e) => e.displayName === "Simba")?.type).toBe("pet");
    expect(result.relationships).toHaveLength(3);
  });

  it("the entity types and subtypes match what the demo claims", async () => {
    await seed();
    const john = store.entities.find((e) => e.displayName === "John");
    const simba = store.entities.find((e) => e.displayName === "Simba");
    expect(john).toMatchObject({ type: "person", subtype: null });
    // `subtype` is descriptive only; nothing branches on it.
    expect(simba).toMatchObject({ type: "pet", subtype: "dog" });
    // A recorded alias, on purpose: the acceptance case that matters is a
    // person who HAS one, where the companion must still lead with "John".
    expect(john?.aliases).toContain("Johnny");
  });

  it("writes the visit history as ordinary interaction events", async () => {
    const result = await seed();
    expect(result.interactionEvents).toBe(6);

    const john = store.entities.find((e) => e.displayName === "John")!;
    const events = store.interactionEvents.filter((e) => e.entityId === john.id);
    expect(events).toHaveLength(6);
    for (const event of events) {
      expect(event.polarity).toBe("positive");
      expect(event.eventType).toBe("visit");
      // An absence assertion is the LIVE leg of the demo and is deliberately
      // not seeded: it has to come from the conversation.
      expect(event.windowStart).toBeNull();
      expect(event.windowEnd).toBeNull();
    }
  });

  it("seeds NO absence event — the demo sentence must earn its own evidence", async () => {
    await seed();
    expect(store.interactionEvents.some((e) => e.polarity === "absence")).toBe(false);
  });

  it("leaves no open decision: no signal, opportunity, consent or request", async () => {
    const state = await (async () => {
      await seed();
      return readDemoState(deps(), { userId: USER, spec: DEMO_GEORGE });
    })();

    expect(state.present).toBe(true);
    expect(state.counts).toMatchObject({
      signalsOpen: 0,
      opportunitiesOpen: 0,
      consentGrants: 0,
      familyRequests: 0,
      familyResponses: 0,
      closures: 0,
    });
  });

  it("Simba gets relational memory and NO event series", async () => {
    // The distinction the demo exists to land: what CareLoop knows about Simba
    // it knows from confirmed relationships, not from a detected pattern.
    await seed();
    const simba = store.entities.find((e) => e.displayName === "Simba")!;
    expect(store.interactionEvents.some((e) => e.entityId === simba.id)).toBe(false);
    expect([...store.baselines.keys()].some((k) => k.startsWith(simba.id))).toBe(false);
    expect(
      store.relationships.filter(
        (r) => r.toEntityId === simba.id && r.status === "confirmed",
      ),
    ).toHaveLength(2);
  });
});

describe("2. running setup twice changes nothing", () => {
  it("no duplicate entities, relationships, events, episodes or facts", async () => {
    await seed();
    const first = {
      entities: store.entities.length,
      relationships: store.relationships.length,
      events: store.interactionEvents.length,
      episodes: store.episodes.length,
      facts: store.facts.length,
    };

    await seed();

    expect({
      entities: store.entities.length,
      relationships: store.relationships.length,
      events: store.interactionEvents.length,
      episodes: store.episodes.length,
      facts: store.facts.length,
    }).toEqual(first);
  });

  it("the second run produces identical baseline statistics", async () => {
    const before = await seed();
    const after = await seed();
    expect(after.baselines).toEqual(before.baselines);
  });

  it("idempotency comes from the fingerprint, not from a check in the seeder", async () => {
    await seed();
    const fingerprints = store.interactionEvents.map((e) => e.ingestFingerprint);
    // Every event distinct within the run, and every one derived from the
    // fixture id, so a different fixture could never collide with this one.
    expect(new Set(fingerprints).size).toBe(fingerprints.length);
    await seed();
    expect(new Set(store.interactionEvents.map((e) => e.ingestFingerprint)).size).toBe(6);
  });
});

describe("3. reset removes what it owns and nothing else", () => {
  it("removes the fixture entities and everything reachable from them", async () => {
    await seed();
    const removed = await resetDemoFixture(deps(), { userId: USER, spec: DEMO_GEORGE });

    expect(removed.entitiesRemoved).toBe(2);
    expect(removed.episodesRemoved).toBe(3);
    expect(removed.factsRemoved).toBe(3);
    expect(store.entities).toHaveLength(0);
    expect(store.interactionEvents).toHaveLength(0);
    expect(store.relationships).toHaveLength(0);
    expect(store.episodes).toHaveLength(0);
    expect(store.baselines.size).toBe(0);
  });

  it("leaves unrelated entities, events and facts alone", async () => {
    await seed();
    // Something the operator built that has nothing to do with the demo.
    const stranger = await deps().entities.create({
      userId: USER,
      type: "person",
      subtype: null,
      displayName: "Margaret",
    });
    store.interactionEvents.push({
      userId: USER,
      entityId: stranger.id,
      eventType: "call",
      occurredAt: NOW.toISOString(),
      occurredAtPrecision: "day",
      reportedAt: NOW.toISOString(),
      certainty: 0.9,
      polarity: "positive",
      windowStart: null,
      windowEnd: null,
      sourceObservationId: null,
      ingestFingerprint: "not-the-fixture",
    });
    store.facts.push({
      id: "fact-keep",
      subjectEntityId: null,
      key: "favourite_tea",
      value: "builders",
      status: "confirmed",
      evidenceCount: 1,
      sourceObservationIds: [],
      sourceConversationIds: [],
    });

    await resetDemoFixture(deps(), { userId: USER, spec: DEMO_GEORGE });

    expect(store.entities.map((e) => e.displayName)).toEqual(["Margaret"]);
    expect(store.interactionEvents).toHaveLength(1);
    expect(store.facts.map((f) => f.key)).toEqual(["favourite_tea"]);
  });

  it("reset then seed returns to the same starting state", async () => {
    const first = await seed();
    await resetDemoFixture(deps(), { userId: USER, spec: DEMO_GEORGE });
    const second = await seed();

    expect(second.baselines).toEqual(first.baselines);
    expect(second.interactionEvents).toBe(first.interactionEvents);
    expect(second.relationships.map((r) => r.kind).sort()).toEqual(
      first.relationships.map((r) => r.kind).sort(),
    );
  });

  it("a reset with nothing seeded is a no-op, not an error", async () => {
    const removed = await resetDemoFixture(deps(), { userId: USER, spec: DEMO_GEORGE });
    expect(removed).toEqual({
      entitiesRemoved: 0,
      episodesRemoved: 0,
      factsRemoved: 0,
      // No manifest means nothing was ever borrowed, so nothing is put back.
      profileRestored: false,
    });
  });
});

describe("4. the relationships are the ones the demo narrates", () => {
  it("user → John = son, John → Simba = pet, user → Simba = family_pet", async () => {
    await seed();
    const john = store.entities.find((e) => e.displayName === "John")!;
    const simba = store.entities.find((e) => e.displayName === "Simba")!;

    const edge = (fromEntityId: string | null, toEntityId: string, kind: string) =>
      store.relationships.find(
        (r) => r.fromEntityId === fromEntityId && r.toEntityId === toEntityId && r.kind === kind,
      );

    // null means the user themself, exactly as the frozen schema specifies.
    expect(edge(null, john.id, "son")).toMatchObject({ status: "confirmed" });
    expect(edge(john.id, simba.id, "pet")).toMatchObject({ status: "confirmed" });
    expect(edge(null, simba.id, "family_pet")).toMatchObject({ status: "confirmed" });
  });

  it("every confirmed edge carries evidence behind it", async () => {
    // A confirmed relationship with zero evidence is a state the ingestion
    // path cannot reach. Seeding one would be the fixture lying about how the
    // demo got here.
    await seed();
    for (const rel of store.relationships) {
      expect(rel.status).toBe("confirmed");
      expect(rel.evidenceCount).toBeGreaterThan(0);
    }
  });

  it("every episode member references an entity that exists", async () => {
    await seed();
    const ids = new Set(store.entities.map((e) => e.id));
    expect(store.episodeMembers.length).toBeGreaterThan(0);
    for (const member of store.episodeMembers) expect(ids.has(member.entityId)).toBe(true);
  });

  it("the seeded episodes state observable things, never feelings", async () => {
    await seed();
    const forbidden = ["lonely", "sad", "happy", "misses", "worried", "depressed", "isolated"];
    for (const episode of store.episodes) {
      for (const word of forbidden) {
        expect(episode.summary.toLowerCase(), episode.summary).not.toContain(word);
      }
    }
  });
});

describe("5. the baseline comes from the real engine", () => {
  it("ACTIVE, median 7, MAD 0, threshold 11 — against a live gap of 13", async () => {
    const result = await seed();
    const [john] = result.baselines;

    expect(john).toMatchObject({
      entity: "John",
      eventType: "visit",
      status: "ACTIVE",
      medianGapDays: 7,
      madDays: 0,
      observationCount: 6,
      lastEventDaysAgo: 13,
    });
    // Derived by the real M3 function, not restated here: the fixture must not
    // carry its own copy of the cadence arithmetic.
    expect(john.derivedThresholdDays).toBe(computeCadenceThreshold(7, 0));
    expect(john.derivedThresholdDays).toBe(11);
    // Two days of margin, so a threshold regression breaks the demo loudly.
    expect(john.lastEventDaysAgo!).toBeGreaterThan(john.derivedThresholdDays!);
  });

  it("the baseline matches the events actually stored", async () => {
    await seed();
    const john = store.entities.find((e) => e.displayName === "John")!;
    const occurred = store.interactionEvents
      .filter((e) => e.entityId === john.id)
      // NOW is midday and the events are anchored to midnight, so each gap is
      // N days plus twelve hours. Floor, not round.
      .map((e) => Math.floor((NOW.getTime() - Date.parse(e.occurredAt)) / DAY_MS))
      .sort((a, b) => a - b);
    // Midnight-anchored, so the offsets survive the round trip exactly.
    expect(occurred).toEqual([13, 20, 27, 34, 41, 48]);
  });

  it("a user with no events still gets NO_BASELINE", async () => {
    // Cold start must be unaffected by the existence of a demo fixture.
    const spec: DemoFixtureSpec = {
      ...DEMO_GEORGE,
      id: "demo-empty.v1",
      eventSeries: [{ entityKey: "john", eventType: "visit", dayOffsets: [], certainty: 0.9 }],
      episodes: [],
    };
    const result = await seedDemoFixture(deps(), { userId: OTHER_USER, spec, now: NOW });
    expect(result.baselines[0]).toMatchObject({ status: "NO_BASELINE", observationCount: 0 });
  });
});

/**
 * Development-only files that are not under a dev path.
 *
 * The name guard's purpose is "no PRODUCTION branch depends on these names". A
 * file that cannot execute outside development is not production policy - so
 * these are exempt, and in exchange a test proves each one is actually gated.
 * Listing them individually keeps the exemption from becoming a directory.
 */
/**
 * Files that are ALLOWED to name the demo's cast, because being the demo is
 * their entire job.
 *
 * It used to be development-only surfaces. M10/M11 added the public demo, so
 * two production files now legitimately name John: the action that binds his
 * email contact, and the setup screen that asks for it. The list therefore
 * says "demo-only", and a companion test below requires every entry to gate
 * itself - so a file cannot buy its way onto this list just by being added to
 * it.
 */
/** Local-development surfaces. Gated by NODE_ENV. */
const DEV_ONLY_FILES = [
  "app/_actions/demo.ts",
  "app/_components/dev-tools.tsx",
  // M12e.3: the operator surface. It names the cast in prose (the canonical
  // opening line) and gates itself with the same four conditions
  // `/dev/family-inbox` uses. `dev-hint.tsx` is gone — its prose moved here
  // when the hint was taken off the conversation page.
  "app/dev/page.tsx",
];

/** The PUBLIC demo's own files. Gated by CARELOOP_DEMO_MODE. */
const PUBLIC_DEMO_FILES = ["app/_actions/demo-session.ts", "app/_components/demo-start.tsx"];

/**
 * A DIFFERENT exemption, deliberately not folded into the list above.
 *
 * `DEMO_ONLY_FILES` means "may touch the fixture", which is why every entry
 * must sit behind a gate. The reviewer page is not that: it names the cast in
 * PROSE, walking a reviewer through the demo script, and holds no product
 * logic at all. Publicly reachable is the point of it.
 *
 * So it is exempted from the name check only, and the test below pays for that
 * exemption by proving the page is inert - no fixture import, no service, no
 * database, no session. If it ever stops being inert, it stops being exempt.
 */
const STATIC_DOC_FILES = ["app/review/page.tsx"];

/** Everything allowed to name the cast, for whichever reason. */
const DEMO_ONLY_FILES = [...DEV_ONLY_FILES, ...PUBLIC_DEMO_FILES];

describe("6. the demo names never reach production code", () => {
  const NAMES = ["George", "Simba", "Johnny", "John"];
  const FIXTURE_PATHS = ["fixtures/", "tests/", "docs/", "app/api/dev/", "scripts/"];


  /**
   * Few-shot examples inside a PROMPT are the one legitimate place a name
   * appears in shipped code: they teach the extractor a shape, they are not
   * policy, and nothing downstream reads them. Pinned to the exact file so a
   * name leaking anywhere else still fails.
   */
  const PROMPT_EXAMPLES = ["server/prompts/extraction.v1.ts"];

  function walk(dir: string, acc: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === ".next" || entry === ".git") continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full, acc);
      else if (/\.(ts|tsx|sql)$/.test(entry)) acc.push(full);
    }
    return acc;
  }

  /** Comments explain; they do not execute. Only executable text is policy. */
  function stripComments(source: string, file: string): string {
    const withoutBlocks = source.replace(/\/\*[\s\S]*?\*\//g, "");
    return file.endsWith(".sql")
      ? withoutBlocks.replace(/--.*$/gm, "")
      : withoutBlocks.replace(/\/\/.*$/gm, "");
  }

  const productionFiles = () =>
    [...walk("core"), ...walk("server"), ...walk("app"), ...walk("supabase/migrations")]
      .map((file) => file.replace(/\\/g, "/"))
      .filter((file) => !FIXTURE_PATHS.some((prefix) => file.startsWith(prefix)));

  it("the WHOLE review subtree holds no logic at all", () => {
    /**
     * The price of naming the cast without a gate, and it is charged against
     * the entire implementation rather than one file.
     *
     * The exemption above is one exact path, `app/review/page.tsx`. That alone
     * would be worth very little: a future page.tsx could import
     * `./review-runtime`, and THAT file could reach a service or the database
     * while page.tsx still passed a check on its own imports. The exemption
     * is narrow; the proof that earns it has to cover everything the exempted
     * file can reach.
     *
     * So every .ts and .tsx under `app/review/` is inspected, including files
     * that do not exist yet.
     */
    const subtree = walk("app/review").map((file) => file.replace(/\\/g, "/"));
    expect(subtree, "app/review/ has no source files").not.toHaveLength(0);
    expect(subtree, "the exempted page is not in the subtree it is checked by").toContain(
      "app/review/page.tsx",
    );

    for (const file of subtree) {
      const source = readFileSync(file, "utf8");

      /**
       * PATH-SHAPED reaches are judged by what the file IMPORTS, not by raw
       * containment. The page documents the repository layout, so
       * "server/services/" and "core/" appear in it as sentences ABOUT the
       * code. Rewriting that prose to satisfy a substring match would be
       * gaming the check, and an import is the only way a file can actually
       * reach any of these.
       */
      const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]);
      for (const specifier of imports) {
        for (const forbidden of ["server/", "core/", "@supabase", "demo-fixture", "/api/"]) {
          expect(specifier, `${file} imports ${specifier}`).not.toContain(forbidden);
        }
        // Relative imports stay inside the subtree: `../_components/x` would
        // leave it, and `./_parts` is exactly what is allowed.
        if (specifier.startsWith(".")) {
          expect(specifier, `${file} reaches outside app/review/`).not.toContain("..");
        }
      }

      /**
       * CODE-SHAPED reaches are judged by raw containment: none of these has
       * any business appearing in a static page, in prose or otherwise.
       */
      for (const forbidden of [
        "process.env",
        "getCurrentUserId",
        "createServiceRoleClient",
        "fetch(",
        "use client",
      ]) {
        expect(source, `${file}: ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it("no demo name appears in executable production code", () => {
    const offenders: string[] = [];
    for (const file of productionFiles()) {
      if (PROMPT_EXAMPLES.includes(file)) continue;
      if (DEMO_ONLY_FILES.includes(file)) continue;
      if (STATIC_DOC_FILES.includes(file)) continue;
      const code = stripComments(readFileSync(file, "utf8"), file);
      for (const name of NAMES) {
        if (new RegExp(`\\b${name}\\b`).test(code)) offenders.push(`${file}: ${name}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("every development-only exemption is itself development-gated", () => {
    // The exemption is only sound while these files cannot run in production.
    for (const file of DEV_ONLY_FILES) {
      const source = readFileSync(file, "utf8");
      // Each is either gated itself, or is a component whose server parent
      // decides - and that parent is checked below.
      const gated =
        source.includes("isDebugSurfaceEnabled") || source.includes('"use client"');
      expect(gated, file).toBe(true);
    }
    // The server-side one runs the real gate AND the four-condition check.
    const action = readFileSync("app/_actions/demo.ts", "utf8");
    expect(action).toContain("isDebugSurfaceEnabled(process.env)");
    expect(action).toContain("authorizeDevSeed(process.env");
    // M12e.3: the OPERATOR PAGE decides whether the client control renders,
    // and the conversation page renders no developer control at all.
    const operator = readFileSync("app/dev/page.tsx", "utf8");
    expect(operator).toContain("isDebugSurfaceEnabled(process.env)");
    expect(operator).toContain("authorizeDevSeed(process.env");
    expect(operator).toContain("isLocalOperatorHost");
    expect(operator).toMatch(/<DemoResetControl/);
    const page = readFileSync("app/page.tsx", "utf8");
    expect(page).not.toContain("DemoResetControl");
  });

  it("the prompt-example allowance is exactly one file, and it is a prompt", () => {
    // If this list ever grows, someone has taught policy a name.
    expect(PROMPT_EXAMPLES).toHaveLength(1);
    for (const file of PROMPT_EXAMPLES) expect(file.startsWith("server/prompts/")).toBe(true);
  });

  it("no production code branches on a display name at all", () => {
    // The stronger statement, and the one that actually matters: policy reads
    // ids, not labels. A name it cannot compare is a name it cannot act on.
    const offenders: string[] = [];
    for (const file of productionFiles()) {
      const code = stripComments(readFileSync(file, "utf8"), file);
      if (/displayName\s*[=!]==?\s*["\'`]/.test(code)) offenders.push(`${file}: displayName ===`);
      if (/displayName\s*\.\s*includes\s*\(\s*["\'`]/.test(code)) {
        offenders.push(`${file}: displayName.includes`);
      }
      if (/switch\s*\(\s*\w*\.?displayName/.test(code)) offenders.push(`${file}: switch(name)`);
    }
    expect(offenders).toEqual([]);
  });

  it("the fixture itself is the only place the canonical names are configured", () => {
    const spec = readFileSync("fixtures/demo/george.ts", "utf8");
    for (const name of ["George", "John", "Simba"]) expect(spec).toContain(name);
    // And the seeder that reads it knows none of them.
    const seeder = readFileSync("server/services/demo-fixture.ts", "utf8");
    for (const name of ["George", "John", "Simba"]) expect(seeder).not.toContain(name);
  });
});

describe("7. every demo route is development-only", () => {
  const ROUTES = [
    "app/api/dev/demo/setup/route.ts",
    "app/api/dev/demo/state/route.ts",
  ];

  it("each one runs the four-condition gate and 404s on failure", () => {
    for (const route of ROUTES) {
      const source = readFileSync(route, "utf8");
      // The decision is DELEGATED, not re-implemented. A route that grew its
      // own copy of the gate is a route whose gate can drift.
      expect(source, route).toMatch(/authorizeDevSeed\(\s*process\.env,\s*request\.headers\.get\(/);
      expect(source, route).toContain('"x-careloop-dev-secret"');
      expect(source, route).toMatch(/if \(!auth\.allowed\)/);
      // A bare 404: the route does not advertise its own existence.
      expect(source, route).toMatch(/new NextResponse\("Not Found", \{ status: 404 \}\)/);
    }
  });

  it("the gate is the first thing each route does", () => {
    for (const route of ROUTES) {
      const source = readFileSync(route, "utf8");
      const body = source.slice(source.search(/export async function (GET|POST)\(/));
      const gate = body.indexOf("authorizeDevSeed");
      const userLookup = body.indexOf("getCurrentUserId");
      const work = body.indexOf("createDemoFixtureDeps");
      expect(gate, route).toBeGreaterThan(-1);
      // Nothing is loaded, resolved or constructed before the door is checked.
      expect(gate, route).toBeLessThan(userLookup);
      expect(gate, route).toBeLessThan(work);
    }
  });

  it("every file allowed to name the cast is gated, or is a rendered child of one", () => {
    // Being on the list is not a licence. Each entry either checks a gate
    // itself, or is a presentational component whose only caller is gated -
    // and the gated parent is named here so the pairing is explicit.
    const GATED_BY_PARENT: Record<string, string> = {
      "app/_components/dev-tools.tsx": "app/dev/page.tsx",
      "app/_components/demo-start.tsx": "app/page.tsx",
    };

    for (const file of DEMO_ONLY_FILES) {
      const source = readFileSync(file, "utf8");
      const gatesItself =
        source.includes("isDemoModeEnabled") || source.includes("isDebugSurfaceEnabled");
      if (gatesItself) continue;

      const parent = GATED_BY_PARENT[file];
      expect(parent, `${file} neither gates itself nor names a gated parent`).toBeTruthy();
      const parentSource = readFileSync(parent, "utf8");
      expect(parentSource, `${parent} does not gate ${file}`).toMatch(
        /isDemoModeEnabled|isDebugSurfaceEnabled/,
      );
    }
  });

  it("the demo fixture is only reachable from somewhere that gates itself", () => {
    /**
     * The fixture used to be development-only, and this guard said so. M10
     * changed that: the public demo seeds George for each anonymous reviewer,
     * so a PRODUCTION action imports the spec on purpose.
     *
     * The guard is therefore about gating rather than about development. A
     * file may reach for the canonical spec if it is a dev route, a known
     * dev-only file, or a file that checks `isDemoModeEnabled` itself - which
     * is the condition that makes seeding a stranger's account legitimate.
     * Adding the import to an ungated file still fails.
     */
    const offenders: string[] = [];
    for (const file of [...walkAll("core"), ...walkAll("server"), ...walkAll("app")]) {
      const relative = file.replace(/\\/g, "/");
      if (relative.startsWith("app/api/dev/") || DEV_ONLY_FILES.includes(relative)) continue;

      const source = readFileSync(file, "utf8");
      if (!source.includes("fixtures/demo/george")) continue;
      // deps.ts may construct the fixture's dependencies; reaching for the
      // SPEC without a demo-mode check is what this refuses.
      if (!source.includes("isDemoModeEnabled")) offenders.push(relative);
    }
    expect(offenders).toEqual([]);
  });

  it("the production demo action is the only non-development importer", () => {
    // Named explicitly, so a second one cannot appear quietly by satisfying
    // the rule above.
    const importers: string[] = [];
    for (const file of [...walkAll("core"), ...walkAll("server"), ...walkAll("app")]) {
      const relative = file.replace(/\\/g, "/");
      if (relative.startsWith("app/api/dev/") || DEV_ONLY_FILES.includes(relative)) continue;
      if (readFileSync(file, "utf8").includes("fixtures/demo/george")) importers.push(relative);
    }
    expect(importers).toEqual(["app/_actions/demo-session.ts"]);
    // ...and it gates itself on demo mode, not on NODE_ENV.
    expect(readFileSync("app/_actions/demo-session.ts", "utf8")).toContain("isDemoModeEnabled");
  });

  it("the state endpoint returns no token, draft or secret", () => {
    // Comments stripped: prose that NAMES what is excluded is the opposite of
    // a leak, and matching on it would punish the file for explaining itself.
    const code = (file: string) =>
      readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "");

    for (const forbidden of ["plaintext", "accessToken", "renderedText", "SECRET"]) {
      expect(code("app/api/dev/demo/state/route.ts"), forbidden).not.toContain(forbidden);
    }

    // And the view it builds carries ids, statuses and counts only.
    const service = code("server/services/demo-fixture.ts");
    const view = service.slice(service.indexOf("export async function readDemoState"));
    expect(view).not.toContain("renderedText");
    expect(view).not.toContain("accessTokenHash");
    expect(view).not.toContain("summary");
  });
});

function walkAll(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next" || entry === ".git") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walkAll(full, acc);
    else if (/\.(ts|tsx)$/.test(entry)) acc.push(full);
  }
  return acc;
}

describe("8. the fixture makes the demo's memory answers possible", () => {
  it("the ordinary memory pipeline can answer 'do you remember Simba?'", async () => {
    // Through `loadMemoryForTurn`, not a shortcut: the claim being tested is
    // that CareLoop can answer this from CONFIRMED RELATIONSHIPS, with no
    // demo-specific code anywhere in the path.
    await seed();
    const repos = fakeMemoryRepos(store);
    const memory = await loadMemoryForTurn(
      {
        entities: repos.entities,
        relationships: repos.relationships,
        facts: repos.facts,
        episodes: repos.episodes,
        embeddings: fakeEmbeddings({ store }),
      },
      { userId: USER, text: "Do you remember Simba?", now: NOW },
    );

    const card = memory.entityCards.find((text) => text.startsWith("Simba"));
    expect(card).toBeTruthy();
    // Enough for a grounded "Simba is John's dog", and nothing more.
    expect(card).toContain("pet (dog)");
    expect(card).toContain("John's recorded relationship to Simba: pet");
    // The user's own edge is household membership, and it stays that way. Live
    // acceptance turned it into "your dog"; the card no longer offers that
    // reading to anything downstream (M8 regression 3).
    expect(card).toContain("their recorded relationship to Simba: family_pet");
    expect(card).not.toMatch(/their (family_)?pet\b/i);
    expect(card).not.toMatch(/your dog\b/i);
    // A confirmed edge renders unmarked; an unconfirmed one carries a caveat.
    // The absence of that caveat IS the confirmation showing through.
    expect(card).not.toContain("not yet confirmed");
  });

  it("the model is given relationship structure, never a scripted answer", async () => {
    await seed();
    const repos = fakeMemoryRepos(store);
    const memory = await loadMemoryForTurn(
      {
        entities: repos.entities,
        relationships: repos.relationships,
        facts: repos.facts,
        episodes: repos.episodes,
        embeddings: fakeEmbeddings({ store }),
      },
      { userId: USER, text: "Do you remember Simba?", now: NOW },
    );
    const serialized = JSON.stringify(memory);
    // No sentence for the model to copy. It gets facts and writes its own.
    expect(serialized).not.toContain("Simba is John's dog");
    expect(serialized).not.toContain("Yes —");
  });

  it("George's own profile facts reach the turn", async () => {
    await seed();
    const repos = fakeMemoryRepos(store);
    const memory = await loadMemoryForTurn(
      {
        entities: repos.entities,
        relationships: repos.relationships,
        facts: repos.facts,
        episodes: repos.episodes,
        embeddings: fakeEmbeddings({ store }),
      },
      { userId: USER, text: "tell me about myself", now: NOW },
    );
    expect(memory.profileCard).toContain("retired police officer");
  });

  it("the fixture starts no decision: no closure and no drafted marker", async () => {
    await seed();
    const repos = fakeMemoryRepos(store);
    const memory = await loadMemoryForTurn(
      {
        entities: repos.entities,
        relationships: repos.relationships,
        facts: repos.facts,
        episodes: repos.episodes,
        embeddings: fakeEmbeddings({ store }),
      },
      { userId: USER, text: "hello", now: NOW },
    );
    expect(memory.pendingClosure).toBeNull();
    expect(memory.draftedOpportunityMarker).toBeNull();
  });
});

describe("9. the demo's live sentence still earns its own evidence", () => {
  const REPORTED_AT = NOW;

  it("'this week' resolves to a bounded absence window", () => {
    // The sentence the operator types is not seeded, so the deterministic
    // downstream contract is what has to hold: a week-scale phrase becomes a
    // window with two ends, which is what makes it evidence of NON-occurrence.
    const window = resolveAbsenceWindow({
      claim: { expression: "this week", absoluteDate: null },
      referenceAt: REPORTED_AT,
    });
    expect(window).toBeTruthy();
    // Two ends, in order. That is what makes the statement evidence of
    // NON-occurrence over a period rather than a point in time.
    expect(window!.start.getTime()).toBeLessThan(window!.end.getTime());
    expect(window!.end.getTime()).toBeLessThanOrEqual(REPORTED_AT.getTime());
  });

  it("the person's own words are quoted, never paraphrased", () => {
    const window = resolveAbsenceWindow({
      claim: { expression: "this week", absoluteDate: null },
      referenceAt: REPORTED_AT,
    })!;
    const phrase = recoverStatedAbsencePhrase({
      extraction: {
        ...EMPTY_EXTRACTION,
        interactions: [
          {
            participantMention: "John",
            eventType: "visit",
            polarity: "absence",
            temporal: { expression: "this week", absoluteDate: null },
            certainty: 0.9,
            sourceSpan: "I haven't seen John this week.",
          },
        ],
      },
      eventType: "visit",
      windowStart: window.start,
      windowEnd: window.end,
      reportedAt: REPORTED_AT,
    });
    // The phrase the person used, recovered - not a phrase invented for them.
    expect(phrase).toBe("this week");
  });

  it("explicit absence needs no baseline — the two detectors stay uncoupled", async () => {
    // Simba has relationships and no events. An absence about an entity with
    // no rhythm must still be capable of standing on its own; nothing in the
    // fixture couples the person's statement to a cadence.
    await seed();
    const simba = store.entities.find((e) => e.displayName === "Simba")!;
    expect(store.baselines.has(`${simba.id}:visit`)).toBe(false);
    expect(store.relationships.filter((r) => r.toEntityId === simba.id)).toHaveLength(2);
  });
});

describe("10. the person's own profile is borrowed, not taken", () => {
  const reset = () => resetDemoFixture(deps(), { userId: USER, spec: DEMO_GEORGE });

  it("restores non-null values exactly", async () => {
    profiles.set(USER, { displayName: "Margaret Okonjo", familyDisplayName: "Nana" });

    await seed();
    expect(profiles.get(USER)).toEqual({ displayName: "George", familyDisplayName: "Dad" });

    const removed = await reset();
    expect(removed.profileRestored).toBe(true);
    expect(profiles.get(USER)).toEqual({
      displayName: "Margaret Okonjo",
      familyDisplayName: "Nana",
    });
  });

  it("restores null as null, rather than leaving the fixture's value behind", async () => {
    // The easy bug: treat null as "nothing to restore" and skip the write.
    profiles.set(USER, { displayName: null, familyDisplayName: null });

    await seed();
    expect(profiles.get(USER)).toEqual({ displayName: "George", familyDisplayName: "Dad" });

    await reset();
    expect(profiles.get(USER)).toEqual({ displayName: null, familyDisplayName: null });
  });

  it("restores a half-filled profile field by field", async () => {
    profiles.set(USER, { displayName: "Margaret", familyDisplayName: null });
    await seed();
    await reset();
    expect(profiles.get(USER)).toEqual({ displayName: "Margaret", familyDisplayName: null });
  });

  it("removes the profile row entirely when there was none before", async () => {
    expect(profiles.has(USER)).toBe(false);
    await seed();
    expect(profiles.has(USER)).toBe(true);
    await reset();
    // Exact pre-demo state: there was no row, so there is no row.
    expect(profiles.has(USER)).toBe(false);
  });

  it("a second setup does NOT overwrite the original snapshot", async () => {
    // The bug this exists to catch: re-snapshotting on the second run records
    // the fixture's own values as "what was there before", and the person's
    // real name is gone for good.
    profiles.set(USER, { displayName: "Margaret Okonjo", familyDisplayName: "Nana" });

    await seed();
    await seed();
    await seed();

    await reset();
    expect(profiles.get(USER)).toEqual({
      displayName: "Margaret Okonjo",
      familyDisplayName: "Nana",
    });
  });

  it("a later setup that UPDATES the manifest still keeps the original snapshot", async () => {
    // The subtle version of the same bug. The snapshot is safe while nothing
    // rewrites the manifest row - but the row IS rewritten the first time the
    // fixture creates a fact key it had not recorded before. If the profile
    // were re-snapshotted in memory, that write is where the person's real
    // name would quietly be replaced by the fixture's own.
    profiles.set(USER, { displayName: "Margaret Okonjo", familyDisplayName: "Nana" });
    // The user already has one of the keys, so the first run records only two.
    store.facts.push({
      id: "fact-theirs",
      subjectEntityId: null,
      key: "occupation_former",
      value: "school caretaker",
      status: "confirmed",
      evidenceCount: 2,
      sourceObservationIds: [],
      sourceConversationIds: [],
    });

    await seed();

    // Now that key disappears, so the next run creates it and the manifest
    // has to be rewritten to record the third key.
    store.facts = store.facts.filter((f) => f.key !== "occupation_former");
    await seed();

    await reset();
    expect(profiles.get(USER)).toEqual({
      displayName: "Margaret Okonjo",
      familyDisplayName: "Nana",
    });
  });

  it("the snapshot survives a process restart, because it is a row", async () => {
    profiles.set(USER, { displayName: "Margaret Okonjo", familyDisplayName: "Nana" });
    await seed();

    // Nothing in memory carries over; only the database does. Fresh deps, as a
    // later request would get.
    const freshDeps = deps();
    const removed = await resetDemoFixture(freshDeps, { userId: USER, spec: DEMO_GEORGE });

    expect(removed.profileRestored).toBe(true);
    expect(profiles.get(USER)).toEqual({
      displayName: "Margaret Okonjo",
      familyDisplayName: "Nana",
    });
  });

  it("the manifest never reaches the model's profile card", async () => {
    // It is anchored to a fixture ENTITY, not to the user, precisely because
    // user-level facts are rendered verbatim into the prompt every turn.
    await seed();
    const userFacts = store.facts.filter((f) => f.subjectEntityId === null);
    expect(userFacts.map((f) => f.key)).not.toContain("demo-george.v1:manifest");
    for (const fact of userFacts) expect(fact.key).not.toContain("manifest");

    const repos = fakeMemoryRepos(store);
    const memory = await loadMemoryForTurn(
      {
        entities: repos.entities,
        relationships: repos.relationships,
        facts: repos.facts,
        episodes: repos.episodes,
        embeddings: fakeEmbeddings({ store }),
      },
      { userId: USER, text: "hello", now: NOW },
    );
    expect(JSON.stringify(memory)).not.toContain("profileRestored");
    expect(memory.profileCard ?? "").not.toContain("manifest");
  });

  it("reset twice is safe, and the second is a no-op", async () => {
    profiles.set(USER, { displayName: "Margaret", familyDisplayName: "Nana" });
    await seed();

    const first = await reset();
    const second = await reset();

    expect(first.profileRestored).toBe(true);
    // Nothing left to restore, nothing left to delete.
    expect(second).toEqual({
      entitiesRemoved: 0,
      episodesRemoved: 0,
      factsRemoved: 0,
      profileRestored: false,
    });
    expect(profiles.get(USER)).toEqual({ displayName: "Margaret", familyDisplayName: "Nana" });
  });

  it("a fresh setup after a reset works again, from the new starting point", async () => {
    profiles.set(USER, { displayName: "Margaret", familyDisplayName: "Nana" });
    const first = await seed();
    await reset();
    const second = await seed();

    expect(second.baselines).toEqual(first.baselines);
    expect(second.entities.map((e) => e.id)).toEqual(first.entities.map((e) => e.id));
    expect(profiles.get(USER)).toEqual({ displayName: "George", familyDisplayName: "Dad" });

    await reset();
    expect(profiles.get(USER)).toEqual({ displayName: "Margaret", familyDisplayName: "Nana" });
  });
});

describe("11. a user who already knows a John and a Simba keeps them", () => {
  /**
   * The blocker this closes. Ownership used to be "the display name matches
   * the spec", which meant a user with a real son called John would have had
   * that person adopted by the demo on setup and DELETED by the reset —
   * along with his events, his relationships and the memories about him.
   *
   * A name is a label people reuse. It was never identity.
   */
  async function existingWorld() {
    const repos = fakeMemoryRepos(store);
    const john = await repos.entities.create({
      userId: USER,
      type: "person",
      subtype: null,
      displayName: "John",
    });
    const simba = await repos.entities.create({
      userId: USER,
      type: "pet",
      subtype: "dog",
      displayName: "Simba",
    });

    await repos.relationships.create({
      userId: USER,
      fromEntityId: null,
      toEntityId: john.id,
      kind: "neighbour",
      labelRaw: "my neighbour John",
      confidence: 0.8,
      status: "confirmed",
      evidenceCount: 3,
      sourceObservationIds: [],
      sourceConversationIds: [],
    });
    await repos.relationships.create({
      userId: USER,
      fromEntityId: john.id,
      toEntityId: simba.id,
      kind: "pet",
      labelRaw: "his dog",
      confidence: 0.8,
      status: "confirmed",
      evidenceCount: 3,
      sourceObservationIds: [],
      sourceConversationIds: [],
    });

    store.interactionEvents.push({
      userId: USER,
      entityId: john.id,
      eventType: "call",
      occurredAt: new Date(NOW.getTime() - 2 * 86_400_000).toISOString(),
      occurredAtPrecision: "day",
      reportedAt: NOW.toISOString(),
      certainty: 0.9,
      polarity: "positive",
      windowStart: null,
      windowEnd: null,
      sourceObservationId: null,
      ingestFingerprint: "real-life-not-the-fixture",
    });

    const episode = await repos.episodes.create({
      userId: USER,
      summary: "John from next door brought the bins in.",
      occurredAt: new Date(NOW.getTime() - 2 * 86_400_000).toISOString(),
      precision: "day",
      salience: 0.4,
      embedding: null,
      sourceMessageIds: [],
    });
    await repos.episodes.addMembers(episode.id, [john.id, simba.id]);

    store.facts.push({
      id: "fact-real",
      subjectEntityId: null,
      key: "occupation_former",
      value: "school caretaker",
      status: "confirmed",
      evidenceCount: 2,
      sourceObservationIds: [],
      sourceConversationIds: [],
    });

    return { john, simba, episode };
  }

  it("setup creates its OWN John and Simba, distinct rows", async () => {
    const world = await existingWorld();
    const result = await seed();

    expect(store.entities).toHaveLength(4);
    const fixtureIds = result.entities.map((e) => e.id);
    expect(fixtureIds).not.toContain(world.john.id);
    expect(fixtureIds).not.toContain(world.simba.id);
    // Two Johns, two Simbas, four distinct ids.
    expect(new Set(store.entities.map((e) => e.id)).size).toBe(4);
  });

  it("the fixture's ids are derived, stable and per-user", () => {
    const a = fixtureUuid("demo-george.v1", USER, "entity/john");
    const b = fixtureUuid("demo-george.v1", USER, "entity/john");
    const other = fixtureUuid("demo-george.v1", OTHER_USER, "entity/john");
    const otherKey = fixtureUuid("demo-george.v1", USER, "entity/simba");

    expect(a).toBe(b);
    expect(a).not.toBe(other);
    expect(a).not.toBe(otherKey);
    // A well-formed UUID, not a hash wearing hyphens: the column is a uuid.
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("reset leaves the user's own John and Simba completely untouched", async () => {
    const world = await existingWorld();
    await seed();
    await resetDemoFixture(deps(), { userId: USER, spec: DEMO_GEORGE });

    const survivors = store.entities.map((e) => e.id).sort();
    expect(survivors).toEqual([world.john.id, world.simba.id].sort());
  });

  it("their interaction events survive", async () => {
    await existingWorld();
    await seed();
    expect(store.interactionEvents).toHaveLength(7);

    await resetDemoFixture(deps(), { userId: USER, spec: DEMO_GEORGE });
    expect(store.interactionEvents).toHaveLength(1);
    expect(store.interactionEvents[0].ingestFingerprint).toBe("real-life-not-the-fixture");
  });

  it("their relationships survive", async () => {
    const world = await existingWorld();
    await seed();
    expect(store.relationships).toHaveLength(5);

    await resetDemoFixture(deps(), { userId: USER, spec: DEMO_GEORGE });
    expect(store.relationships).toHaveLength(2);
    expect(store.relationships.map((r) => r.kind).sort()).toEqual(["neighbour", "pet"]);
    expect(store.relationships.every((r) => r.toEntityId !== world.john.id || r.kind === "neighbour"))
      .toBe(true);
  });

  it("their episodes survive, even though they mention a same-named entity", async () => {
    const world = await existingWorld();
    await seed();
    expect(store.episodes).toHaveLength(4);

    await resetDemoFixture(deps(), { userId: USER, spec: DEMO_GEORGE });
    expect(store.episodes.map((e) => e.id)).toEqual([world.episode.id]);
  });

  it("their user-level fact survives — identity is the key, not the value", async () => {
    await existingWorld();
    // The user already has `occupation_former`. The fixture must not overwrite
    // it, must not record it as its own, and must not delete it.
    await seed();
    expect(store.facts.filter((f) => f.key === "occupation_former")).toHaveLength(1);
    expect(store.facts.find((f) => f.key === "occupation_former")?.value).toBe("school caretaker");

    await resetDemoFixture(deps(), { userId: USER, spec: DEMO_GEORGE });
    expect(store.facts.find((f) => f.key === "occupation_former")?.value).toBe("school caretaker");
  });

  it("the fixture's own facts are still removed", async () => {
    await existingWorld();
    await seed();
    // These two it did create, so these two it owns.
    expect(store.facts.map((f) => f.key)).toContain("living_situation");

    await resetDemoFixture(deps(), { userId: USER, spec: DEMO_GEORGE });
    expect(store.facts.map((f) => f.key)).toEqual(["occupation_former"]);
  });

  it("a same-name world survives setup, reset, and setup again", async () => {
    const world = await existingWorld();
    await seed();
    await resetDemoFixture(deps(), { userId: USER, spec: DEMO_GEORGE });
    await seed();
    await resetDemoFixture(deps(), { userId: USER, spec: DEMO_GEORGE });

    expect(store.entities.map((e) => e.id).sort()).toEqual(
      [world.john.id, world.simba.id].sort(),
    );
    expect(store.episodes.map((e) => e.id)).toEqual([world.episode.id]);
    expect(store.interactionEvents).toHaveLength(1);
    expect(store.relationships).toHaveLength(2);
  });

  it("ownership never reads a name, an alias, a subtype or a label", () => {
    const service = readFileSync("server/services/demo-fixture.ts", "utf8");
    const resolution = service.slice(
      service.indexOf("export async function resetDemoFixture"),
      service.indexOf("export async function seedDemoFixture"),
    );
    // What the reset is allowed to look at.
    expect(resolution).toContain("entityId(spec, userId");
    expect(resolution).toContain("episodeId(spec, userId");
    // And what it must not: nothing about how a row is LABELLED decides
    // whether the fixture owns it.
    for (const forbidden of ["aliases", "subtype", "labelRaw", "display_name"]) {
      expect(resolution, forbidden).not.toContain(forbidden);
    }

    // `displayName` does appear — but only as a value being PUT BACK into the
    // person's profile, never as a way of deciding what to delete.
    const nameLines = resolution
      .split("\n")
      .filter((line) => line.includes("displayName"));
    expect(nameLines.length).toBeGreaterThan(0);
    for (const line of nameLines) {
      expect(line, line.trim()).toMatch(/manifest\.profile\.|displayName:$|familyDisplayName:$/);
    }
  });
});

describe("12. demo state counts the fixture graph, not the user's account", () => {
  /**
   * The live failure, reproduced.
   *
   * A development account is not a clean room. The M5 acceptance runs leave a
   * real consent grant, a real family request, a real response and a real
   * closure behind, on purpose — the reset is correct to preserve them. But
   * the state panel counted every row belonging to the user, so a freshly
   * seeded fixture reported `consentGrants: 1, closures: 1` and an operator
   * about to demo could not tell a clean start from a dirty one.
   */
  async function priorAcceptanceRun() {
    const repos = fakeMemoryRepos(store);
    const stranger = await repos.entities.create({
      userId: USER,
      type: "person",
      subtype: null,
      displayName: "Margaret",
    });

    store.interactionEvents.push({
      userId: USER,
      entityId: stranger.id,
      eventType: "call",
      occurredAt: new Date(NOW.getTime() - 3 * 86_400_000).toISOString(),
      occurredAtPrecision: "day",
      reportedAt: NOW.toISOString(),
      certainty: 0.9,
      polarity: "positive",
      windowStart: null,
      windowEnd: null,
      sourceObservationId: null,
      ingestFingerprint: "m5-acceptance-not-the-fixture",
    });
    store.baselines.set(`${stranger.id}:call`, {
      entityId: stranger.id,
      eventType: "call",
      computedAt: NOW.toISOString(),
      status: "ACTIVE",
      medianGapDays: 7,
      madDays: 0,
      dispersion: 0,
      gaps: [7],
      spanDays: 7,
      observationCount: 2,
      statisticalDayCount: 2,
      reasons: [],
      inputsHash: "hash",
      methodVersion: "v1",
      windowStart: new Date(NOW.getTime() - 30 * 86_400_000),
      windowEnd: NOW,
    });

    decisions.signals.push({
      id: "sig-m5",
      userId: USER,
      entityId: stranger.id,
      status: "detected",
    });
    decisions.opportunities.push({
      id: "opp-m5",
      userId: USER,
      entityId: stranger.id,
      status: "consumed",
    });
    decisions.grants.push({ id: "grant-m5", opportunityId: "opp-m5" });
    decisions.requests.push({ id: "req-m5", opportunityId: "opp-m5" });
    decisions.responses.push({ id: "res-m5", requestId: "req-m5" });
    decisions.closures.push({ id: "clo-m5", opportunityId: "opp-m5" });

    return stranger;
  }

  const state = () => readDemoState(deps(), { userId: USER, spec: DEMO_GEORGE, now: NOW });

  it("reports a clean fixture even when the account is full of prior work", async () => {
    await priorAcceptanceRun();
    await seed();

    const result = await state();
    expect(result.counts).toEqual({
      // Six John visits, one John baseline. Margaret's are not the demo's.
      interactionEvents: 6,
      baselines: 1,
      signalsOpen: 0,
      opportunitiesOpen: 0,
      consentGrants: 0,
      familyRequests: 0,
      familyResponses: 0,
      closures: 0,
    });
  });

  it("every unrelated row is still there — this is a counting fix, not a cleanup", async () => {
    const stranger = await priorAcceptanceRun();
    await seed();
    await state();

    expect(store.entities.some((e) => e.id === stranger.id)).toBe(true);
    expect(
      store.interactionEvents.some((e) => e.ingestFingerprint === "m5-acceptance-not-the-fixture"),
    ).toBe(true);
    expect(store.baselines.has(`${stranger.id}:call`)).toBe(true);
    expect(decisions.signals).toHaveLength(1);
    expect(decisions.opportunities).toHaveLength(1);
    expect(decisions.grants).toHaveLength(1);
    expect(decisions.requests).toHaveLength(1);
    expect(decisions.responses).toHaveLength(1);
    expect(decisions.closures).toHaveLength(1);
  });

  it("the fixture baseline reports the fixture's own last event", async () => {
    await priorAcceptanceRun();
    await seed();

    const [john] = (await state()).baselines;
    expect(john).toMatchObject({
      entity: "John",
      eventType: "visit",
      status: "ACTIVE",
      medianGapDays: 7,
      madDays: 0,
      derivedThresholdDays: 11,
      observationCount: 6,
      // The other half of the reported bug: this was null, so the panel could
      // not say whether the demo was primed to fire.
      lastEventDaysAgo: 13,
    });
    expect(john.lastEventDaysAgo!).toBeGreaterThan(john.derivedThresholdDays!);
  });

  it("setup and state agree on every baseline figure", async () => {
    await priorAcceptanceRun();
    const seeded = await seed();
    const read = await state();
    // The two views disagreeing is what an operator sees as "the demo is
    // broken", whichever one is right.
    expect(read.baselines).toEqual(seeded.baselines);
  });

  it("an absence assertion never answers 'when did they last visit?'", async () => {
    await seed();
    const john = store.entities.find((e) => e.displayName === "John")!;
    store.interactionEvents.push({
      userId: USER,
      entityId: john.id,
      eventType: "visit",
      occurredAt: NOW.toISOString(),
      occurredAtPrecision: "day",
      reportedAt: NOW.toISOString(),
      certainty: 0.9,
      polarity: "absence",
      windowStart: new Date(NOW.getTime() - 7 * 86_400_000).toISOString(),
      windowEnd: NOW.toISOString(),
      sourceObservationId: null,
      ingestFingerprint: "the-live-demo-sentence",
    });

    // Evidence of NOT seeing someone is a nonsense answer to "when last?".
    expect((await state()).baselines[0].lastEventDaysAgo).toBe(13);
  });

  it("state on an unseeded fixture is zeros, not the account's totals", async () => {
    await priorAcceptanceRun();
    const result = await state();
    expect(result.present).toBe(false);
    expect(result.counts).toEqual({
      interactionEvents: 0,
      baselines: 0,
      signalsOpen: 0,
      opportunitiesOpen: 0,
      consentGrants: 0,
      familyRequests: 0,
      familyResponses: 0,
      closures: 0,
    });
  });
});

describe("13. a completed demo cycle resets to clean zeros", () => {
  /** Everything a full run through M4 and M5 leaves on the fixture's John. */
  function completeTheCycle(johnId: string) {
    decisions.signals.push({
      id: "sig-demo",
      userId: USER,
      entityId: johnId,
      status: "detected",
    });
    decisions.opportunities.push({
      id: "opp-demo",
      userId: USER,
      entityId: johnId,
      status: "consumed",
    });
    decisions.grants.push({ id: "grant-demo", opportunityId: "opp-demo" });
    decisions.requests.push({ id: "req-demo", opportunityId: "opp-demo" });
    decisions.responses.push({ id: "res-demo", requestId: "req-demo" });
    decisions.closures.push({ id: "clo-demo", opportunityId: "opp-demo" });
  }

  it("a finished run is visible in state, then gone after reset", async () => {
    const stranger = await (async () => {
      const repos = fakeMemoryRepos(store);
      const row = await repos.entities.create({
        userId: USER,
        type: "person",
        subtype: null,
        displayName: "Margaret",
      });
      decisions.opportunities.push({
        id: "opp-m5",
        userId: USER,
        entityId: row.id,
        status: "consumed",
      });
      decisions.grants.push({ id: "grant-m5", opportunityId: "opp-m5" });
      decisions.requests.push({ id: "req-m5", opportunityId: "opp-m5" });
      decisions.responses.push({ id: "res-m5", requestId: "req-m5" });
      decisions.closures.push({ id: "clo-m5", opportunityId: "opp-m5" });
      return row;
    })();

    const seeded = await seed();
    const john = seeded.entities.find((e) => e.displayName === "John")!;
    completeTheCycle(john.id);

    const mid = await readDemoState(deps(), { userId: USER, spec: DEMO_GEORGE, now: NOW });
    expect(mid.counts).toMatchObject({
      signalsOpen: 1,
      consentGrants: 1,
      familyRequests: 1,
      familyResponses: 1,
      closures: 1,
    });

    // Setup with reset, exactly as the endpoint does it.
    await resetDemoFixture(deps(), { userId: USER, spec: DEMO_GEORGE });
    await seed();

    const after = await readDemoState(deps(), { userId: USER, spec: DEMO_GEORGE, now: NOW });
    expect(after.counts).toEqual({
      interactionEvents: 6,
      baselines: 1,
      signalsOpen: 0,
      opportunitiesOpen: 0,
      consentGrants: 0,
      familyRequests: 0,
      familyResponses: 0,
      closures: 0,
    });
    expect(after.baselines[0].lastEventDaysAgo).toBe(13);

    // And the unrelated M5 rows are untouched throughout.
    expect(store.entities.some((e) => e.id === stranger.id)).toBe(true);
    expect(decisions.grants.map((g) => g.id)).toEqual(["grant-m5"]);
    expect(decisions.requests.map((r) => r.id)).toEqual(["req-m5"]);
    expect(decisions.responses.map((r) => r.id)).toEqual(["res-m5"]);
    expect(decisions.closures.map((c) => c.id)).toEqual(["clo-m5"]);
  });

  it("the reset removes the fixture's decision rows through the cascade", async () => {
    const seeded = await seed();
    completeTheCycle(seeded.entities.find((e) => e.displayName === "John")!.id);

    await resetDemoFixture(deps(), { userId: USER, spec: DEMO_GEORGE });

    // No demo-specific delete of signals, grants or closures anywhere: the
    // entity goes, and the frozen schema takes the rest.
    expect(decisions.signals).toHaveLength(0);
    expect(decisions.opportunities).toHaveLength(0);
    expect(decisions.grants).toHaveLength(0);
    expect(decisions.requests).toHaveLength(0);
    expect(decisions.responses).toHaveLength(0);
    expect(decisions.closures).toHaveLength(0);
  });
});

describe("14. the next demo starts in a blank chat, without losing the last one", () => {
  /**
   * The repeatability gap live acceptance found. The reset is right to leave
   * conversations alone — they are the operator's history, not the fixture's
   * — but the home page opens the LATEST conversation, so a reset demo still
   * reopened the previous run's transcript. The database was clean; the screen
   * was not.
   *
   * The fix deletes nothing. It makes a blank conversation the latest one.
   */
  const ensure = () => ensureBlankConversation(deps(), { userId: USER });

  const say = async (conversationId: string, content: string) => {
    await fakeMessages().insert({ conversationId, role: "user", content });
  };

  it("creates the first conversation when the account has none", async () => {
    const result = await ensure();
    expect(result.conversationCreated).toBe(true);
    expect(chat.conversations).toHaveLength(1);
    expect(result.conversationId).toBe(chat.conversations[0].id);
  });

  it("creates a fresh blank one when the latest has messages", async () => {
    const a = (await ensure()).conversationId;
    await say(a, "I haven't seen John this week.");

    const result = await ensure();
    expect(result.conversationCreated).toBe(true);
    expect(result.conversationId).not.toBe(a);
    // And it is the latest, which is what `/` opens.
    expect((await fakeConversations().findLatest(USER))!.id).toBe(result.conversationId);
  });

  it("reuses the latest when it is already blank — setup twice, one conversation", async () => {
    const first = await ensure();
    const second = await ensure();
    const third = await ensure();

    expect(second.conversationCreated).toBe(false);
    expect(third.conversationCreated).toBe(false);
    expect(second.conversationId).toBe(first.conversationId);
    expect(third.conversationId).toBe(first.conversationId);
    // No trail of empty conversations behind a repeated setup.
    expect(chat.conversations).toHaveLength(1);
  });

  it("A with messages → setup → blank B → setup → B reused → chat → setup → C", async () => {
    // The exact sequence the review asked for, end to end.
    const a = (await ensure()).conversationId;
    await say(a, "hello");
    await say(a, "and another turn");

    const b = await ensure();
    expect(b.conversationCreated).toBe(true);
    expect(b.conversationId).not.toBe(a);

    const bAgain = await ensure();
    expect(bAgain.conversationCreated).toBe(false);
    expect(bAgain.conversationId).toBe(b.conversationId);

    await say(b.conversationId, "I haven't seen John this week.");
    const c = await ensure();
    expect(c.conversationCreated).toBe(true);
    expect(c.conversationId).not.toBe(b.conversationId);
    expect(c.conversationId).not.toBe(a);

    // Three conversations, and every message still where it was written.
    expect(chat.conversations.map((row) => row.id)).toEqual([a, b.conversationId, c.conversationId]);
    expect(chat.messages.filter((m) => m.conversationId === a)).toHaveLength(2);
    expect(chat.messages.filter((m) => m.conversationId === b.conversationId)).toHaveLength(1);
    expect(chat.messages.filter((m) => m.conversationId === c.conversationId)).toHaveLength(0);
  });

  it("deletes nothing — not a conversation, not a message", async () => {
    const a = (await ensure()).conversationId;
    await say(a, "something the operator said weeks ago");
    const before = {
      conversations: chat.conversations.map((row) => row.id),
      messages: chat.messages.map((row) => ({ ...row })),
    };

    await ensure();
    await ensure();
    await ensure();

    // Every original row is still present and unchanged; only new rows appear.
    for (const id of before.conversations) {
      expect(chat.conversations.some((row) => row.id === id)).toBe(true);
    }
    for (const message of before.messages) {
      expect(chat.messages).toContainEqual(message);
    }
    expect(chat.messages).toHaveLength(before.messages.length);
  });

  it("emptiness is measured, not assumed", async () => {
    // It asks the store for a message rather than trusting a counter or a
    // flag: a conversation with exactly one turn is not blank.
    const a = (await ensure()).conversationId;
    await say(a, "one turn");
    expect(await fakeMessages().listRecent(a, 1)).toHaveLength(1);
    expect((await ensure()).conversationCreated).toBe(true);
  });

  it("belongs to the demo surface, not to conversation policy", () => {
    // "Start a fresh conversation because a demo is about to run" is not a
    // rule the product should learn.
    const service = readFileSync("server/services/conversation.ts", "utf8");
    expect(service).not.toContain("ensureBlankConversation");
    const route = readFileSync("app/api/dev/demo/setup/route.ts", "utf8");
    // The CALL, not the import. Matching the import would have let the call be
    // deleted while the assertion carried on passing.
    expect(route).toMatch(/await ensureBlankConversation\(\s*deps,\s*\{\s*userId\s*\}\s*\)/);
    // And the result reaches the operator rather than being computed and
    // dropped.
    expect(route).toContain("conversationId: conversation.conversationId");
    expect(route).toContain("conversationCreated: conversation.conversationCreated");
  });

  it("another user's conversations are never returned or reused", async () => {
    await ensureBlankConversation(deps(), { userId: OTHER_USER });
    const theirs = chat.conversations[0].id;

    const mine = await ensure();
    expect(mine.conversationCreated).toBe(true);
    expect(mine.conversationId).not.toBe(theirs);
    expect(chat.conversations.find((c) => c.id === theirs)!.userId).toBe(OTHER_USER);
  });
});

describe("15. the browser-facing demo reset cannot run in production", () => {
  /**
   * A server action is a POST endpoint whether or not a button points at it.
   * "The page did not render the control" is a UX fact, not a security
   * boundary — so the action evaluates the gate itself, and these assertions
   * are about that, not about the button.
   */
  const action = () => readFileSync("app/_actions/demo.ts", "utf8");

  it("runs the same four-condition gate as every other dev surface", () => {
    const source = action();
    expect(source).toContain("isDebugSurfaceEnabled(process.env)");
    expect(source).toContain("authorizeDevSeed(process.env");
    // Both refuse by returning, before any dependency is constructed.
    const body = source.slice(source.indexOf("export async function resetDemoAction"));
    expect(body.indexOf("isDebugSurfaceEnabled")).toBeLessThan(body.indexOf("createDemoFixtureDeps"));
    expect(body.indexOf("authorizeDevSeed")).toBeLessThan(body.indexOf("createDemoFixtureDeps"));
  });

  it("the gate it uses is the one the frozen config defines", () => {
    // Not a re-implementation: the same allow-list, fail-closed on any
    // unexpected environment.
    expect(isDebugSurfaceEnabled({ NODE_ENV: "development" })).toBe(true);
    expect(isDebugSurfaceEnabled({ NODE_ENV: "production" })).toBe(false);
    expect(isDebugSurfaceEnabled({ NODE_ENV: "development", VERCEL: "1" })).toBe(false);
    expect(isDebugSurfaceEnabled({})).toBe(false);
  });

  it("refuses when no secret is configured, even in development", () => {
    expect(authorizeDevSeed({ NODE_ENV: "development" }, null).allowed).toBe(false);
    expect(
      authorizeDevSeed({ NODE_ENV: "development", CARELOOP_DEV_SEED_SECRET: "" }, "").allowed,
    ).toBe(false);
    expect(
      authorizeDevSeed({ NODE_ENV: "development", CARELOOP_DEV_SEED_SECRET: "s" }, "s").allowed,
    ).toBe(true);
  });

  it("does what the CLI setup does, through the same services", () => {
    const source = action();
    // No demo-specific shortcut: the same reset, seed and blank-conversation
    // functions the endpoint calls.
    for (const call of ["resetDemoFixture", "seedDemoFixture", "ensureBlankConversation"]) {
      expect(source, call).toContain(call);
    }
  });
});
