import { describe, expect, it } from "vitest";
import {
  NORA_AVAILABLE_UNTIL_DEFAULT,
  readNoraCutoff,
  noraConfigured,
} from "@/core/nora/config";
import { evaluateNoraAvailability } from "@/core/nora/availability";

/**
 * When Nora may exist.
 *
 * Picovoice access for this project ends on 25 September 2026. After that the
 * wake word must not merely be hidden — it must not initialize, must not hold
 * a microphone, and must not be the reason anything else stops working. The
 * product state after the cutoff is not "an error": it is CareLoop back to
 * push-to-talk, which was always the shipped interaction.
 *
 * Every rule about that lives in one pure function, decided from a clock and
 * a configuration value. The browser is told the answer; it never computes it.
 */
const UNTIL = "2026-09-25T23:59:59.999Z";
const at = (iso: string) => new Date(iso);

const configured = { accessKeyPresent: true, keywordPresent: true };

describe("1. one authoritative date, in UTC", () => {
  it("the default cutoff is the end of 25 September 2026, UTC", () => {
    expect(NORA_AVAILABLE_UNTIL_DEFAULT).toBe(UNTIL);
  });

  it("is overridable by configuration, so the boundary is testable", () => {
    expect(readNoraCutoff({ NORA_AVAILABLE_UNTIL: "2026-01-01T00:00:00.000Z" })).toBe(
      "2026-01-01T00:00:00.000Z",
    );
  });

  it("falls back to the default rather than trusting an unparseable value", () => {
    for (const bad of ["", "soon", "2026-13-45", "next tuesday"]) {
      expect(readNoraCutoff({ NORA_AVAILABLE_UNTIL: bad })).toBe(UNTIL);
    }
    expect(readNoraCutoff({})).toBe(UNTIL);
  });

  it("normalises whatever it is given to an ISO instant", () => {
    // A date-only value is a UTC midnight, not a local one — the same rule
    // core/baseline/day.ts already applies to every other date in CareLoop.
    expect(readNoraCutoff({ NORA_AVAILABLE_UNTIL: "2026-09-25" })).toBe(
      "2026-09-25T00:00:00.000Z",
    );
  });
});

describe("2. the boundary is inclusive, and stated", () => {
  it("is available a millisecond before the cutoff", () => {
    const result = evaluateNoraAvailability({
      now: at("2026-09-25T23:59:59.998Z"),
      availableUntil: UNTIL,
      ...configured,
    });
    expect(result).toEqual({ available: true, availableUntil: UNTIL });
  });

  it("is available AT the cutoff instant — `now <= availableUntil`", () => {
    expect(
      evaluateNoraAvailability({ now: at(UNTIL), availableUntil: UNTIL, ...configured }).available,
    ).toBe(true);
  });

  it("is expired a millisecond after", () => {
    expect(
      evaluateNoraAvailability({
        now: at("2026-09-26T00:00:00.000Z"),
        availableUntil: UNTIL,
        ...configured,
      }),
    ).toEqual({ available: false, reason: "expired", availableUntil: UNTIL });
  });
});

describe("3. expiry outranks every other reason", () => {
  /**
   * Precedence matters because the reason is shown to a person. After the
   * cutoff the honest sentence is "no longer available" whatever else is also
   * true; telling someone to check their microphone for a feature that has
   * ended would send them to fix something that is not broken.
   */
  it("says expired even when nothing is configured either", () => {
    expect(
      evaluateNoraAvailability({
        now: at("2026-10-01T00:00:00.000Z"),
        availableUntil: UNTIL,
        accessKeyPresent: false,
        keywordPresent: false,
      }).available,
    ).toBe(false);
    expect(
      evaluateNoraAvailability({
        now: at("2026-10-01T00:00:00.000Z"),
        availableUntil: UNTIL,
        accessKeyPresent: false,
        keywordPresent: false,
      }),
    ).toEqual({ available: false, reason: "expired", availableUntil: UNTIL });
  });
});

describe("4. unconfigured is a state, not a failure", () => {
  it.each([
    [{ accessKeyPresent: false, keywordPresent: true }],
    [{ accessKeyPresent: true, keywordPresent: false }],
    [{ accessKeyPresent: false, keywordPresent: false }],
  ])("reports not_configured for %j", (flags) => {
    expect(
      evaluateNoraAvailability({ now: at("2026-09-21T00:00:00.000Z"), availableUntil: UNTIL, ...flags }),
    ).toEqual({ available: false, reason: "not_configured", availableUntil: UNTIL });
  });

  it("an unparseable cutoff is treated as expired, never as available", () => {
    // Fail closed. A deployment that cannot say when access ends does not get
    // to keep a microphone listener alive on the strength of it.
    expect(
      evaluateNoraAvailability({
        now: at("2026-09-21T00:00:00.000Z"),
        availableUntil: "not a date",
        ...configured,
      }).available,
    ).toBe(false);
  });
});

describe("5. configuration is presence, never a value", () => {
  it("reports whether the access key is present without reading it", () => {
    expect(noraConfigured({ NEXT_PUBLIC_PICOVOICE_ACCESS_KEY: "abc123" }).accessKeyPresent).toBe(true);
    expect(noraConfigured({ NEXT_PUBLIC_PICOVOICE_ACCESS_KEY: "  " }).accessKeyPresent).toBe(false);
    expect(noraConfigured({}).accessKeyPresent).toBe(false);
  });

  it("reports whether a keyword model has been declared", () => {
    expect(noraConfigured({ NEXT_PUBLIC_NORA_KEYWORD_PATH: "/nora/Nora.ppn" }).keywordPresent).toBe(true);
    expect(noraConfigured({ NEXT_PUBLIC_NORA_KEYWORD_PATH: "" }).keywordPresent).toBe(false);
    expect(noraConfigured({}).keywordPresent).toBe(false);
  });

  it("returns nothing but booleans, so no caller can leak a secret through it", () => {
    const result = noraConfigured({
      NEXT_PUBLIC_PICOVOICE_ACCESS_KEY: "super-secret",
      NEXT_PUBLIC_NORA_KEYWORD_PATH: "/nora/Nora.ppn",
    });
    expect(Object.values(result).every((v) => typeof v === "boolean")).toBe(true);
    expect(JSON.stringify(result)).not.toContain("super-secret");
  });
});
