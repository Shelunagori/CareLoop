import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

/**
 * The family surface, state by state.
 *
 * An async server component is an async function returning JSX, so it can be
 * awaited and rendered directly. The service beneath it is mocked at its own
 * boundary — what is under test is which state the page shows, not the token
 * semantics, which have their own tests against a real Postgres.
 */
const loadFamilyView = vi.fn();

vi.mock("@/server/services/family-response", () => ({
  loadFamilyView: (...args: unknown[]) => loadFamilyView(...args),
}));
vi.mock("@/server/services/deps", () => ({
  createFamilyResponseDeps: () => ({}),
}));
const notFound = vi.fn(() => {
  throw new Error("NEXT_NOT_FOUND");
});
vi.mock("next/navigation", () => ({ notFound: () => notFound() }));

const { default: FamilyRespondPage } = await import("@/app/family/respond/[token]/page");

const MESSAGE = "Dad was wondering — are you and Simba able to visit soon?";

const OK = {
  outcome: "ok" as const,
  requestId: "req-1",
  message: MESSAGE,
  fromDisplayName: "Dad",
  topic: "visit" as const,
  alreadyAnswered: false,
  choices: [
    { id: "yes_weekend", label: "Yes, we're visiting this weekend.", intent: "yes" as const },
    { id: "yes_soon", label: "Yes, we'll visit soon.", intent: "yes" as const },
    { id: "unsure", label: "Not sure yet.", intent: "unsure" as const },
    { id: "no", label: "No, not this weekend.", intent: "no" as const },
  ],
};

async function renderPage(
  view: unknown,
  query: { answered?: string; error?: string } = {},
) {
  loadFamilyView.mockResolvedValueOnce(view);
  const element = await FamilyRespondPage({
    params: Promise.resolve({ token: "tok-123" }),
    searchParams: Promise.resolve(query),
  });
  return render(element);
}

describe("1. a live request", () => {
  it("shows who it is from and the exact approved message", async () => {
    await renderPage(OK);
    expect(screen.getByText("Dad")).toBeTruthy();
    // Byte-for-byte. The page renders it; it does not compose it.
    expect(screen.getByText(MESSAGE)).toBeTruthy();
  });

  it("asks the question the approved topic actually supports", async () => {
    await renderPage(OK);
    expect(screen.getByText("Can you visit?")).toBeTruthy();

    await renderPage({ ...OK, topic: "call" });
    expect(screen.getByText("Can you call?")).toBeTruthy();
  });

  it("offers only the choices the backend supplied", async () => {
    await renderPage(OK);
    const form = screen.getByRole("group");
    const buttons = within(form).getAllByRole("button");
    expect(buttons.map((b) => b.textContent)).toEqual(OK.choices.map((c) => c.label));
    // Each submits its own id, so the server validates against its own list.
    expect(buttons.map((b) => (b as HTMLButtonElement).value)).toEqual(
      OK.choices.map((c) => c.id),
    );
  });

  it("shows nothing about the older adult beyond the one sentence", async () => {
    const { container } = await renderPage(OK);
    const text = container.textContent ?? "";
    for (const leak of ["tok-123", "req-1", "hash", "conversation", "baseline"]) {
      expect(text.toLowerCase(), leak).not.toContain(leak.toLowerCase());
    }
  });
});

describe("2. the states that are not a live request", () => {
  it("an already-answered token gets a friendly completed state, not an error", async () => {
    await renderPage({ ...OK, alreadyAnswered: true });
    expect(screen.getByText(/your reply has been sent/i)).toBeTruthy();
    // And no way to answer a second time.
    expect(screen.queryByRole("group")).toBeNull();
  });

  it("a just-submitted reply shows the same completed state", async () => {
    await renderPage(OK, { answered: "1" });
    expect(screen.getByText(/your reply has been sent/i)).toBeTruthy();
    expect(screen.queryByRole("group")).toBeNull();
  });

  it("an expired token says so plainly", async () => {
    await renderPage({ outcome: "expired" });
    expect(screen.getByText("This reply link has expired.")).toBeTruthy();
    expect(screen.queryByRole("group")).toBeNull();
  });

  it("an unknown token is a 404 — it never reveals whether a request exists", async () => {
    loadFamilyView.mockResolvedValueOnce({ outcome: "not_found" });
    await expect(
      FamilyRespondPage({
        params: Promise.resolve({ token: "whatever" }),
        searchParams: Promise.resolve({}),
      }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
    expect(notFound).toHaveBeenCalled();
  });

  it("a failed submission is explained without technical detail", async () => {
    await renderPage(OK, { error: "1" });
    const alert = screen.getByRole("alert");
    // The typographic apostrophe is what the page renders; matching the ASCII
    // one would pass only by accident.
    expect(alert.textContent).toMatch(/couldn\u2019t be saved/);
    expect(alert.textContent).not.toMatch(/token|hash|sql|error_/i);
    // The choices are still there to try again.
    expect(screen.getByRole("group")).toBeTruthy();
  });
});

describe("3. submission is a plain form post", () => {
  it("posts to the token's own endpoint, so a refresh cannot resubmit", async () => {
    await renderPage(OK);
    const form = screen.getByRole("group").closest("form")!;
    expect(form.getAttribute("method")).toBe("post");
    expect(form.getAttribute("action")).toBe("/api/family/respond/tok-123");
    // No client-side state to double-submit: the route answers 303 and the
    // database function is idempotent behind UNIQUE(request_id).
  });
});
