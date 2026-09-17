/**
 * The opening line for the canonical demo. DEVELOPMENT ONLY.
 *
 * Deliberately a SERVER component with no "use client": a client component is
 * bundled whether or not anything renders it, so the fixture's cast would ship
 * to every production browser as dead code. Rendered on the server and gated
 * by the page, it is absent from the bundle entirely - which a build-output
 * scan in the verification step checks rather than assumes.
 */
export function DemoHint() {
  return (
    <p className="pt-3 text-[1rem] text-[var(--color-muted)]">
      Try saying: &ldquo;I haven&rsquo;t seen John this week.&rdquo;
    </p>
  );
}
