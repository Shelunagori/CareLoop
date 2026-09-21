import { DemoResetButton } from "./dev-tools";

/**
 * The demo operator's way into the other side of the loop. DEVELOPMENT ONLY.
 *
 * Deliberately a SERVER component with no "use client", for the same reason
 * `DemoHint` is one: a client component is bundled whether or not anything
 * renders it, so a link written into `dev-tools.tsx` shipped the string
 * "Family inbox (dev)" to every production browser as dead code. Gated by the
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
 *
 * THE LABEL CARRIES "(dev)" (M12e). It is the REAL path — locally the
 * development notifier is the transport, and this page shows the actual
 * approved bytes and the actual capability link that was issued, not a
 * mock-up of them. But on a recording it sat next to product controls with a
 * product-shaped name, and a reviewer had no way to tell an operator tool
 * from a feature. The marker is the whole fix; nothing was rewired, because
 * nothing was fake.
 */
export function FamilyInboxLink() {
  return (
    <a
      href="/dev/family-inbox"
      className="inline-flex min-h-[2.75rem] items-center justify-center rounded-xl border-2 border-[var(--color-line)] bg-[var(--color-surface)] px-4 text-[0.95rem] font-medium hover:bg-[var(--color-surface-muted)]"
    >
      Family inbox (dev)
    </a>
  );
}

/**
 * The operator's controls, wording included. DEVELOPMENT ONLY.
 *
 * A SERVER component, for the same reason `FamilyInboxLink` is one: the
 * strings below are development copy, and a string that lives in a client
 * module is shipped to production whether or not it renders. Passing them
 * down as props keeps the interactivity on the client and the vocabulary
 * here, where the page's `isDev` gate can keep it out of a reviewer's
 * browser entirely. `tests/unit/production-ui.test.ts` scans the built
 * bundle rather than trusting this paragraph.
 */
export function DemoResetControl({ action }: { action: () => Promise<{ ok: boolean }> }) {
  return (
    <DemoResetButton
      action={action}
      label="Reset demo"
      // The CHARACTERS, not escapes. A JSX attribute string is literal
      // text: React does not process backslash escapes in one, so
      // `pendingLabel="Resetting\u2026"` put those six characters on the
      // button. In an expression — {"\u2026"}, as /debug uses — the escape
      // is real, which is why that file is correct and this one was not.
      pendingLabel="Resetting…"
      note="development only"
      failedNote="Reset failed — check the server log."
    />
  );
}
