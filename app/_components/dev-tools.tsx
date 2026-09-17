"use client";

import { useState, useTransition } from "react";
import { Button } from "./ui";

/**
 * The demo reset control. DEVELOPMENT ONLY.
 *
 * The secret never reaches the browser. This calls a server action, which runs
 * the same four-condition gate as every other development surface and then
 * invokes the demo service in process - so there is no callable reset endpoint
 * and nothing to find in the client bundle. In production the parent does not
 * render this at all, and the action itself still refuses.
 */
export function DemoResetButton({ action }: { action: () => Promise<{ ok: boolean }> }) {
  const [pending, startTransition] = useTransition();
  const [failed, setFailed] = useState(false);

  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        type="button"
        variant="secondary"
        pending={pending}
        pendingLabel="Resetting…"
        onClick={() =>
          startTransition(async () => {
            setFailed(false);
            const result = await action();
            if (!result.ok) {
              setFailed(true);
              return;
            }
            // A full reload, so the page picks up the fresh blank conversation
            // and the reseeded fixture the same way a cold visit would.
            window.location.reload();
          })
        }
      >
        Reset demo
      </Button>
      <span className="text-[0.8rem] text-[var(--color-muted)]">
        {failed ? "Reset failed — check the server log." : "development only"}
      </span>
    </div>
  );
}

