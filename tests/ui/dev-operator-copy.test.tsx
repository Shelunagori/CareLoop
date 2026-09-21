import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DemoResetButton } from "@/app/_components/dev-tools";
import { DemoResetControl } from "@/app/_components/dev-operator";

/**
 * THE ESCAPE SEQUENCE REACHED THE SCREEN (M12e.3).
 *
 * Clicking Reset demo showed "Resetting…" — the six characters, not an
 * ellipsis. A JSX ATTRIBUTE string is literal text: React does not process
 * backslash escapes in one, so `pendingLabel="Resetting…"` renders
 * exactly what it says. In an expression — `{"…"}`, which is what
 * /debug uses — the escape is real, which is why that file was always
 * correct and this one was not.
 *
 * These render the component rather than reading the source, because the
 * whole failure was the difference between what the source looks like and
 * what the DOM gets.
 */
describe("the operator control's copy reaches the DOM as characters", () => {
  const never = async () => new Promise<{ ok: boolean }>(() => {});

  it("shows a real ellipsis while resetting, and no escape sequence", async () => {
    render(<DemoResetControl action={never} />);
    const button = screen.getByRole("button", { name: /reset demo/i });
    expect(document.body.textContent).toContain("Reset demo");

    fireEvent.click(button);

    await waitFor(() => expect(button.textContent).toContain("Resetting…"));
    expect(button.textContent).toContain("Resetting…");
    expect(document.body.textContent).not.toContain("\\u2026");
    expect(document.body.textContent).not.toMatch(/\\u[0-9a-fA-F]{4}/);
  });

  it("the failure note is characters too", async () => {
    render(<DemoResetButton
      action={async () => ({ ok: false })}
      label="Reset demo"
      pendingLabel="Resetting…"
      note="development only"
      failedNote="Reset failed — check the server log."
    />);
    fireEvent.click(screen.getByRole("button", { name: /reset demo/i }));
    await waitFor(() =>
      expect(screen.getByText(/reset failed/i).textContent).toContain("—"),
    );
    expect(document.body.textContent).not.toMatch(/\\u[0-9a-fA-F]{4}/);
  });

  it("no attribute anywhere in the dev components carries an escape", async () => {
    // The source-level companion: an escape in ATTRIBUTE position is the
    // bug. In expression position it is correct and common, so the check is
    // deliberately narrow rather than banning the sequence outright.
    const fs = await import("node:fs");
    for (const file of [
      "app/_components/dev-operator.tsx",
      "app/_components/dev-tools.tsx",
      "app/dev/page.tsx",
      "app/page.tsx",
    ]) {
      const source = fs
        .readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      expect(source, file).not.toMatch(/=\s*"[^"]*\\u[0-9a-fA-F]{4}/);
    }
  });
});
