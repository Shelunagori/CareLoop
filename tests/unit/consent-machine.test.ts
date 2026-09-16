import { describe, expect, it } from "vitest";
import {
  canTransition,
  IllegalTransitionError,
  legalTransitions,
  transition,
  type OpportunityEvent,
} from "@/core/consent/machine";
import {
  OPEN_OPPORTUNITY_STATUSES,
  OPPORTUNITY_STATUSES,
  TERMINAL_OPPORTUNITY_STATUSES,
  isOpenOpportunity,
  type OpportunityStatus,
} from "@/core/consent/status";

const EVENTS: OpportunityEvent[] = ["offer", "approve", "decline", "consume", "expire"];

describe("1. the frozen vocabulary (F5)", () => {
  it("is exactly seven statuses", () => {
    expect([...OPPORTUNITY_STATUSES]).toEqual([
      "proposed", "drafted", "offered", "approved", "consumed", "declined", "expired",
    ]);
  });

  it("partitions into open and terminal, covering all seven exactly once", () => {
    const union = [...OPEN_OPPORTUNITY_STATUSES, ...TERMINAL_OPPORTUNITY_STATUSES];
    expect(union.slice().sort()).toEqual([...OPPORTUNITY_STATUSES].sort());
    expect(new Set(union).size).toBe(OPPORTUNITY_STATUSES.length);
  });

  it("counts `approved` as OPEN", () => {
    // Between approval and send the loop is still in flight; a second
    // opportunity for the same entity then would be exactly the nagging the
    // suppression rules exist to prevent.
    expect(isOpenOpportunity("approved")).toBe(true);
    expect(isOpenOpportunity("consumed")).toBe(false);
  });
});

describe("2. M5 owns exactly four forward transitions", () => {
  it("drafted -> offered -> approved -> consumed, and offered -> declined", () => {
    expect(transition("drafted", "offer")).toBe("offered");
    expect(transition("offered", "approve")).toBe("approved");
    expect(transition("offered", "decline")).toBe("declined");
    expect(transition("approved", "consume")).toBe("consumed");
  });

  it("introduces no eighth status", () => {
    const produced = new Set(legalTransitions().map((t) => t.to));
    for (const status of produced) {
      expect(OPPORTUNITY_STATUSES).toContain(status);
    }
  });
});

describe("3. expiry reaches every pre-terminal state and no terminal one", () => {
  it("expires proposed, drafted, offered and approved", () => {
    for (const from of ["proposed", "drafted", "offered", "approved"] as OpportunityStatus[]) {
      expect(transition(from, "expire")).toBe("expired");
    }
  });

  it("cannot expire a terminal opportunity", () => {
    for (const from of TERMINAL_OPPORTUNITY_STATUSES) {
      expect(() => transition(from, "expire")).toThrow(IllegalTransitionError);
    }
  });
});

describe("4. every illegal transition throws", () => {
  const legal = new Set(legalTransitions().map((t) => `${t.from}:${t.event}`));

  for (const from of OPPORTUNITY_STATUSES) {
    for (const event of EVENTS) {
      const key = `${from}:${event}`;
      if (legal.has(key)) continue;
      it(`refuses ${key}`, () => {
        expect(() => transition(from, event)).toThrow(IllegalTransitionError);
        expect(canTransition(from, event)).toBe(false);
      });
    }
  }
});

describe("5. the specific illegal moves that matter", () => {
  it("cannot skip the offer: drafted never approves directly", () => {
    // The person has to have SEEN the bytes. Approving a draft nobody was
    // shown is the whole failure this milestone exists to prevent.
    expect(() => transition("drafted", "approve")).toThrow();
  });

  it("cannot re-send: consumed never consumes again", () => {
    expect(() => transition("consumed", "consume")).toThrow();
  });

  it("cannot revive a decline or an expiry", () => {
    expect(() => transition("declined", "offer")).toThrow();
    expect(() => transition("declined", "approve")).toThrow();
    expect(() => transition("expired", "approve")).toThrow();
    expect(() => transition("expired", "offer")).toThrow();
  });

  it("cannot consume without an approval", () => {
    expect(() => transition("offered", "consume")).toThrow();
    expect(() => transition("drafted", "consume")).toThrow();
  });

  it("names the state and the event it refused", () => {
    try {
      transition("expired", "approve");
      throw new Error("expected a throw");
    } catch (error) {
      expect(error).toBeInstanceOf(IllegalTransitionError);
      expect((error as IllegalTransitionError).from).toBe("expired");
      expect((error as IllegalTransitionError).event).toBe("approve");
    }
  });
});
