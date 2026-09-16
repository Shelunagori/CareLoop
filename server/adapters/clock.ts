/**
 * The Clock port (docs/01 §1.3). Time is an input, not an ambient fact — which
 * is what lets temporal resolution and salience be tested deterministically,
 * and what the M6 fixture replay will use to seed history at past timestamps.
 */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export function fixedClock(at: Date | string): Clock {
  const instant = typeof at === "string" ? new Date(at) : at;
  return { now: () => new Date(instant.getTime()) };
}
