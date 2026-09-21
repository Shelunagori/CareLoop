import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { fixedClock } from "@/server/adapters/clock";
import { loadPendingOffer } from "@/server/services/conversation";
import { prepareOffer } from "@/server/services/consent";
import { loadMemoryForTurn } from "@/server/services/memory-retrieval";
import { presentableEntity, presentableName } from "@/core/memory/provenance";
import { sha256Hex } from "@/core/share/text-hash";
import { createStore, fakeReconnectDeps, resetIds } from "./detection-fakes";
import { m5Deps, resetM5Ids, withM5, type M5Store } from "./consent-fakes";
import {
  createStore as createMemoryStore,
  fakeEmbeddings,
  fakeMemoryRepos,
} from "./memory-fakes";

/**
 * NO DEVELOPMENT-SEEDED ROW REACHES A PERSON — AT ANY BOUNDARY (M12e.3).
 *
 * The live failure this file exists for: an entity reclassified to `dev`
 * still rendered "RECONNECT WITH TESTPERSONA" on page load. The rule had
 * been added to `prepareOffer` and to nowhere else, and the card a reviewer
 * sees first is drawn by `loadPendingOffer` from an ALREADY-`offered`
 * opportunity — created while the entity was still `user`, so neither the
 * opportunity nor its stored proposal could ever have revealed what the
 * entity had since become.
 *
 * The lesson the tests are written to: provenance must be re-read from the
 * ENTITY, at every boundary, on every read. Anything derived and stored
 * earlier is a snapshot of a classification that may have changed.
 */
const NOW = new Date("2026-09-21T12:00:00.000Z");
const HOUR = 3_600_000;
const USER = "user-1";
const SUBJECT = "entity-subject";
const TEXT = "Dad was wondering — are you able to visit soon?";

type Origin = "user" | "demo" | "dev";
type Status = "proposed" | "drafted" | "offered";

function storeWith(origin: Origin, status: Status): M5Store {
  const store = withM5(
    createStore({
      entities: [
        {
          id: SUBJECT, type: "person", subtype: null, displayName: "TestPersonA",
          aliases: [], status: "active", origin, lastMentionedAt: NOW.toISOString(),
        },
      ],
    }),
  );
  store.opportunities.push({
    id: "opp-1",
    userId: USER,
    signalId: "sig-1",
    entityId: SUBJECT,
    proposal: {
      entityId: SUBJECT,
      entityName: "TestPersonA",
      eventType: "visit" as const,
      observation: {
        kind: "user_stated_absence" as const,
        window: { start: "2026-09-14T00:00:00.000Z", end: NOW.toISOString() },
        statedAt: NOW.toISOString(),
      },
      question: "ask_if_visiting" as const,
    },
    sharePayload: {
      fromDisplayName: "Dad",
      topic: "visit" as const,
      question: "ask_if_visiting" as const,
    },
    renderedText: status === "proposed" ? null : TEXT,
    renderedTextHash: status === "proposed" ? null : sha256Hex(TEXT),
    status,
    offeredAt: status === "offered" ? NOW.toISOString() : null,
    resolvedAt: null,
    expiresAt: new Date(NOW.getTime() + 24 * HOUR).toISOString(),
    createdAt: NOW.toISOString(),
  });
  return store;
}

/** Exactly what the page does on load — the two reads it actually makes. */
function card(store: M5Store) {
  const base = fakeReconnectDeps({ store, clock: fixedClock(NOW) });
  return loadPendingOffer(
    { opportunities: base.opportunities, entities: base.entities },
    USER,
  );
}

/**
 * The same read with a repository that does NOT filter.
 *
 * Written because the first version of these tests did not fail when the
 * code-level check was removed: the fake repository was filtering, so the
 * assertion was proving the SQL and nothing else. "Both layers, neither
 * redundant" is a claim, and a claim needs each layer tested with the other
 * one taken away.
 *
 * This is also the realistic regression: a future caller reaching for
 * `listForUser` because it is the obvious name.
 */
function cardWithUnfilteredRepo(store: M5Store) {
  const base = fakeReconnectDeps({ store, clock: fixedClock(NOW) });
  return loadPendingOffer(
    {
      opportunities: base.opportunities,
      entities: {
        ...base.entities,
        listPresentableForUser: (userId: string, limit: number) =>
          base.entities.listForUser(userId, limit),
      },
    },
    USER,
  );
}

const offer = (store: M5Store) =>
  prepareOffer(m5Deps({ store, clock: fixedClock(NOW) }).consent, {
    userId: USER,
    conversationId: "conv-1",
    recentMessages: [
      { role: "user", content: "I haven't seen TestPersonA recently.", createdAt: NOW.toISOString() },
    ],
  });

beforeEach(() => {
  resetIds();
  resetM5Ids();
});

describe("1. the card drawn on page load — the boundary that was bypassed", () => {
  it.each(["proposed", "drafted", "offered"] as const)(
    "a dev entity with a %s opportunity is invisible",
    async (status) => {
      expect(await card(storeWith("dev", status))).toBeNull();
    },
  );

  it.each(["demo", "user"] as const)("a %s entity with a live offer is visible", async (origin) => {
    const pending = await card(storeWith(origin, "offered"));
    expect(pending).not.toBeNull();
    expect(pending!.entityName).toBe("TestPersonA");
  });

  it("is refused in CODE too, not only by the query", async () => {
    // With an unfiltered repository the row reaches the boundary, and the
    // boundary is what must refuse it. Removing `presentableName` from
    // `loadPendingOffer` turns this red; removing `.neq("origin","dev")`
    // from the repository turns the tests above red. Neither layer is
    // decoration.
    expect(await cardWithUnfilteredRepo(storeWith("dev", "offered"))).toBeNull();
    const visible = await cardWithUnfilteredRepo(storeWith("user", "offered"));
    expect(visible?.entityName).toBe("TestPersonA");
  });

  it("reclassifying user → dev makes an EXISTING offer invisible on the next read", async () => {
    // The live defect, exactly: the opportunity was created, drafted and
    // offered while the entity was `user`. Nothing about it changes when the
    // row is reclassified — only the entity does, and only a read that
    // re-checks the entity can notice.
    const store = storeWith("user", "offered");
    expect(await card(store)).not.toBeNull();

    store.entities[0].origin = "dev";
    expect(await card(store)).toBeNull();
  });
});

describe("2. the same answer at the offer boundary", () => {
  it.each(["proposed", "drafted", "offered"] as const)(
    "a dev entity with a %s opportunity is never offered",
    async (status) => {
      const store = storeWith("dev", status);
      const result = await offer(store);
      expect(result.outcome).toBe("none");
      // Hiding it spends nothing: the row is untouched.
      expect(store.opportunities[0].status).toBe(status);
      expect(store.grants).toHaveLength(0);
    },
  );

  it.each(["demo", "user"] as const)("a %s entity is still offered", async (origin) => {
    expect((await offer(storeWith(origin, "drafted"))).outcome).toBe("offered");
  });
});

describe("3. memory retrieval and the proactive opening use the same rule", () => {
  it("a dev entity produces no card and is never spotlighted", async () => {
    const store = createMemoryStore([]);
    store.entities.push(
      {
        id: "e-dev", type: "person", subtype: null, displayName: "TestPersonA",
        aliases: [], status: "active", origin: "dev", lastMentionedAt: NOW.toISOString(),
      },
      {
        id: "e-user", type: "person", subtype: null, displayName: "Margaret",
        aliases: [], status: "active", origin: "user", lastMentionedAt: NOW.toISOString(),
      },
    );
    const deps = { ...fakeMemoryRepos(store), embeddings: fakeEmbeddings({ store }) };

    const memory = await loadMemoryForTurn(deps, {
      userId: USER,
      // Names BOTH. Only one may come back.
      text: "TestPersonA and Margaret both called.",
      now: NOW,
    });

    expect(memory.mentionedNow).toEqual(["Margaret"]);
    expect(memory.entityCards.join("\n")).not.toContain("TestPersonA");
    expect(memory.entityCards.join("\n")).toContain("Margaret");
  });
});

describe("4. the rule itself", () => {
  it("presents user and demo, refuses dev, and refuses anything unknown", () => {
    expect(presentableName({ displayName: "Don", origin: "user" })).toBe("Don");
    expect(presentableName({ displayName: "George", origin: "demo" })).toBe("George");
    expect(presentableName({ displayName: "TestPersonA", origin: "dev" })).toBeNull();
    // A row written by a deploy this code does not know about.
    expect(presentableName({ displayName: "Don", origin: "something_new" })).toBeNull();
  });

  it("applies the label rule too, and to aliases", () => {
    expect(presentableName({ displayName: "M4ABSENCE1789574558", origin: "user" })).toBeNull();
    expect(
      presentableEntity({ displayName: "Don", origin: "user", aliases: ["Donald", "user_42"] }),
    ).toEqual({ displayName: "Don", aliases: ["Donald"] });
  });

  it("is not a name rule — provenance decides, spelling does not", () => {
    // Identical names, opposite answers. Nothing here reads the characters
    // to decide whether somebody is real.
    expect(presentableName({ displayName: "TestPersonA", origin: "user" })).toBe("TestPersonA");
    expect(presentableName({ displayName: "TestPersonA", origin: "dev" })).toBeNull();
  });
});

describe("5. the split is pinned, so a new presentation path cannot miss it", () => {
  /**
   * `listForUser` returns EVERYTHING, including `dev`, and must: entity
   * resolution has to match a row that already exists whatever created it,
   * or ingestion writes a duplicate every turn. Every other reader gets
   * `listPresentableForUser`, which excludes `dev` in SQL.
   *
   * This guard is the reason the live defect cannot recur quietly: adding a
   * ninth read of an entity's name fails here unless it picks a side.
   */
  const MAY_SEE_EVERYTHING = [
    // Resolution. Must match a dev row rather than duplicate it.
    "server/services/ingestion.ts",
    // Development surfaces, whose whole job is to show what is stored.
    "server/services/consent-debug.ts",
    "server/services/detection-debug.ts",
    "server/services/baseline-debug.ts",
    "app/api/dev/seed-events/route.ts",
  ];
  const MUST_ONLY_SEE_PRESENTABLE = [
    "server/services/conversation.ts",
    "server/services/consent.ts",
    "server/services/memory-retrieval.ts",
    "server/services/opening.ts",
    "server/services/closure.ts",
    "server/services/wellbeing.ts",
    "server/services/family-send.ts",
    "server/services/reconnect.ts",
  ];

  it.each(MUST_ONLY_SEE_PRESENTABLE)("%s never reads the unfiltered list", (file) => {
    const source = readFileSync(file, "utf8");
    expect(source).not.toContain("entities.listForUser");
    expect(source).toContain("entities.listPresentableForUser");
  });

  it.each(MAY_SEE_EVERYTHING)("%s deliberately still does", (file) => {
    expect(readFileSync(file, "utf8")).toContain("entities.listForUser");
  });

  it("the repository filters in the QUERY, not after it", () => {
    const repo = readFileSync("server/repositories/entities.ts", "utf8");
    expect(repo).toMatch(/listPresentableForUser[\s\S]*\.neq\("origin", "dev"\)/);
  });
});
