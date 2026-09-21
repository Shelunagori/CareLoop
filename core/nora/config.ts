/**
 * Nora's configuration, in one place (M12).
 *
 * Nora is an OPTIONAL wake-word experiment with a hard end date: Picovoice
 * access for this project runs out on 25 September 2026. After that the
 * feature must be gone at runtime — no initialization, no listener, no
 * microphone — and CareLoop must be exactly what it was before, which is
 * push-to-talk.
 *
 * The date therefore lives HERE and nowhere else. A cutoff spelled out in a
 * component, a route and a test is three cutoffs, and the one that gets
 * missed is the one still holding a microphone open.
 *
 * TIMEZONE. UTC, deliberately and consistently: `core/baseline/day.ts`
 * already computes every date in CareLoop on UTC days, for the same reason
 * (a stable number beats a local one). "End of 25 September 2026" therefore
 * means 2026-09-25T23:59:59.999Z, not the end of that day wherever the
 * person happens to be.
 */
export const NORA_AVAILABLE_UNTIL_DEFAULT = "2026-09-25T23:59:59.999Z";

/**
 * The cutoff this deployment is running under.
 *
 * Overridable so the boundary can be exercised with a real value rather than
 * only with a fake clock, and so ending the experiment early is a
 * configuration change rather than a deploy. An unparseable value falls back
 * to the default instead of being believed — "2026-13-45" must not become a
 * cutoff nobody notices has passed or has not.
 */
export function readNoraCutoff(env: { NORA_AVAILABLE_UNTIL?: string }): string {
  const raw = env.NORA_AVAILABLE_UNTIL?.trim();
  if (!raw) return NORA_AVAILABLE_UNTIL_DEFAULT;
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) return NORA_AVAILABLE_UNTIL_DEFAULT;
  return new Date(parsed).toISOString();
}

/**
 * Whether the pieces Nora needs have been supplied — as BOOLEANS.
 *
 * Presence, never the value. The access key is a `NEXT_PUBLIC_` variable
 * because Porcupine runs in the browser and cannot work otherwise, so it is
 * public by architecture; that is all the more reason for nothing on the
 * server side to pass it around, log it or return it in a response body. A
 * function that can only produce booleans cannot leak one by accident.
 */
export type NoraConfigured = {
  accessKeyPresent: boolean;
  keywordPresent: boolean;
};

export function noraConfigured(env: {
  NEXT_PUBLIC_PICOVOICE_ACCESS_KEY?: string;
  NEXT_PUBLIC_NORA_KEYWORD_PATH?: string;
}): NoraConfigured {
  return {
    accessKeyPresent: (env.NEXT_PUBLIC_PICOVOICE_ACCESS_KEY ?? "").trim().length > 0,
    /**
     * Declared, not probed. "Nora" is not one of Porcupine's built-in
     * keywords, so it needs a `.ppn` trained in the Picovoice Console and
     * served from `public/`. A filesystem check would be wrong on a
     * serverless deployment, where public assets are not in the function
     * bundle; a declaration is honest about what the server actually knows,
     * and a declared-but-missing file surfaces as `initialization_failed` in
     * the browser, which is where the truth is available.
     */
    keywordPresent: (env.NEXT_PUBLIC_NORA_KEYWORD_PATH ?? "").trim().length > 0,
  };
}

/** The Porcupine parameter model, served from `public/`. */
export const NORA_MODEL_PATH = "/nora/porcupine_params.pv";
