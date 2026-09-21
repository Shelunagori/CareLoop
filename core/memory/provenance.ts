import { sanitizeLabel } from "@/core/share/minimize";

/**
 * WHO MAY BE SHOWN TO A PERSON (M12e.3).
 *
 * `entities.origin` records what created a row — the extraction pipeline
 * from something the person said (`user`), the demo fixture (`demo`), or a
 * development seeding route (`dev`). This module is the ONE place that turns
 * that column into a decision, so every surface answers it the same way.
 *
 * WHY IT EXISTS AS ITS OWN MODULE. M12e put the rule inline in
 * `prepareOffer`, which is one of NINE places that read an entity's display
 * name. The other eight were unchanged, and the first one a reviewer hit —
 * the card rendered on page load, from `loadPendingOffer` — had no rule at
 * all. An invariant enforced at one of nine call sites is not an invariant;
 * it is a coincidence that held until somebody loaded the page.
 *
 * DEMO IS PRESENTABLE, DELIBERATELY. The seeded demo IS the product a
 * reviewer is being shown. George, John and Simba must appear. `dev` must
 * not, anywhere a person can see.
 *
 * THIS IS NOT A NAME RULE. Nothing here looks at what an entity is called to
 * decide whether it is real — that is exactly the guesswork the column was
 * added to replace. `sanitizeLabel` still runs, because a label also has to
 * be fit to render, but the two questions stay separate: provenance decides
 * WHETHER, spelling decides WHAT.
 */

/** The values `entities.origin` can hold. Mirrors the database enum. */
export type EntityOrigin = "user" | "demo" | "dev";

/** The values a person may be shown. */
export const PRESENTABLE_ORIGINS: readonly EntityOrigin[] = ["user", "demo"];

/**
 * Unknown values are NOT presentable.
 *
 * A row written by a deploy this code does not know about is a row whose
 * provenance this code cannot vouch for, and the cost of being wrong is a
 * development identifier printed at a person as somebody's name.
 */
export function originMayBePresented(origin: string): boolean {
  return (PRESENTABLE_ORIGINS as readonly string[]).includes(origin);
}

export type EntityForPresentation = {
  displayName: string;
  origin: string;
  aliases?: readonly string[];
};

export type PresentableEntity = {
  displayName: string;
  aliases: readonly string[];
};

/**
 * The entity's name and labels, IF it may be shown at all — otherwise null.
 *
 * Both gates, in one call, in this order: provenance first, because a `dev`
 * row is refused whatever it is called; then `sanitizeLabel`, which is the
 * same function the outbound family path has always used to decide what may
 * appear in a message.
 */
export function presentableEntity(
  entity: EntityForPresentation | null | undefined,
): PresentableEntity | null {
  if (entity === null || entity === undefined) return null;
  if (!originMayBePresented(entity.origin)) return null;

  const displayName = sanitizeLabel(entity.displayName);
  if (displayName === null) return null;

  return {
    displayName,
    aliases: (entity.aliases ?? [])
      .map(sanitizeLabel)
      .filter((alias): alias is string => alias !== null),
  };
}

/** Just the name, for the many callers that need nothing else. */
export function presentableName(
  entity: EntityForPresentation | null | undefined,
): string | null {
  return presentableEntity(entity)?.displayName ?? null;
}

/**
 * Drop everything a person may not see.
 *
 * Applied AFTER the repository has already filtered `dev` out in SQL. Both,
 * deliberately: the query is what makes a presentation path unable to hold a
 * dev row at all, and this is what holds when a caller reaches for the
 * unfiltered read — which is allowed, and necessary, for entity resolution.
 */
export function filterPresentable<T extends EntityForPresentation>(
  entities: readonly T[],
): T[] {
  return entities.filter((entity) => originMayBePresented(entity.origin));
}
