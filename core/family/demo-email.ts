/**
 * The demo recipient's email address, as typed by a reviewer.
 *
 * Pure, so the validation can be enumerated. This is untrusted input on its
 * way to a third-party transport, which makes it the one place in the demo
 * where a string from a form reaches the outside world.
 *
 * It VALIDATES and never repairs. Lowercasing, stripping angle brackets or
 * taking the first of two comma-separated addresses would each be a guess
 * about what somebody meant, and a wrong guess sends a family message to a
 * stranger. Surrounding whitespace is the one thing removed, because a pasted
 * address routinely carries it and no address can legitimately begin with a
 * space.
 */
export type DemoEmailReading =
  | { ok: true; email: string }
  | { ok: false; reason: "invalid" | "too_long" };

/** Comfortably above real addresses, well below anything worth forwarding. */
const MAX_LENGTH = 254;

/**
 * Deliberately strict, and not an attempt at RFC 5322 - a full-grammar regex
 * would accept quoted local parts and comments that no demo needs and that a
 * provider may reject anyway. One local part, one domain with a dot, no
 * whitespace, no commas, no angle brackets, no control characters.
 */
const ADDRESS = /^[^\s@,<>"]+@[^\s@,<>".]+(?:\.[^\s@,<>".]+)+$/;

export function readDemoEmail(raw: string): DemoEmailReading {
  // A newline would let a caller append their own mail headers.
  if (/[\r\n\0]/.test(raw)) return { ok: false, reason: "invalid" };

  const email = raw.trim();
  if (email.length > MAX_LENGTH) return { ok: false, reason: "too_long" };
  if (!ADDRESS.test(email)) return { ok: false, reason: "invalid" };

  return { ok: true, email };
}
