import "server-only";
import { readDevInbox, type DevInboxEntry } from "@/server/adapters/notifier";

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
