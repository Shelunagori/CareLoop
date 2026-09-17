import type { ButtonHTMLAttributes, ReactNode } from "react";

/**
 * Four small pieces, and deliberately no more.
 *
 * M7 is a presentation milestone, not a design-system one. These exist because
 * the same button and the same card appear in three places and drifting copies
 * of them is how an interface starts to feel unmaintained - not because the
 * project needs component infrastructure.
 */
type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary";
  /** Replaces the label while an action is in flight. */
  pendingLabel?: string;
  pending?: boolean;
  children: ReactNode;
};

/**
 * `min-h-[3rem]` is 54px at the 18px root: comfortably past the 44px target,
 * because these are pressed by people whose aim is not always precise.
 */
export function Button({
  variant = "primary",
  pending = false,
  pendingLabel,
  children,
  className = "",
  disabled,
  ...rest
}: ButtonProps) {
  const base =
    "inline-flex min-h-[3rem] items-center justify-center rounded-xl px-6 py-3 text-[1rem] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50";
  const skin =
    variant === "primary"
      ? "bg-[var(--color-accent)] text-white hover:bg-[#35594a]"
      : "border-2 border-[var(--color-line)] bg-[var(--color-surface)] text-[var(--color-foreground)] hover:bg-[var(--color-surface-muted)]";

  return (
    <button
      {...rest}
      disabled={disabled || pending}
      // Announced, not merely greyed: disabled state must not be colour-only.
      aria-busy={pending || undefined}
      className={`${base} ${skin} ${className}`}
    >
      {pending && pendingLabel ? pendingLabel : children}
    </button>
  );
}

export function Card({
  children,
  className = "",
  ...rest
}: { children: ReactNode; className?: string } & React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      {...rest}
      className={`rounded-2xl border border-[var(--color-line)] bg-[var(--color-surface)] p-5 sm:p-6 ${className}`}
    >
      {children}
    </div>
  );
}

/** The quiet label above a card: "Reconnect with John", "Update from John". */
export function CardLabel({ children }: { children: ReactNode }) {
  return (
    <p className="text-[0.95rem] font-semibold tracking-wide text-[var(--color-muted)] uppercase">
      {children}
    </p>
  );
}

/**
 * Text CareLoop is quoting rather than saying: the exact outbound draft, and
 * the message a family member reads. Visually set apart so it is obvious that
 * these are the words that will travel, not a summary of them.
 */
export function QuotedText({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-xl bg-[var(--color-accent-soft)] px-4 py-4 text-[1.15rem] leading-relaxed whitespace-pre-wrap break-words text-[var(--color-foreground)]">
      {children}
    </p>
  );
}
