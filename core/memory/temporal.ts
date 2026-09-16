/**
 * Deterministic temporal resolution.
 *
 * The model is a sensor: it reports the PHRASE the person used ("yesterday",
 * "last Sunday"). It never reports an absolute date it computed itself,
 * because a model that quietly invents "2026-09-15" gives you a memory system
 * that rots silently — and "last Sunday" means something different every time
 * you read it back (docs/02 §6).
 *
 * This module maps a documented vocabulary onto an offset from the message
 * timestamp. Anything outside the vocabulary resolves to the message time with
 * precision "unknown", which is honest rather than wrong.
 */
export type TimePrecision = "exact" | "day" | "week" | "unknown";

export type TemporalClaim = {
  /** The phrase as the person said it, or null. */
  expression: string | null;
  /** An explicit calendar date the person stated, ISO yyyy-mm-dd, or null. */
  absoluteDate: string | null;
};

export type ResolvedTime = {
  occurredAt: Date;
  precision: TimePrecision;
  /** Which vocabulary rule fired, for the debug view. null = fell back. */
  matched: string | null;
};

const DAY_MS = 86_400_000;

/** Offsets in days from the reference day, with the precision they justify. */
const PHRASES: Array<[RegExp, number, TimePrecision, string]> = [
  [/^(just )?now$|^today$|^this (morning|afternoon|evening)$|^tonight$/, 0, "day", "today"],
  [/^yesterday$|^last night$/, -1, "day", "yesterday"],
  [/^(the )?day before yesterday$/, -2, "day", "day_before_yesterday"],
  [/^this week$/, 0, "week", "this_week"],
  [/^last week$/, -7, "week", "last_week"],
  [/^this weekend$/, 0, "week", "this_weekend"],
  [/^last weekend$/, -7, "week", "last_weekend"],
  [/^a (week|wk) ago$/, -7, "week", "a_week_ago"],
  [/^a fortnight ago$|^two weeks ago$/, -14, "week", "two_weeks_ago"],
  [/^last month$/, -30, "week", "last_month"],
  [/^recently$|^the other day$|^a few days ago$/, -3, "unknown", "recently"],
];

const WEEKDAYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function normalizePhrase(raw: string): string {
  return raw.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, "").replace(/\s+/g, " ").trim();
}

export function resolveTemporal(input: {
  claim: TemporalClaim;
  /** The moment the person said it — always the anchor. */
  referenceAt: Date;
}): ResolvedTime {
  const { claim, referenceAt } = input;

  // An explicit date is accepted only if it parses AND is not in the future
  // relative to when it was said. The model cannot hand us a date the person
  // did not give, and cannot hand us a nonsense one.
  if (claim.absoluteDate) {
    const parsed = new Date(`${claim.absoluteDate}T00:00:00.000Z`);
    const withinRange =
      !Number.isNaN(parsed.getTime()) &&
      parsed.getTime() <= startOfUtcDay(referenceAt).getTime() &&
      parsed.getTime() > referenceAt.getTime() - 3650 * DAY_MS;
    if (withinRange) {
      return { occurredAt: parsed, precision: "day", matched: "absolute_date" };
    }
  }

  if (!claim.expression) {
    return { occurredAt: referenceAt, precision: "unknown", matched: null };
  }

  const phrase = normalizePhrase(claim.expression);

  for (const [pattern, offsetDays, precision, name] of PHRASES) {
    if (pattern.test(phrase)) {
      const day = startOfUtcDay(new Date(referenceAt.getTime() + offsetDays * DAY_MS));
      return { occurredAt: day, precision, matched: name };
    }
  }

  // "last sunday", "on tuesday" — the most recent occurrence strictly before
  // the reference day.
  const weekday = phrase.match(/(?:^|\s)(?:last |on |this past )?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)$/);
  if (weekday) {
    const target = WEEKDAYS.indexOf(weekday[1]);
    const referenceDay = startOfUtcDay(referenceAt);
    let delta = referenceDay.getUTCDay() - target;
    if (delta <= 0) delta += 7;
    return {
      occurredAt: new Date(referenceDay.getTime() - delta * DAY_MS),
      precision: "day",
      matched: `weekday_${WEEKDAYS[target]}`,
    };
  }

  return { occurredAt: referenceAt, precision: "unknown", matched: null };
}

/**
 * The window an absence assertion covers.
 *
 * "I haven't seen John this week" is positive evidence of NON-occurrence over
 * a span, not a point event (D6), and the schema enforces that an absence row
 * carries both ends. A window is only derived when the person's own phrase
 * supports one: if the resolver fell back to "unknown", no window is invented
 * and the caller records nothing. Guessing a span would fabricate the very
 * evidence the pattern layer rests on.
 */
export function resolveAbsenceWindow(input: {
  claim: TemporalClaim;
  referenceAt: Date;
}): { start: Date; end: Date } | null {
  const resolved = resolveTemporal(input);
  if (resolved.matched === null || resolved.precision === "unknown") return null;

  // A week-scale phrase ("this week") runs from its start up to the moment they
  // said it. A day-scale phrase covers that single day.
  const end =
    resolved.precision === "week"
      ? input.referenceAt
      : new Date(resolved.occurredAt.getTime() + DAY_MS);

  if (end.getTime() <= resolved.occurredAt.getTime()) return null;
  return { start: resolved.occurredAt, end };
}
