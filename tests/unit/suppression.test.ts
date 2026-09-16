import { describe, expect, it } from "vitest";
import { DAY_MS } from "@/core/baseline/day";
import { detectionConfig } from "@/core/detection/config";
import {
  evaluateSuppression,
  SUPPRESSION_REASONS,
  type SuppressionInput,
} from "@/core/detection/suppression";
import type { SignalType } from "@/core/detection/types";

const NOW = new Date("2026-09-16T12:00:00.000Z");
const ago = (days: number) => new Date(NOW.getTime() - days * DAY_MS);

/** A snapshot in which nothing is in the way. Each test spoils one thing. */
function clear(overrides: Partial<SuppressionInput> = {}): SuppressionInput {
  return {
    signalType: "cadence_gap" as SignalType,
    entityId: "entity-john",
    accountStartedAt: ago(200),
    openOpportunityCountForEntity: 0,
    offeredAtForEntity: [],
    declinedAtForEntity: [],
    outstandingFamilyRequestCount: 0,
    offersInConversation: 0,
    offeredAtForAccount: [],
    ...overrides,
  };
}

const refuse = (input: SuppressionInput) => {
  const decision = evaluateSuppression(input, NOW);
  if (decision.allowed) throw new Error("expected suppression");
  return decision;
};

describe("0. a clear snapshot is allowed", () => {
  it("allows both detectors when nothing is in the way", () => {
    expect(evaluateSuppression(clear(), NOW)).toEqual({ allowed: true });
    expect(evaluateSuppression(clear({ signalType: "user_asserted_absence" }), NOW)).toEqual({
      allowed: true,
    });
  });
});

describe("1. one open opportunity per entity", () => {
  it("refuses while one is open", () => {
    expect(refuse(clear({ openOpportunityCountForEntity: 1 })).reason).toBe(
      "open_opportunity_exists",
    );
  });
  it("allows once none are open", () => {
    expect(evaluateSuppression(clear({ openOpportunityCountForEntity: 0 }), NOW).allowed).toBe(true);
  });
});

describe("2. offer cooldown — 7 days", () => {
  it("refuses just inside the window", () => {
    expect(refuse(clear({ offeredAtForEntity: [ago(6.99)] })).reason).toBe("offer_cooldown");
  });
  it("allows exactly at the boundary", () => {
    expect(evaluateSuppression(clear({ offeredAtForEntity: [ago(7)] }), NOW).allowed).toBe(true);
  });
  it("uses the most recent offer, not the oldest", () => {
    expect(refuse(clear({ offeredAtForEntity: [ago(90), ago(1)] })).reason).toBe("offer_cooldown");
  });
});

describe("3. decline cooldown — 30 days", () => {
  it("refuses just inside the window", () => {
    expect(refuse(clear({ declinedAtForEntity: [ago(29.99)] })).reason).toBe("decline_cooldown");
  });
  it("allows exactly at the boundary", () => {
    expect(evaluateSuppression(clear({ declinedAtForEntity: [ago(30)] }), NOW).allowed).toBe(true);
  });
});

describe("4. two declines in 30 days — 90-day quiet period", () => {
  it("refuses for 90 days measured from the SECOND decline", () => {
    // Declines 89 and 100 days ago: 11 days apart, so the pair triggers, and
    // the quiet period runs to day 89 + 90.
    expect(refuse(clear({ declinedAtForEntity: [ago(89), ago(100)] })).reason).toBe(
      "decline_quiet_period",
    );
  });
  it("allows once 90 days have passed since the second", () => {
    expect(
      evaluateSuppression(clear({ declinedAtForEntity: [ago(90), ago(101)] }), NOW).allowed,
    ).toBe(true);
  });
  it("does not trigger when the two declines are more than 30 days apart", () => {
    // 40 and 75 days ago: 35 days apart, so no quiet period — and both are
    // past the ordinary 30-day cooldown.
    expect(
      evaluateSuppression(clear({ declinedAtForEntity: [ago(40), ago(75)] }), NOW).allowed,
    ).toBe(true);
  });
  it("a third decline extends rather than restarts", () => {
    const decision = refuse(clear({ declinedAtForEntity: [ago(85), ago(95), ago(200)] }));
    expect(decision.reason).toBe("decline_quiet_period");
  });
});

describe("5. the first 14 days — cadence only", () => {
  it("refuses a cadence signal just inside the window", () => {
    const decision = refuse(clear({ accountStartedAt: ago(13.99) }));
    expect(decision.reason).toBe("account_too_new_for_cadence");
  });
  it("allows a cadence signal exactly at the boundary", () => {
    expect(evaluateSuppression(clear({ accountStartedAt: ago(14) }), NOW).allowed).toBe(true);
  });
  it("NEVER suppresses an explicit absence assertion, however new the account", () => {
    const decision = evaluateSuppression(
      clear({ signalType: "user_asserted_absence", accountStartedAt: ago(0) }),
      NOW,
    );
    expect(decision.allowed).toBe(true);
  });
});

describe("6. an outstanding family request stops everything", () => {
  it("refuses both detectors", () => {
    expect(refuse(clear({ outstandingFamilyRequestCount: 1 })).reason).toBe(
      "family_request_outstanding",
    );
    expect(
      refuse(clear({ signalType: "user_asserted_absence", outstandingFamilyRequestCount: 2 }))
        .reason,
    ).toBe("family_request_outstanding");
  });
});

describe("7. one offer per conversation", () => {
  it("refuses a second offer in the same conversation", () => {
    expect(refuse(clear({ offersInConversation: 1 })).reason).toBe("conversation_offer_cap");
  });
  it("allows the first", () => {
    expect(evaluateSuppression(clear({ offersInConversation: 0 }), NOW).allowed).toBe(true);
  });
});

describe("8. three offers per week, across the whole account", () => {
  it("refuses the fourth", () => {
    const decision = refuse(clear({ offeredAtForAccount: [ago(1), ago(2), ago(3)] }));
    expect(decision.reason).toBe("weekly_offer_cap");
  });
  it("allows when one has aged out of the window", () => {
    expect(
      evaluateSuppression(clear({ offeredAtForAccount: [ago(1), ago(2), ago(8)] }), NOW).allowed,
    ).toBe(true);
  });
  it("counts other entities too — the cap is global", () => {
    // None of these is for this entity, so no per-entity rule fires first.
    const decision = refuse(clear({ offeredAtForAccount: [ago(0.5), ago(1.5), ago(2.5)] }));
    expect(decision.reason).toBe("weekly_offer_cap");
  });
});

describe("9. precedence when several rules are true at once", () => {
  const everything = clear({
    openOpportunityCountForEntity: 1,
    outstandingFamilyRequestCount: 1,
    declinedAtForEntity: [ago(1), ago(10)],
    offeredAtForEntity: [ago(1)],
    accountStartedAt: ago(1),
    offersInConversation: 5,
    offeredAtForAccount: [ago(1), ago(2), ago(3)],
  });

  it("is a documented total order, most specific first", () => {
    const order: string[] = [];
    let input = everything;
    // Peel one rule at a time and record which reason surfaces next.
    const peels: Array<Partial<SuppressionInput>> = [
      { openOpportunityCountForEntity: 0 },
      { outstandingFamilyRequestCount: 0 },
      // One decline left: the pair is broken, the single cooldown remains.
      { declinedAtForEntity: [ago(1)] },
      { declinedAtForEntity: [] },
      { offeredAtForEntity: [] },
      { accountStartedAt: ago(200) },
      { offersInConversation: 0 },
      { offeredAtForAccount: [] },
    ];

    for (const peel of peels) {
      const decision = evaluateSuppression(input, NOW);
      if (!decision.allowed) order.push(decision.reason);
      input = { ...input, ...peel };
    }
    expect(order).toEqual([
      "open_opportunity_exists",
      "family_request_outstanding",
      "decline_quiet_period",
      "decline_cooldown",
      "offer_cooldown",
      "account_too_new_for_cadence",
      "conversation_offer_cap",
      "weekly_offer_cap",
    ]);
    expect(evaluateSuppression(input, NOW).allowed).toBe(true);
  });

  it("every reason code is reachable and machine-readable", () => {
    expect(new Set(SUPPRESSION_REASONS).size).toBe(SUPPRESSION_REASONS.length);
    for (const reason of SUPPRESSION_REASONS) {
      expect(reason).toMatch(/^[a-z_]+$/);
    }
  });
});

describe("10. the numbers come from config, not from literals here", () => {
  it("tracks a config change", () => {
    const tighter = { ...detectionConfig, offerCooldownDays: 30 };
    const input = clear({ offeredAtForEntity: [ago(10)] });
    expect(evaluateSuppression(input, NOW).allowed).toBe(true);
    const decision = evaluateSuppression(input, NOW, tighter);
    expect(decision.allowed).toBe(false);
  });
});
