import { beforeEach, describe, expect, it } from "vitest";
import { fixedClock } from "@/server/adapters/clock";
import { prepareOffer } from "@/server/services/consent";
import { sanitizeLabel } from "@/core/share/minimize";
import { sha256Hex } from "@/core/share/text-hash";
import { createStore, resetIds } from "./detection-fakes";
import { conversationUnderway, m5Deps, resetM5Ids, withM5, type M5Store } from "./consent-fakes";

/**
 * A reconnect offer never shows an identifier as somebody's name.
 *
 * Observed in the browser:
 *
 *   RECONNECT WITH M4ABSENCE1789574558
 *   Message to M4Absence1789574558
 *
 * Every layer had behaved correctly. A developer seeding recipe had created
 * an entity under that name, the detector found a genuine signal for it, and
 * the card printed the display name it was handed. What was missing is that
 * the OUTBOUND path has always had a rule about what may be presented as a
 * person's name — `sanitizeLabel`, in core/share/minimize.ts — and the
 * in-app card did not share it. One product, two opinions.
 *
 * So the fix is not a new rule. It is the existing rule, applied at the
 * other boundary, with a suppressed offer rather than a technical string.
 */
const NOW = new Date("2026-09-16T12:00:00.000Z");
const HOUR = 3_600_000;
const USER = "user-1";
const ENTITY = "entity-1";
const TEXT = "Are you able to visit soon?";

function storeWithLabel(displayName: string): M5Store {
  const store = withM5(
    createStore({
      entities: [
        {
          id: ENTITY, type: "person", subtype: null, displayName,
          aliases: [], status: "active", lastMentionedAt: null,
        },
      ],
    }),
  );
  store.opportunities.push({
    id: "opp-1",
    userId: USER,
    signalId: "sig-1",
    entityId: ENTITY,
    proposal: {
      entityId: ENTITY,
      entityName: displayName,
      eventType: "visit",
      observation: {
        kind: "user_stated_absence",
        window: { start: "2026-09-09", end: "2026-09-16" },
      },
      question: "ask_if_visiting",
    },
    sharePayload: { fromDisplayName: "Dad", topic: "visit", question: "ask_if_visiting" },
    renderedText: TEXT,
    renderedTextHash: sha256Hex(TEXT),
    status: "drafted",
    offeredAt: null,
    resolvedAt: null,
    expiresAt: new Date(NOW.getTime() + 24 * HOUR).toISOString(),
    createdAt: NOW.toISOString(),
  });
  return store;
}

const offerFor = (displayName: string) => {
  const store = storeWithLabel(displayName);
  return prepareOffer(m5Deps({ store, clock: fixedClock(NOW) }).consent, {
    userId: USER,
    conversationId: "conv-1",
    recentMessages: conversationUnderway(NOW),
  }).then((result) => ({ result, store }));
};

beforeEach(() => {
  resetIds();
  resetM5Ids();
});

describe("1. the label actually observed", () => {
  it("is suppressed, not printed", async () => {
    const { result } = await offerFor("M4Absence1789574558");
    expect(result.outcome).toBe("none");
  });

  it("and the opportunity is not spent by being suppressed", async () => {
    // It stays `drafted`, so nothing is burned and no cooldown starts. If
    // the entity is ever given a real name, the offer is still there.
    const { store } = await offerFor("M4Absence1789574558");
    expect(store.opportunities[0].status).toBe("drafted");
    expect(store.opportunities[0].offeredAt).toBeNull();
  });
});

describe("2. the rule is general, not a patch for one string", () => {
  it.each([
    ["M4Absence1789574558", "the observed one"],
    ["M5Person1789574999", "its sibling recipe"],
    ["user_42", "an internal handle"],
    ["550e8400-e29b-41d4-a716-446655440000", "a uuid"],
    ["Test Entity 3", "a numbered test label"],
    ["<script>x</script>", "markup"],
    ["", "nothing at all"],
  ])("suppresses %j (%s)", async (label) => {
    const { result } = await offerFor(label);
    expect(result.outcome).toBe("none");
  });

  it("nothing anywhere matches on a prefix, a fixture or an id", async () => {
    const { readFileSync } = await import("node:fs");
    for (const file of ["server/services/consent.ts", "core/share/minimize.ts"]) {
      const source = readFileSync(file, "utf8");
      // The rule is a character class. If a name ever appears in it, the
      // guard has become a special case and stopped being a rule.
      expect(source, file).not.toMatch(/M4Absence|M5Person|startsWith\("M4/);
    }
  });
});

describe("2a. the limit of a character-class rule, stated rather than hidden", () => {
  /**
   * `sanitizeLabel` allows letters, marks, spaces, apostrophes, hyphens and
   * dots, because "Mary-Jane", "O'Brien" and "St. John" are names. An
   * identifier made only of those — "entity-john" — is therefore
   * indistinguishable from a name by character class alone, and it is
   * presented.
   *
   * That is recorded here rather than patched, because every way of closing
   * it guesses at what a name looks like: banning hyphens loses Jean-Luc,
   * requiring a capital loses non-Western capitalisation, and matching
   * "entity-" is the fixture-specific rule this fix exists to avoid. Every
   * identifier CareLoop actually mints carries a digit or an underscore,
   * and those are refused.
   *
   * See docs/08-pending-items.md for the row.
   */
  it("an all-alphabetic identifier still gets through", async () => {
    const { result } = await offerFor("entity-john");
    expect(result.outcome).toBe("offered");
  });

  it("but every identifier CareLoop itself mints does not", async () => {
    // Seeded names carry an epoch; database ids are uuids; dev handles
    // carry underscores or digits. All three are refused above.
    for (const minted of ["M4Absence1789574558", "550e8400-e29b-41d4-a716-446655440000", "user_42"]) {
      expect(sanitizeLabel(minted)).toBeNull();
    }
  });
});

describe("3. real names are untouched", () => {
  it.each(["John", "Margaret", "Mary-Jane", "O'Brien", "Jean-Luc", "St. John", "Åsa", "José"])(
    "presents %j exactly as stored",
    async (label) => {
      const { result } = await offerFor(label);
      expect(result.outcome).toBe("offered");
      if (result.outcome !== "offered") return;
      expect(result.entityName).toBe(label);
      // Byte-identical: a presentation check must not tidy somebody's name.
      expect(result.block).toContain(`I can send ${label} this message:`);
    },
  );
});

describe("4. it is the same rule the outbound path already used", () => {
  it("the card and the family message agree about every label", async () => {
    // The two boundaries are now one decision. Before this, minimization
    // would refuse a label that the card had already printed.
    for (const label of ["John", "M4Absence1789574558", "user_42", "Margaret"]) {
      const presentable = sanitizeLabel(label) !== null;
      const { result } = await offerFor(label);
      expect(result.outcome === "offered", label).toBe(presentable);
    }
  });
});
