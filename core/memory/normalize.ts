/**
 * Name and key normalization. Shared by entity resolution and fact keys so
 * "John", "john" and " John " are the same lookup, deterministically.
 */
export function normalizeName(raw: string): string {
  return raw
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/['’`]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Fact keys are dotted, lowercase and freeform — no ontology, just hygiene. */
export function normalizeFactKey(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^\p{L}\p{N}._]/gu, "_")
    .replace(/_+/g, "_")
    .replace(/^[._]+|[._]+$/g, "")
    .trim();
}

/** Used to decide whether two episode summaries are the same on replay. */
export function normalizeSummary(raw: string): string {
  return normalizeName(raw);
}
