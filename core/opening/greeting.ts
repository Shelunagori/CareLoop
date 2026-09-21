/**
 * The first thing CareLoop says (M12f).
 *
 * WHAT THIS REPLACES. An empty conversation showed a static "Hello,
 * George" in the header and "Say hello whenever you're ready." in the
 * middle of the screen. The first was a label rather than a greeting — it
 * sat there all session, identical, next to whatever was being discussed —
 * and the second put the burden of starting on the person, which is
 * exactly backwards for a companion.
 *
 * TWO INDEPENDENT PARTS, AND THE SPLIT IS THE POINT.
 *
 *   The GREETING is a function of the clock. It knows nothing, claims
 *   nothing, and is always available.
 *
 *   The OPENING QUESTION is a function of stored evidence, decided on the
 *   server by `core/opening/opening.ts` under rules that have not changed:
 *   a positive visit or call the person themselves reported, 1–3 days old,
 *   above the baseline's own certainty floor. When there is no such event
 *   there is no question, and the greeting falls back to asking how they
 *   are — which is a question about now, not a memory invented to make the
 *   greeting feel personal.
 *
 * NOTHING HERE CAN MANUFACTURE A MEMORY. The only inputs are an hour, a
 * name and a sentence somebody else already decided was safe to say.
 *
 * Pure, and takes the hour as an argument rather than reading a clock, so
 * every bucket is testable without touching the machine's time.
 */

export type TimeOfDay = "morning" | "afternoon" | "evening" | "night";

/**
 * The buckets, in local time.
 *
 * Deliberately blunt. "Good evening" at 17:00 is right often enough, and
 * the alternative — sunrise tables, seasons, a location the product does
 * not have — buys nothing a person would notice. Midnight to 05:00 gets a
 * plain "Hello": somebody awake at three in the morning does not need
 * CareLoop to call it a good one.
 */
export function timeOfDay(hour: number): TimeOfDay {
  if (!Number.isFinite(hour)) return "night";
  const h = Math.floor(hour);
  if (h >= 5 && h <= 11) return "morning";
  if (h >= 12 && h <= 16) return "afternoon";
  if (h >= 17 && h <= 23) return "evening";
  return "night";
}

export function greetingWord(part: TimeOfDay): string {
  switch (part) {
    case "morning":
      return "Good morning";
    case "afternoon":
      return "Good afternoon";
    case "evening":
      return "Good evening";
    case "night":
      return "Hello";
  }
}

/** What CareLoop asks when it has nothing of its own to raise. */
export const DEFAULT_OPENING_QUESTION = "How are you doing?";

export function composeOpening(input: {
  /** Local hour, 0–23, from the BROWSER — see `useLocalHour`. */
  hour: number;
  /** The person's own display name, if they have one. */
  displayName?: string | null;
  /**
   * The deterministic memory question, or null. Never built here, only
   * placed: this function has no access to an event, an entity or a date.
   */
  openingLine?: string | null;
}): string {
  const name = input.displayName?.trim();
  const greeting = greetingWord(timeOfDay(input.hour));
  const opener = name && name.length > 0 ? `${greeting}, ${name}.` : `${greeting}.`;
  const question = input.openingLine?.trim();
  return `${opener} ${question && question.length > 0 ? question : DEFAULT_OPENING_QUESTION}`;
}
