/**
 * Structural equality for jsonb values.
 *
 * Needed because one of the five send preconditions is "the grant's payload
 * snapshot deep-equals the opportunity's payload" (docs/04 section 11.3), and
 * both sides arrive as parsed JSON whose key order is not guaranteed. A
 * `JSON.stringify` comparison would call two identical payloads different
 * because Postgres reordered the keys, and refusing a legitimate send is as
 * bad a failure as allowing an illegitimate one.
 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== "object" || typeof b !== "object") return false;

  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((item, index) => deepEqual(item, b[index]));
  }

  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every(
    (key) => Object.prototype.hasOwnProperty.call(right, key) && deepEqual(left[key], right[key]),
  );
}
