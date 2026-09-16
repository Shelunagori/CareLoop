import { createHash } from "node:crypto";

/**
 * SHA-256 over the exact UTF-8 bytes of the rendered draft (docs/04 s11.3).
 *
 * Full digest, not truncated: this hash is the consent pin. M5 compares the
 * grant's snapshot against it before sending, and a mismatch refuses the send
 * outright. Truncating to save characters would trade a security property for
 * nothing.
 *
 * Nothing trims, normalizes or re-encodes the string after this runs. The
 * bytes hashed here are the bytes stored, the bytes shown, and the bytes sent.
 */
export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
