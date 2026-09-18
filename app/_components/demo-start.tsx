"use client";

import { useState, useTransition } from "react";
import { Button } from "./ui";

/**
 * The public demo's front door.
 *
 * A BUTTON, not a page load. Creating the account on render would mean a bot,
 * a link preview, a prefetch or a plain refresh each minting a Supabase user —
 * and anonymous sign-in is rate-limited per IP, so one crawler could lock out
 * everyone behind it. The click is the consent and the rate limiter.
 *
 * It carries no configuration of its own: whether a demo exists at all is a
 * server decision, and this component is simply not rendered otherwise.
 */
export function StartDemo({ action }: { action: () => Promise<{ ok: boolean; reason?: string }> }) {
  const [pending, startTransition] = useTransition();
  const [failed, setFailed] = useState(false);

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center px-6">
      <h1 className="text-[1.7rem] font-semibold tracking-tight">CareLoop</h1>
      <p className="pt-1 text-[1rem] text-[var(--color-muted)]">
        Stay connected with the people who matter.
      </p>

      <div className="pt-7">
        <Button
          type="button"
          pending={pending}
          pendingLabel="Starting…"
          onClick={() =>
            startTransition(async () => {
              setFailed(false);
              // A successful start redirects server-side, so nothing after
              // this runs. Only a refusal comes back here — and it does not
              // retry, because a retry loop would leave abandoned accounts
              // behind.
              const result = await action();
              if (!result.ok) setFailed(true);
            })
          }
        >
          Start CareLoop demo
        </Button>

        <p className="pt-3 text-[0.95rem] text-[var(--color-muted)]">
          This creates a temporary demo session. No account or email is required.
        </p>

        {failed && (
          <p role="alert" className="pt-3 text-[0.95rem] text-[#8a2f2f]">
            Sorry, the demo could not be started just now. Please try again in a moment.
          </p>
        )}
      </div>
    </main>
  );
}

/**
 * Restart, for a reviewer who has finished the loop and wants to run it again.
 *
 * Distinct from the local developer's Reset demo in wording and in
 * authorization: this one is server-checked against the caller's own anonymous
 * session and can only ever restore their own world. It is not a development
 * affordance and does not say "development only".
 */
export function DemoRestartButton({
  action,
}: {
  action: () => Promise<{ ok: boolean; reason?: string }>;
}) {
  const [pending, startTransition] = useTransition();
  const [failed, setFailed] = useState(false);

  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        type="button"
        variant="secondary"
        pending={pending}
        pendingLabel="Restarting…"
        onClick={() =>
          startTransition(async () => {
            setFailed(false);
            const result = await action();
            if (!result.ok) {
              setFailed(true);
              return;
            }
            window.location.reload();
          })
        }
      >
        Restart demo
      </Button>
      <span className="text-[0.8rem] text-[var(--color-muted)]">
        {failed ? "Couldn't restart just now." : "starts this demo over"}
      </span>
    </div>
  );
}
