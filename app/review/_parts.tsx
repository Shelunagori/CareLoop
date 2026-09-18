import type { ReactNode } from "react";

/**
 * Presentational pieces for the reviewer page, and nothing else.
 *
 * They live beside the page rather than in `app/_components/ui.tsx` because
 * that file is deliberately four components: it serves the product surface
 * that older adults use, and a stage-diagram primitive has no business there.
 * Nothing here is imported by the product.
 */
export function Section({
  id,
  eyebrow,
  title,
  lead,
  children,
}: {
  id: string;
  eyebrow?: string;
  title: string;
  lead?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      id={id}
      aria-labelledby={`${id}-heading`}
      className="scroll-mt-20 border-t border-[var(--color-line)] py-14 sm:py-16"
    >
      {eyebrow ? (
        <p className="text-[0.8rem] font-semibold tracking-[0.12em] text-[var(--color-muted)] uppercase">
          {eyebrow}
        </p>
      ) : null}
      <h2
        id={`${id}-heading`}
        className="mt-2 text-[1.6rem] leading-tight font-semibold sm:text-[1.9rem]"
      >
        {title}
      </h2>
      {lead ? (
        <div className="mt-4 max-w-[60ch] text-[1.02rem] leading-relaxed text-[var(--color-muted)]">
          {lead}
        </div>
      ) : null}
      <div className="mt-8">{children}</div>
    </section>
  );
}

/**
 * Whether a step is decided by a model or by application code.
 *
 * Carries a WORD, not just a colour. The distinction between probabilistic and
 * deterministic is the entire argument of this page, and it would be a poor
 * showing to encode it somewhere a colour-blind reader or a screen reader
 * could not reach.
 */
export type Authority = "model" | "deterministic";

export function AuthorityTag({ kind }: { kind: Authority }) {
  const model = kind === "model";
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[0.8rem] font-semibold tracking-wide uppercase ${
        model
          ? "border-[var(--color-line)] bg-[var(--color-surface-muted)] text-[var(--color-muted)]"
          : "border-[var(--color-accent)] bg-[var(--color-accent-soft)] text-[var(--color-accent)]"
      }`}
    >
      <span aria-hidden="true">{model ? "◇" : "◆"}</span>
      {model ? "Language model" : "Deterministic"}
    </span>
  );
}

/** A monospace pipeline. Wraps rather than scrolls sideways. */
export function Pipeline({ steps }: { steps: readonly string[] }) {
  return (
    <ol className="flex flex-col gap-1.5 font-mono text-[0.85rem] leading-snug text-[var(--color-foreground)]">
      {steps.map((step, index) => (
        <li key={step} className="flex gap-2 break-words">
          <span aria-hidden="true" className="text-[var(--color-muted)]">
            {index === 0 ? "  " : "→"}
          </span>
          <span>{step}</span>
        </li>
      ))}
    </ol>
  );
}

/**
 * One stage of the walkthrough: what the reviewer sees, beside what the
 * application does. Two columns on a wide screen, stacked on a narrow one,
 * and the reading order is the same either way.
 */
export function Stage({
  letter,
  title,
  authority,
  seen,
  behind,
  note,
}: {
  letter: string;
  title: string;
  authority: Authority;
  seen: ReactNode;
  behind: ReactNode;
  note?: ReactNode;
}) {
  return (
    <article className="rounded-2xl border border-[var(--color-line)] bg-[var(--color-surface)] p-5 sm:p-6">
      <header className="flex flex-wrap items-center gap-3">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--color-surface-muted)] text-[0.8rem] font-semibold text-[var(--color-muted)]">
          {letter}
        </span>
        <h3 className="text-[1.15rem] font-semibold">{title}</h3>
        <AuthorityTag kind={authority} />
      </header>

      <div className="mt-5 grid gap-5 md:grid-cols-2 md:gap-8">
        <div>
          <h4 className="text-[0.8rem] font-semibold tracking-wide text-[var(--color-muted)] uppercase">
            What the reviewer sees
          </h4>
          <div className="mt-3 text-[1rem] leading-relaxed">{seen}</div>
        </div>
        <div className="md:border-l md:border-[var(--color-line)] md:pl-8">
          <h4 className="text-[0.8rem] font-semibold tracking-wide text-[var(--color-muted)] uppercase">
            What happens behind the screen
          </h4>
          <div className="mt-3">{behind}</div>
        </div>
      </div>

      {note ? (
        <p className="mt-5 border-t border-[var(--color-line)] pt-4 text-[0.95rem] leading-relaxed text-[var(--color-muted)]">
          {note}
        </p>
      ) : null}
    </article>
  );
}

/** A line the reviewer is meant to read as the companion's own words. */
export function Said({ who, children }: { who: string; children: ReactNode }) {
  return (
    <p className="rounded-xl bg-[var(--color-surface-muted)] px-4 py-3">
      <span className="text-[0.8rem] font-semibold tracking-wide text-[var(--color-muted)] uppercase">
        {who}
      </span>
      <span className="mt-1 block whitespace-pre-wrap">{children}</span>
    </p>
  );
}
