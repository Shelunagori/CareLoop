import { normalizeName } from "./normalize";

/**
 * Defence in depth at the extraction boundary.
 *
 * The contract says the person writing is represented by `null`, never by a
 * mention. The prompt is where that is taught; this is what catches the model
 * on a turn where it forgets. A prompt instruction is a request, and requests
 * are honoured most of the time.
 *
 * The list is deliberately tiny and exact-match: bare first-person pronouns
 * only. It does NOT include possessive role phrases, and it must not.
 * "my son" does not refer to the speaker — it refers to John. Folding it into
 * the user would silently attach a relationship to the wrong end, which is a
 * worse failure than the one this guards against. Those phrases are handled by
 * getting the extraction right, not by rewriting it afterwards.
 */
const SELF_TOKENS = new Set(["i", "me", "myself"]);

export function isSelfReference(mention: string): boolean {
  return SELF_TOKENS.has(normalizeName(mention));
}

/**
 * For an edge's SOURCE or a fact's SUBJECT, a bare self-pronoun means the
 * user, which the schema represents as null.
 */
export function normalizeSelfEndpoint(mention: string | null): string | null {
  if (mention === null) return null;
  return isSelfReference(mention) ? null : mention;
}
