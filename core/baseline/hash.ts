import { createHash } from "node:crypto";

/**
 * Deterministic hashing for event fingerprints and baseline inputs_hash.
 *
 * node:crypto is pure computation with no I/O, so it does not breach the core
 * purity rule the way a database or network client would. Using it keeps these
 * hashes stable across runtimes rather than depending on a hand-rolled mixer
 * with unexamined collision behaviour.
 */

/** Sentinel for a null part, so null and the string "null" cannot collide. */
const NULL_PART = "<<null>>";

export function stableHash(parts: readonly (string | number | null)[]): string {
  const canonical = parts
    .map((part) => (part === null ? NULL_PART : String(part)))
    .join("|");
  return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}
