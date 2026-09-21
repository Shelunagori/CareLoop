"use client";

import { useSyncExternalStore } from "react";

/**
 * The BROWSER's hour, and only after hydration (M12f).
 *
 * Two problems, one answer. The server's timezone is not the person's — a
 * deployment saying "Good morning" to somebody at ten at night is worse
 * than saying nothing — and rendering a clock-dependent string during SSR
 * is a hydration mismatch by construction, because the two clocks are in
 * different places.
 *
 * So the hour is `null` on the server and on the hydrating render, and the
 * greeting is simply not rendered until it is known. That is one frame on
 * an empty conversation; a wrong greeting, or a hydration warning, lasts
 * longer.
 *
 * `useSyncExternalStore` RATHER THAN an effect that sets state. React's own
 * answer to "the server and the client disagree about this value", and it
 * carries the server snapshot in the API instead of as a first render to be
 * corrected — which is also why it does not trip
 * `react-hooks/set-state-in-effect`.
 *
 * It does not tick. Nothing here re-renders when the hour rolls over: the
 * opening is shown once, at the start of a sitting, and a greeting that
 * changed under somebody mid-conversation would be stranger than one that
 * is four minutes stale.
 */

/** Never fires. The value is read once per mount, on purpose. */
const subscribe = () => () => {};

export function useLocalHour(): number | null {
  return useSyncExternalStore(
    subscribe,
    () => new Date().getHours(),
    () => null,
  );
}
