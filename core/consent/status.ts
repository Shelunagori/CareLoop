/**
 * The canonical opportunity status vocabulary (F5, docs/04 section 11.2).
 *
 * Seven names, defined once and imported everywhere — schema enum, core,
 * services, debug UI. The open/terminal partition is declared here too, so
 * "what counts as open" is a value rather than a condition retyped at each
 * call site.
 *
 * M4 uses `proposed` and `drafted` and reads the rest. The transition machine
 * that moves an opportunity past `drafted` is M5's.
 */
export const OPPORTUNITY_STATUSES = [
  "proposed",
  "drafted",
  "offered",
  "approved",
  "consumed",
  "declined",
  "expired",
] as const;

export type OpportunityStatus = (typeof OPPORTUNITY_STATUSES)[number];

/**
 * `approved` is deliberately OPEN, not terminal: between approval and send the
 * loop is still in flight, and a second opportunity for the same entity would
 * be exactly the nagging suppression exists to prevent (docs/04 section 11.2).
 */
export const OPEN_OPPORTUNITY_STATUSES = [
  "proposed",
  "drafted",
  "offered",
  "approved",
] as const satisfies readonly OpportunityStatus[];

export const TERMINAL_OPPORTUNITY_STATUSES = [
  "consumed",
  "declined",
  "expired",
] as const satisfies readonly OpportunityStatus[];

const OPEN = new Set<string>(OPEN_OPPORTUNITY_STATUSES);

export function isOpenOpportunity(status: OpportunityStatus): boolean {
  return OPEN.has(status);
}

export function isTerminalOpportunity(status: OpportunityStatus): boolean {
  return !OPEN.has(status);
}
