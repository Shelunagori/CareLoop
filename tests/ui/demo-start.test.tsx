import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StartDemo } from "@/app/_components/demo-start";

/**
 * The first thing a reviewer touches, and the slowest thing CareLoop does.
 *
 * Starting a demo signs a user in and seeds a whole fixture - tens of
 * sequential round-trips to Supabase - and in production that has been taking
 * twenty seconds or more. A button that looks unpressed for twenty seconds
 * gets pressed again, and every extra press is another anonymous Auth user
 * against a per-IP rate limit.
 *
 * So the loading state is not decoration here: it is the thing that stops a
 * second account being created. These tests hold it in place.
 */
function deferred() {
  let resolve!: (value: { ok: boolean; reason?: string }) => void;
  const promise = new Promise<{ ok: boolean; reason?: string }>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const button = () => screen.getByRole("button", { name: /start|creating/i });

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("1. the press is acknowledged immediately", () => {
  it("shows a working state as soon as it is clicked", async () => {
    const { promise } = deferred();
    const action = vi.fn(() => promise);
    render(<StartDemo action={action} />);

    // Before: the invitation.
    expect(screen.getByText(/no account or email is required/i)).toBeTruthy();

    fireEvent.click(button());

    // After, without waiting for anything: the reviewer knows it heard them.
    await screen.findByText(/creating your careloop session/i);
    expect(screen.getByText(/this may take a few seconds/i)).toBeTruthy();
  });

  it("disables the control while the request is in flight", async () => {
    const { promise, resolve } = deferred();
    render(<StartDemo action={vi.fn(() => promise)} />);

    fireEvent.click(button());
    await waitFor(() => expect((button() as HTMLButtonElement).disabled).toBe(true));
    // Announced, not merely greyed.
    expect(button().getAttribute("aria-busy")).toBe("true");

    await act(async () => {
      resolve({ ok: true });
    });
  });
});

describe("2. a second press cannot create a second account", () => {
  it("clicking three times calls the action once", async () => {
    const { promise, resolve } = deferred();
    const action = vi.fn(() => promise);
    render(<StartDemo action={action} />);

    const control = button();
    fireEvent.click(control);
    fireEvent.click(control);
    fireEvent.click(control);

    expect(action).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolve({ ok: true });
    });
  });

  it("three clicks in ONE tick still call the action once", async () => {
    /**
     * This is the test that matters, and the one I got wrong first.
     *
     * `fireEvent.click` wraps each click in `act()`, which flushes React's
     * state between them - so a guard written as `if (starting) return` passes
     * that test while failing in a real browser, where three fast clicks land
     * before a single re-render. Dispatching them inside one `act()` reproduces
     * the browser: React batches, `starting` is still false for all three, and
     * only a guard set SYNCHRONOUSLY inside the handler holds.
     *
     * Each extra call would be another anonymous Auth user against a per-IP
     * sign-in limit, so this is an abuse guard rather than a polish detail.
     */
    const { promise, resolve } = deferred();
    const action = vi.fn(() => promise);
    render(<StartDemo action={action} />);

    const control = button() as HTMLButtonElement;
    await act(async () => {
      control.click();
      control.click();
      control.click();
    });

    expect(action).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolve({ ok: true });
    });
  });

  it("stays spent after a success, because a redirect is on its way", async () => {
    // On success the server redirects, so nothing after the call runs. The
    // control must not quietly return to "Start" and invite another press
    // during the navigation.
    const action = vi.fn(async () => ({ ok: true }));
    render(<StartDemo action={action} />);

    fireEvent.click(button());
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));

    fireEvent.click(button());
    expect(action).toHaveBeenCalledTimes(1);
    expect((button() as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("3. a slow start says so rather than looking broken", () => {
  it("after ten seconds it admits it is still working", async () => {
    const { promise, resolve } = deferred();
    render(<StartDemo action={vi.fn(() => promise)} />);

    fireEvent.click(button());
    await screen.findByText(/creating your careloop session/i);
    expect(screen.queryByText(/still setting things up/i)).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(9_000);
    });
    expect(screen.queryByText(/still setting things up/i)).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500);
    });
    expect(screen.getByText(/still setting things up/i)).toBeTruthy();

    await act(async () => {
      resolve({ ok: true });
    });
  });

  it("the slow message never appears on a fast start", async () => {
    const action = vi.fn(async () => ({ ok: false, reason: "demo_disabled" }));
    render(<StartDemo action={action} />);

    fireEvent.click(button());
    await screen.findByRole("alert");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    // The timer was cleared when the request settled.
    expect(screen.queryByText(/still setting things up/i)).toBeNull();
  });
});

describe("4. a failure is explained, and the reviewer can try again", () => {
  it("says something useful and re-enables the button", async () => {
    const action = vi.fn(async () => ({ ok: false, reason: "sign_in_failed" }));
    render(<StartDemo action={action} />);

    fireEvent.click(button());

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/could not|couldn't/i);
    // No internal reason code, no provider error, no stack.
    expect(alert.textContent).not.toContain("sign_in_failed");
    expect(alert.textContent).not.toMatch(/supabase|500|undefined/i);

    // One attempt per press, and the reviewer may press again themselves.
    await waitFor(() => expect((button() as HTMLButtonElement).disabled).toBe(false));
    expect(action).toHaveBeenCalledTimes(1);
  });

  it("never retries by itself", async () => {
    const action = vi.fn(async () => ({ ok: false, reason: "sign_in_failed" }));
    render(<StartDemo action={action} />);

    fireEvent.click(button());
    await screen.findByRole("alert");

    // A retry loop here would leave a trail of abandoned Auth users.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(action).toHaveBeenCalledTimes(1);
  });

  it("a thrown action is handled like any other failure", async () => {
    const action = vi.fn(async () => {
      throw new Error("network");
    });
    render(<StartDemo action={action} />);

    fireEvent.click(button());

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/could not|couldn't/i);
    expect(alert.textContent).not.toContain("network");
    await waitFor(() => expect((button() as HTMLButtonElement).disabled).toBe(false));
  });
});
