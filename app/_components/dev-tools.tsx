"use client";

import { useState, useTransition } from "react";
import { Button } from "./ui";

/**
 * The demo reset MECHANICS. DEVELOPMENT ONLY.
 *
 * NOT A WORD OF DEVELOPMENT COPY LIVES IN THIS FILE, and that is the point
 * (M12e). A client component is bundled whether or not anything renders it,
 * so the literals that used to be here — "Reset demo", "development only",
 * "Resetting…" — shipped to every production browser as dead code, and a
 * scan of the built output found them there. `dev-operator.tsx` had already
 * learned this lesson for the inbox link; this file had not.
 *
 * The parent is a SERVER component and supplies every string as a prop, so
 * the words exist only in a render that a development environment actually
 * performed. The interactivity has to be on the client; the vocabulary does
 * not.
 *
 * The secret never reaches the browser either. This calls a server action,
 * which runs the same four-condition gate as every other development
 * surface and then invokes the demo service in process — so there is no
 * callable reset endpoint. In production the parent does not render this at
 * all, and the action itself still refuses.
 */
export function DemoResetButton({
  action,
  label,
  pendingLabel,
  note,
  failedNote,
}: {
  action: () => Promise<{ ok: boolean }>;
  label: string;
  pendingLabel: string;
  note: string;
  failedNote: string;
}) {
  const [pending, startTransition] = useTransition();
  const [failed, setFailed] = useState(false);

  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        type="button"
        variant="secondary"
        pending={pending}
        pendingLabel={pendingLabel}
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
        {label}
      </Button>
      <span className="text-[0.8rem] text-[var(--color-muted)]">{failed ? failedNote : note}</span>
    </div>
  );
}
