import { OPPORTUNITY_STATUSES, type OpportunityStatus } from "./status";

/**
 * The opportunity transition machine (docs/04 section 11.2).
 *
 * A pure function `(state, event) -> state`, with illegal transitions
 * throwing. The `switch` is exhaustive over the seven canonical statuses with
 * NO default branch, so adding an eighth would fail the build rather than fall
 * through to "do nothing" - which is how consent bugs get shipped.
 *
 * Why a machine rather than booleans: `approved_at IS NOT NULL AND sent_at IS
 * NULL AND NOT revoked` scattered across three call sites is exactly how a
 * message gets sent twice, or after a revocation.
 */
export type OpportunityEvent = "offer" | "approve" | "decline" | "consume" | "expire";

export class IllegalTransitionError extends Error {
  constructor(
    readonly from: OpportunityStatus,
    readonly event: OpportunityEvent,
  ) {
    super(`Illegal opportunity transition: ${from} --${event}--> ?`);
    this.name = "IllegalTransitionError";
  }
}

/** Statuses an opportunity may expire FROM. Terminal ones cannot. */
const EXPIRABLE: readonly OpportunityStatus[] = ["proposed", "drafted", "offered", "approved"];

export function transition(
  from: OpportunityStatus,
  event: OpportunityEvent,
): OpportunityStatus {
  if (event === "expire") {
    // `approved` is expirable because the 72h consent clock can lapse before
    // the send (docs/04 section 11.5). `consumed` is not: the action already
    // happened and cannot be un-performed.
    if (EXPIRABLE.includes(from)) return "expired";
    throw new IllegalTransitionError(from, event);
  }

  switch (from) {
    case "proposed":
      // Only the draft step moves a proposed opportunity, and that is M4's.
      throw new IllegalTransitionError(from, event);
    case "drafted":
      if (event === "offer") return "offered";
      throw new IllegalTransitionError(from, event);
    case "offered":
      if (event === "approve") return "approved";
      if (event === "decline") return "declined";
      throw new IllegalTransitionError(from, event);
    case "approved":
      if (event === "consume") return "consumed";
      throw new IllegalTransitionError(from, event);
    case "consumed":
    case "declined":
    case "expired":
      // Terminal. Nothing reopens an opportunity - a fresh reconnect needs a
      // fresh signal, a fresh opportunity and a fresh draft.
      throw new IllegalTransitionError(from, event);
  }
}

export function canTransition(from: OpportunityStatus, event: OpportunityEvent): boolean {
  try {
    transition(from, event);
    return true;
  } catch {
    return false;
  }
}

/** Every legal (from, event) pair, for tests and the debug view. */
export function legalTransitions(): Array<{
  from: OpportunityStatus;
  event: OpportunityEvent;
  to: OpportunityStatus;
}> {
  const events: OpportunityEvent[] = ["offer", "approve", "decline", "consume", "expire"];
  const out: Array<{ from: OpportunityStatus; event: OpportunityEvent; to: OpportunityStatus }> = [];
  for (const from of OPPORTUNITY_STATUSES) {
    for (const event of events) {
      try {
        out.push({ from, event, to: transition(from, event) });
      } catch {
        // illegal, deliberately omitted
      }
    }
  }
  return out;
}
