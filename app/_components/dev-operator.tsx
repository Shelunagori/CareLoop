/**
 * The demo operator's way into the other side of the loop. DEVELOPMENT ONLY.
 *
 * Deliberately a SERVER component with no "use client", for the same reason
 * `DemoHint` is one: a client component is bundled whether or not anything
 * renders it, so a link written into `dev-tools.tsx` shipped the string
 * "Open family inbox" to every production browser as dead code. Gated by the
 * page and rendered on the server, it is absent from the bundle entirely - and
 * a guard below checks the built output rather than assuming it.
 *
 * A plain anchor, not a fetch: a browser navigation cannot carry the dev
 * secret header, and the answer to that is a server-gated page, never a secret
 * somewhere a browser can reach.
 *
 * It sits with the operator controls and says so. George does not have access
 * to his family's inbox; the person running the demo does, and the interface
 * must not blur those two.
 */
export function FamilyInboxLink() {
  return (
    <a
      href="/dev/family-inbox"
      className="inline-flex min-h-[2.75rem] items-center justify-center rounded-xl border-2 border-[var(--color-line)] bg-[var(--color-surface)] px-4 text-[0.95rem] font-medium hover:bg-[var(--color-surface-muted)]"
    >
      Open family inbox
    </a>
  );
}
