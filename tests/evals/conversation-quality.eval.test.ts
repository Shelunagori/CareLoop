import { describe, expect, it } from "vitest";
import { SCENARIOS, type GraderName } from "./scenarios";
import { grade, GRADERS } from "./graders";

/**
 * The conversation-quality suite.
 *
 * It runs the graders against two hand-written replies per scenario: one of
 * the shape the product should produce, and one of the shape it must not —
 * in most cases an actual failure observed in a browser.
 *
 * THAT TWO-SIDED SHAPE IS THE POINT. A grader that only ever rejects is
 * indistinguishable from a grader that rejects everything, and a suite of
 * those would go green while the companion said nothing at all. Every
 * grader here has to accept good output as well.
 *
 * WHAT THIS SUITE DOES NOT DO. It does not call a model. The fixtures are
 * the specification of what good and bad look like; whether the live model
 * produces the good shape is a browser question, answered in
 * `docs/09-nora-acceptance.md`. A model-graded warmth score is deliberately
 * absent — it would need a second provider, and a probabilistic check on a
 * probabilistic output is not a check.
 */
describe("1. the suite is real", () => {
  it("has scenarios, and every one declares what it is for", () => {
    expect(SCENARIOS.length).toBeGreaterThanOrEqual(14);
    for (const scenario of SCENARIOS) {
      expect(scenario.intent.length, scenario.id).toBeGreaterThan(20);
      expect(scenario.graders.length, scenario.id).toBeGreaterThan(0);
    }
  });

  it("every scenario id is unique", () => {
    const ids = SCENARIOS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every grader is exercised by at least one scenario", () => {
    // A grader nothing uses is a grader nobody maintains.
    const used = new Set(SCENARIOS.flatMap((s) => s.graders));
    for (const name of Object.keys(GRADERS) as GraderName[]) {
      expect(used.has(name), `${name} is never used`).toBe(true);
    }
  });

  it("covers every quality dimension the milestone named", () => {
    const kinds = new Set(SCENARIOS.map((s) => s.kind));
    for (const required of [
      "warmth", "memory_use", "memory_restraint", "no_fabricated_reply",
      "no_outreach_suggestion", "no_internal_identifier", "explicit_absence",
      "cadence_pacing", "identity_when_asked", "no_repetitive_disclaimer",
      "ambiguity", "unconfirmed_memory", "proactive_opening",
    ] as const) {
      expect(kinds.has(required), required).toBe(true);
    }
  });
});

describe("2. the good shape passes", () => {
  it.each(SCENARIOS.map((s) => [s.id, s] as const))("%s", (_id, scenario) => {
    const failures = grade(scenario.acceptableReply, scenario).filter((r) => !r.pass);
    expect(
      failures.map((f) => (f.pass ? "" : f.why)),
      `${scenario.id}: the acceptable reply was rejected`,
    ).toEqual([]);
  });
});

describe("3. the observed failure is caught", () => {
  it.each(SCENARIOS.map((s) => [s.id, s] as const))("%s", (_id, scenario) => {
    const failures = grade(scenario.unacceptableReply, scenario).filter((r) => !r.pass);
    expect(
      failures.length,
      `${scenario.id}: nothing objected to "${scenario.unacceptableReply}"`,
    ).toBeGreaterThan(0);
  });
});

describe("4. the graders delegate to the shipped rules", () => {
  it("outreach uses the production guard, not a copy", async () => {
    const source = await import("node:fs").then((fs) =>
      fs.readFileSync("tests/evals/graders.ts", "utf8"),
    );
    expect(source).toContain('from "@/core/safety/outreach-guard"');
    expect(source).toContain('from "@/core/safety/deny-list"');
    expect(source).toContain('from "@/core/share/minimize"');
  });

  it("and no grader asks a model anything", async () => {
    const fs = await import("node:fs");
    // Checked as CODE shapes, not as words: the prose in these files
    // discusses model grading at length, and a substring check would be
    // testing the comments rather than the graders.
    const forbidden: ReadonlyArray<[RegExp, string]> = [
      [/\bfetch\s*\(/, "a network call"],
      [/\bstreamChat\b/, "the chat provider"],
      [/\.embed\s*\(/, "the embedding provider"],
      [/from\s+"@\/server\/adapters/, "a provider adapter"],
      [/from\s+"openai"/, "the OpenAI client"],
    ];
    for (const file of ["tests/evals/graders.ts", "tests/evals/scenarios.ts"]) {
      const source = fs.readFileSync(file, "utf8");
      for (const [pattern, what] of forbidden) {
        expect(source, `${file} reaches for ${what}`).not.toMatch(pattern);
      }
    }
  });
});

describe("5. hard invariants stay deterministic even here", () => {
  it("no scenario's acceptable reply would fail a production guard", async () => {
    const { offersOutreach } = await import("@/core/safety/outreach-guard");
    const { findDeniedTerm } = await import("@/core/safety/deny-list");
    for (const scenario of SCENARIOS) {
      expect(offersOutreach(scenario.acceptableReply), scenario.id).toBe(false);
      expect(findDeniedTerm(scenario.acceptableReply), scenario.id).toBeNull();
    }
  });
});
