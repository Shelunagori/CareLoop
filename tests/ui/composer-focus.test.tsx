import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { Chat } from "@/app/_components/chat";

/**
 * Who owns the focus ring.
 *
 * The composer is one shell with a borderless textarea inside it, so exactly
 * one of them may show focus. Live acceptance found both did: a 3px accent
 * outline on the textarea INSIDE a ringed shell, which reads as broken.
 *
 * The cause is a cascade detail that is easy to get wrong twice. The global
 * focus ring in globals.css is UNLAYERED, and Tailwind's utilities live in
 * @layer utilities, so an unlayered rule beats `outline-none` no matter how
 * specific the utility looks. A utility on the textarea therefore cannot win;
 * the suppression has to be an unlayered rule too. These tests hold that
 * arrangement in place, because the next person to add `outline-none` and see
 * it silently do nothing will be told why.
 */
const CSS = readFileSync("app/globals.css", "utf8");
const CHAT = readFileSync("app/_components/chat.tsx", "utf8");

function classes(el: Element): string[] {
  return el.className.split(/\s+/).filter(Boolean);
}

function renderComposer() {
  vi.stubGlobal("MediaRecorder", class {});
  vi.stubGlobal("navigator", {
    mediaDevices: { getUserMedia: async () => ({ getTracks: () => [] }) },
  });
  render(<Chat initialConversationId="c" initialMessages={[]} />);
  const textarea = screen.getByLabelText(/write a message/i);
  const shell = textarea.closest("[data-composer]");
  if (!shell) throw new Error("no composer shell");
  return { textarea, shell: shell as HTMLElement };
}

describe("the composer shows focus exactly once", () => {
  it("the textarea draws no box of its own", () => {
    const { textarea } = renderComposer();

    // Nothing that paints an edge: no border, no ring, no shadow. The shell
    // is the only thing with a rectangle.
    for (const klass of classes(textarea)) {
      expect(klass, `textarea class: ${klass}`).not.toMatch(
        /^(border|ring|shadow|outline)(-|$)/,
      );
    }
  });

  it("the textarea does not try to win the cascade with a utility", () => {
    const { textarea } = renderComposer();

    // `outline-none` here would be a lie: it is layered, the global rule is
    // not, and the global rule wins. If it reappears, someone has "fixed"
    // this in a way that does nothing.
    expect(classes(textarea)).not.toContain("outline-none");
  });

  it("globals.css hands the composer textarea's focus to the shell", () => {
    // One unlayered rule, scoped to the composer, targeting the textarea.
    const rule = CSS.match(
      /\[data-composer\]\s+textarea:focus-visible\s*\{[^}]*\}/,
    );
    expect(rule, "no [data-composer] textarea:focus-visible rule").not.toBeNull();
    expect(rule![0]).toMatch(/outline:\s*none/);

    // It must not be inside @layer — that would put it back under Tailwind's
    // utilities and reintroduce the bug it exists to fix.
    const before = CSS.slice(0, CSS.indexOf(rule![0]));
    const opened = (before.match(/@layer[^;{]*\{/g) ?? []).length;
    const closedBraces = before.split("}").length - 1;
    const openedBraces = before.split("{").length - 1;
    expect(opened === 0 || openedBraces === closedBraces, "rule sits inside a @layer").toBe(true);
  });

  it("the shell is what lights up, in the app's own focus style", () => {
    const { shell } = renderComposer();
    const focus = classes(shell).filter((c) => c.startsWith("has-[textarea:focus-visible]:"));

    // A ring around the whole composer, matching the 3px accent outline every
    // other focusable thing in CareLoop gets.
    expect(focus.length).toBeGreaterThan(0);
    expect(focus.join(" ")).toMatch(/outline/);
  });

  it("the buttons keep their own focus ring", () => {
    const { shell } = renderComposer();

    // The global rule still covers buttons...
    const global = CSS.match(/:where\([^)]*\):focus-visible\s*\{[^}]*\}/);
    expect(global, "no global focus-visible rule").not.toBeNull();
    expect(global![0]).toMatch(/\bbutton\b/);
    expect(global![0]).toMatch(/outline:\s*\d+px/);

    // ...and nothing suppresses it for the controls inside the composer.
    expect(CSS).not.toMatch(/\[data-composer\][^{]*button[^{]*\{[^}]*outline:\s*none/);
    for (const button of shell.querySelectorAll("button")) {
      expect(classes(button)).not.toContain("outline-none");
    }
  });

  it("the recording border is a state, not a focus ring", () => {
    // Recording turns the shell's BORDER accent; focus adds an OUTLINE. They
    // are different properties on purpose, so a recording composer that also
    // has focus shows both without one overwriting the other.
    expect(CHAT).toMatch(/voice === "recording"[\s\S]{0,120}border-\[var\(--color-accent\)\]/);
  });
});
