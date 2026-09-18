"use client";

import { useEffect, useRef, useState, useTransition } from "react";
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
/** After this long, silence stops being reassuring. */
const STILL_WORKING_MS = 10_000;

export function StartDemo({ action }: { action: () => Promise<{ ok: boolean; reason?: string }> }) {
  /**
   * `starting` is deliberately NOT `useTransition`'s pending flag.
   *
   * A transition's pending state is set asynchronously, so three fast clicks
   * can all pass the check before React has re-rendered once - and each one
   * would be an anonymous Auth user, against a per-IP sign-in limit. A ref
   * that is set synchronously inside the handler is the guard; the state is
   * only what the interface draws.
   *
   * On SUCCESS it stays set. The server redirects, so nothing after the call
   * runs and the navigation is already on its way; returning the button to
   * "Start" during that would invite a press that creates a second account.
   */
  const inFlight = useRef(false);
  const [starting, setStarting] = useState(false);
  const [slow, setSlow] = useState(false);
  const [failed, setFailed] = useState(false);

  // Cleared whenever the request settles, so a fast start never shows it.
  useEffect(() => {
    if (!starting) return;
    const timer = setTimeout(() => setSlow(true), STILL_WORKING_MS);
    return () => clearTimeout(timer);
  }, [starting]);

  const begin = () => {
    // Synchronous, before any await: this is the double-click guard.
    if (inFlight.current) return;
    inFlight.current = true;
    setFailed(false);
    setSlow(false);
    setStarting(true);

    void (async () => {
      try {
        const result = await action();
        if (result.ok) return; // A redirect is coming. Stay spent.
        throw new Error(result.reason ?? "failed");
      } catch {
        // ONE attempt. A retry here would leave abandoned Auth users behind,
        // and the reviewer can press again themselves if they want to.
        inFlight.current = false;
        setStarting(false);
        setSlow(false);
        setFailed(true);
      }
    })();
  };

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center px-6">
      <h1 className="text-[1.7rem] font-semibold tracking-tight">CareLoop</h1>
      <p className="pt-1 text-[1rem] text-[var(--color-muted)]">
        Stay connected with the people who matter.
      </p>

      <div className="pt-7">
        {/*
          `pending` is the shared Button's own API: it disables the control and
          sets aria-busy, so the state is announced rather than only greyed.
          Passing aria-busy here instead would be silently discarded.
        */}
        <Button
          type="button"
          onClick={begin}
          pending={starting}
          pendingLabel="Creating your CareLoop session…"
        >
          Start CareLoop demo
        </Button>

        {/*
          One region, three messages, announced politely rather than
          interrupting: the reviewer is watching the button, and a screen
          reader user needs to be told the same thing.
        */}
        <div aria-live="polite" className="pt-3 text-[0.95rem] text-[var(--color-muted)]">
          {starting ? (
            <>
              <p>This may take a few seconds.</p>
              {slow && <p className="pt-1">Still setting things up…</p>}
            </>
          ) : (
            <p>This creates a temporary demo session. No account or email is required.</p>
          )}
        </div>

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

/**
 * Where the reviewer's demo message should be sent.
 *
 * One field, once, before the conversation starts. It is DEMO CONFIGURATION:
 * George never sees it, nothing about it enters his conversation, and the only
 * reason it exists is that a real email transport needs a real inbox. A
 * plain form posting to a server action, so the address is validated where it
 * cannot be bypassed.
 */
export function DemoContactSetup({
  action,
}: {
  action: (formData: FormData) => Promise<{ ok: boolean; reason?: string }>;
}) {
  const [pending, startTransition] = useTransition();
  const [problem, setProblem] = useState<string | null>(null);

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center px-6">
      <h1 className="text-[1.45rem] font-semibold tracking-tight">CareLoop demo setup</h1>
      <p className="pt-3 text-[1rem]">Where should John&rsquo;s demo message be sent?</p>
      <p className="pt-1 text-[0.95rem] text-[var(--color-muted)]">
        Use an email you can open during the demo. It will stand in for John&rsquo;s inbox.
      </p>

      <form
        className="pt-5"
        action={(formData) =>
          startTransition(async () => {
            setProblem(null);
            const result = await action(formData);
            if (!result.ok) {
              setProblem(
                result.reason === "too_long"
                  ? "That address is too long."
                  : "That doesn't look like an email address.",
              );
            }
          })
        }
      >
        <label htmlFor="demo-email" className="sr-only">
          Email address for John&rsquo;s demo messages
        </label>
        <input
          id="demo-email"
          name="email"
          type="email"
          required
          autoComplete="email"
          placeholder="you@example.com"
          className="min-h-[2.75rem] w-full rounded-xl border-2 border-[var(--color-line)] bg-[var(--color-surface)] px-4 text-[1rem] outline-none"
        />
        <div className="pt-4">
          <Button type="submit" pending={pending} pendingLabel="Saving…">
            Continue
          </Button>
        </div>
      </form>

      {problem && (
        <p role="alert" className="pt-3 text-[0.95rem] text-[#8a2f2f]">
          {problem}
        </p>
      )}
    </main>
  );
}
