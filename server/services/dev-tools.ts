import "server-only";
import { clearDevInbox, readDevInbox, type DevInboxEntry } from "@/server/adapters/notifier";

/**
 * Development-only read of the dev notifier's inbox.
 *
 * A one-line pass-through, and deliberately so: the architectural boundary
 * says app/ goes through server/services and never straight to an adapter
 * (docs/01 section 1.2). A dev route is not an exception to that - it is
 * exactly the kind of place a boundary quietly rots, because "it's only for
 * local use" is how an adapter import ends up in a production page.
 */
export type { DevInboxEntry };

export function readNotifierInbox(): DevInboxEntry[] {
  return readDevInbox();
}

/**
 * Empties the development notifier's outbox.
 *
 * Part of the DEVELOPMENT reset, and nothing more: the inbox is an in-process
 * Map, so this deletes no row, no delivery record and no family request. The
 * reason it has to happen at all is that a capability link from the previous
 * run would otherwise still be sitting there when the next demo starts -
 * pointing at an opportunity that has just been reset out of existence.
 */
export function clearNotifierInbox(): void {
  clearDevInbox();
}
