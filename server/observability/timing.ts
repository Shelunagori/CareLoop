import "server-only";

/**
 * Step timings for a multi-step server operation.
 *
 * CONTENT-FREE BY CONSTRUCTION. A timer records a step NAME and a duration in
 * milliseconds, and there is no parameter for anything else - so an
 * instrumented path cannot start logging a user id, an email address or a
 * capability URL because somebody was debugging. Same reasoning as
 * `logDelivery`: a log line is the easiest place for content to escape, so the
 * shape of the logger decides what can be in it.
 *
 * Durations come from a monotonic clock rather than `Date.now()`, so a clock
 * adjustment mid-request cannot produce a negative step.
 */
export type Timer = {
  /** Records the time since the previous mark (or since start) under `step`. */
  mark(step: string): void;
  /** Emits one line: every step, the total, and nothing else. */
  done(event: string, extra?: Record<string, number | boolean | string>): void;
};

export function startTimer(now: () => number = () => performance.now()): Timer {
  const began = now();
  let previous = began;
  const steps: Record<string, number> = {};

  return {
    mark(step) {
      const at = now();
      steps[step] = Math.round(at - previous);
      previous = at;
    },
    done(event, extra = {}) {
      console.log(
        JSON.stringify({
          event,
          // Named `ms` so a log search for a slow step finds the unit too.
          ms: { ...steps, total: Math.round(now() - began) },
          ...extra,
        }),
      );
    },
  };
}
