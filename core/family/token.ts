import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * The family capability token (R7, docs/04 section 12.1).
 *
 * 32 random bytes, base64url, stored only as a SHA-256 hash. The plaintext
 * exists in the link and nowhere else: not in the database, not in a log, not
 * in a debug view. A leaked link therefore exposes one approved sentence and
 * expires, rather than becoming a permanent read handle.
 *
 * Why the REQUEST owns it rather than the contact: a token on the contact is a
 * standing key to whatever that person is ever sent - it accumulates authority
 * and cannot be rotated without breaking old links. A token on the request is
 * scoped to exactly one approved sentence, which is the same granularity as
 * the consent that produced it. Access control should never be broader than
 * the consent it enforces.
 */
export const FAMILY_TOKEN_BYTES = 32;

/** Read/respond window for one recipient over one artefact (F2). */
export const FAMILY_TOKEN_WINDOW_DAYS = 7;

export type MintedToken = {
  /** Goes in the link. Never persisted, never logged. */
  plaintext: string;
  /** Goes in the database. */
  hash: string;
};

export function mintFamilyToken(): MintedToken {
  const plaintext = randomBytes(FAMILY_TOKEN_BYTES).toString("base64url");
  return { plaintext, hash: hashFamilyToken(plaintext) };
}

export function hashFamilyToken(plaintext: string): string {
  return createHash("sha256").update(plaintext, "utf8").digest("hex");
}

/**
 * Constant-time comparison of two token hashes.
 *
 * The lookup itself is by hash, so a timing signal here leaks little - but
 * "little" is not "none", and the cost of doing it properly is one function
 * call. Lengths are compared first because timingSafeEqual throws on a
 * mismatch; that comparison is not secret, since the hash length is fixed.
 */
export function tokenHashEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function familyTokenExpiresAt(
  createdAt: Date,
  windowDays = FAMILY_TOKEN_WINDOW_DAYS,
): Date {
  return new Date(createdAt.getTime() + windowDays * 86_400_000);
}

/**
 * Boundary: exactly at expiry is EXPIRED, matching the consent clock. Read
 * authority has to end at a defined instant.
 */
export function isTokenExpired(expiresAt: string, now: Date): boolean {
  return now.getTime() >= Date.parse(expiresAt);
}

/** Enough to correlate a log line with a row, useless as a credential. */
export function tokenHashPrefix(hash: string): string {
  return hash.slice(0, 8);
}
