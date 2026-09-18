import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import ReviewPage from "@/app/review/page";

/**
 * The reviewer surface.
 *
 * Two things are worth holding here, and they are not "the copy says what it
 * said on the day". The first is that this page is STATIC: it is the one
 * surface a stranger opens before deciding whether to trust the product, and
 * a page explaining a privacy model must not read a database or create an
 * anonymous user to do it. The second is that nothing operational leaks into
 * a public page.
 */
const page = () => render(<ReviewPage />);

describe("the page renders without a session, a database or a browser API", () => {
  it("renders from a pure call, with no props and no awaits", () => {
    // A server component that needed data would not survive this: it would be
    // a promise, or it would throw looking for a client.
    page();
    expect(screen.getByRole("heading", { level: 1, name: "CareLoop" })).toBeTruthy();
  });

  it("imports nothing that touches application state", () => {
    const source = readFileSync("app/review/page.tsx", "utf8");
    for (const forbidden of [
      "server/services/deps",
      "createServiceRoleClient",
      "getCurrentUserId",
      "@supabase",
      "use client",
      "force-dynamic",
    ]) {
      expect(source, forbidden).not.toContain(forbidden);
    }
  });

  it("depends on no client-only browser API", () => {
    const source =
      readFileSync("app/review/page.tsx", "utf8") + readFileSync("app/review/_parts.tsx", "utf8");
    // Matched as CALLS, not as words: the page's prose legitimately contains
    // "a policy document." and that is not a DOM access.
    for (const api of [
      /\bwindow\.[A-Za-z]/,
      /\bdocument\.[A-Za-z]/,
      /\blocalStorage\b/,
      /\bnavigator\.[A-Za-z]/,
      /\buseEffect\b/,
      /\buseState\b/,
    ]) {
      expect(api.test(source), String(api)).toBe(false);
    }
  });
});

describe("the sections a reviewer is promised", () => {
  it("carries every major heading", () => {
    page();
    for (const heading of [
      /try the flow yourself/i,
      /what happens behind the screen/i,
      /what it is built on/i,
      /language intelligence is not authority/i,
      /what live testing changed/i,
      /privacy and safety/i,
      /one pass through the whole system/i,
      /how the repository is laid out/i,
    ]) {
      expect(screen.getAllByRole("heading", { name: heading }).length).toBeGreaterThan(0);
    }
  });

  it("frames the work as an exploration, not a competitor", () => {
    page();
    expect(screen.getByText(/an engineering exploration inspired by olympia/i)).toBeTruthy();

    // The framing rules out positioning against the product that inspired it.
    const text = document.body.textContent ?? "";
    for (const forbidden of ["competitor", "replaces Olympia", "better than Olympia", "what Olympia is missing"]) {
      expect(text, forbidden).not.toContain(forbidden);
    }
  });

  it("states the governing invariant verbatim", () => {
    page();
    expect(
      screen.getByText("The LLM is a sensor and a renderer; it is never the decision-maker."),
    ).toBeTruthy();
  });

  it("names the demo data as synthetic", () => {
    page();
    expect(screen.getByText(/george, john and simba are synthetic demo data/i)).toBeTruthy();
  });

  it("says the model is not called on a verified closure turn", () => {
    // The whole architectural point of the last two milestones.
    page();
    expect(
      screen.getByText(/conversational model is not\s+invoked at all/i, { exact: false }),
    ).toBeTruthy();
  });
});

describe("the calls to action", () => {
  it("routes the live demo to the existing demo flow", () => {
    page();
    const demo = screen.getByRole("link", { name: /try the live demo/i });
    expect(demo.getAttribute("href")).toBe("/");
    expect(screen.getByRole("link", { name: /start careloop demo/i }).getAttribute("href")).toBe("/");
  });

  it("points at the public repository", () => {
    page();
    for (const name of [/source code/i, /view source code/i]) {
      const link = screen.getAllByRole("link", { name })[0];
      expect(link.getAttribute("href")).toBe("https://github.com/Shelunagori/CareLoop");
    }
  });

  it("every in-page link has a target that exists", () => {
    const { container } = page();
    const anchors = [...container.querySelectorAll('a[href^="#"]')];
    expect(anchors.length).toBeGreaterThan(0);
    for (const anchor of anchors) {
      const id = anchor.getAttribute("href")!.slice(1);
      expect(container.querySelector(`#${id}`), `#${id} has no target`).toBeTruthy();
    }
  });
});

/**
 * Rendered text with element boundaries preserved.
 *
 * `textContent` concatenates adjacent elements with no separator, which
 * manufactures long opaque-looking strings out of ordinary neighbouring
 * words - and a secret scanner that trips on its own artefacts gets muted.
 */
function visibleText(root: HTMLElement): string {
  return [...root.querySelectorAll("*")]
    .flatMap((element) =>
      [...element.childNodes]
        .filter((node) => node.nodeType === 3)
        .map((node) => node.textContent ?? ""),
    )
    .join(" ");
}

describe("nothing operational reaches a public page", () => {
  it("renders no secret, token or credential", () => {
    const { container } = page();
    const text = visibleText(container);

    for (const shape of [
      "sk-",
      "rk-",
      "eyJ",
      "Bearer ",
      "xkeysib",
      "service_role",
      "SERVICE_ROLE",
      "CLOUDFLARE_API_TOKEN",
      "CLOUDFLARE_ACCOUNT_ID",
      "BREVO_API_KEY",
      "ELEVENLABS_API_KEY",
      "SUPABASE_SERVICE_ROLE_KEY",
      "supabase.co",
      "@example.",
    ]) {
      expect(text, shape).not.toContain(shape);
    }

    // No capability link, and no long opaque string that could be one.
    expect(text).not.toContain("/family/respond/");
    const opaque = (text.match(/[A-Za-z0-9_-]{28,}/g) ?? []).filter(
      // The published model ids are the only long slugs on the page.
      (candidate) => !candidate.includes("whisper") && !candidate.includes("instruct"),
    );
    expect(opaque, `unexpected opaque strings: ${opaque.join(", ")}`).toHaveLength(0);
  });

  it("renders no email address", () => {
    const { container } = page();
    // The @cf/... model ids are not addresses; an address needs a dot-suffixed
    // host after the @.
    expect(visibleText(container)).not.toMatch(/[\w.+-]+@[\w-]+\.[a-z]{2,}\b/i);
  });

  it("shows model ids, which are public, and no account identifiers", () => {
    page();
    const models = screen.getByRole("heading", { name: /models in use/i }).parentElement!;
    expect(within(models).getByText("@cf/baai/bge-m3")).toBeTruthy();
    expect(within(models).getByText("@cf/meta/llama-3.3-70b-instruct-fp8-fast")).toBeTruthy();
  });
});

describe("accessibility of the authority distinction", () => {
  it("never carries meaning by colour alone", () => {
    /**
     * The probabilistic/deterministic split is the argument of the page, and a
     * reader who cannot see the shading must still get it.
     *
     * Asserted on the BADGES themselves, not on a count of the word anywhere
     * on the page: the end-to-end diagram also prints "Deterministic", so a
     * count was satisfied by other markup and let an empty badge through.
     */
    const { container } = page();
    const badges = [...container.querySelectorAll("span")].filter((element) => {
      const glyph = element.querySelector('[aria-hidden="true"]');
      return glyph !== null && /[\u25c7\u25c6]/.test(glyph.textContent ?? "");
    });

    expect(badges.length).toBeGreaterThan(5);
    for (const badge of badges) {
      const label = (badge.textContent ?? "").replace(/[\u25c7\u25c6]/g, "").trim();
      expect(label, "a badge carries only a glyph and a colour").toMatch(
        /^(Language model|Deterministic)$/,
      );
    }
  });

  it("has one h1 and an ordered heading structure", () => {
    const { container } = page();
    expect(container.querySelectorAll("h1")).toHaveLength(1);
    expect(container.querySelectorAll("h2").length).toBeGreaterThan(5);
  });

  it("gives every section an accessible name", () => {
    const { container } = page();
    for (const section of container.querySelectorAll("section")) {
      const labelledBy = section.getAttribute("aria-labelledby");
      expect(labelledBy, "a section without an accessible name").toBeTruthy();
      expect(container.querySelector(`#${labelledBy}`)).toBeTruthy();
    }
  });
});
