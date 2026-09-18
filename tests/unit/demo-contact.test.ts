import { describe, expect, it } from "vitest";
import { readDemoEmail } from "@/core/family/demo-email";
import { fixtureUuid } from "@/server/services/demo-fixture";
import { DEMO_GEORGE } from "@/fixtures/demo/george";

/**
 * Where John's demo message is sent, and who John is.
 *
 * Two rules, both easy to get wrong in ways nothing notices until a reviewer's
 * message goes to a stranger.
 *
 * The address is validated on the SERVER from a form field, so it is untrusted
 * input: trimmed, length-capped, and rejected rather than repaired.
 *
 * The recipient is resolved by the fixture's DERIVED identity, never by
 * display name. Names are labels people reuse - an earlier version of this
 * codebase adopted a user's real contact because it happened to be called
 * "John", and then deleted it on reset.
 */
describe("1. the email a reviewer types", () => {
  it("accepts an ordinary address, trimmed", () => {
    expect(readDemoEmail("  john@example.test  ")).toEqual({
      ok: true,
      email: "john@example.test",
    });
  });

  it("keeps the address as typed apart from surrounding space", () => {
    // No lowercasing: the local part of an address is case-sensitive per RFC,
    // and "repairing" somebody's address is how mail goes missing.
    expect(readDemoEmail("John.Smith+careloop@Example.test")).toEqual({
      ok: true,
      email: "John.Smith+careloop@Example.test",
    });
  });

  it("refuses what is not an address, without guessing", () => {
    for (const bad of [
      "",
      "   ",
      "john",
      "john@",
      "@example.test",
      "john@example",
      "john example@test.com",
      "john@@example.test",
      "john@example.test, someone@else.test",
      "<john@example.test>",
      "john@exa mple.test",
    ]) {
      expect(readDemoEmail(bad), JSON.stringify(bad)).toEqual({ ok: false, reason: "invalid" });
    }
  });

  it("refuses an absurd length rather than handing it to a provider", () => {
    const long = `${"a".repeat(300)}@example.test`;
    expect(readDemoEmail(long)).toEqual({ ok: false, reason: "too_long" });
    // And a reasonable one is still fine.
    expect(readDemoEmail(`${"a".repeat(60)}@example.test`).ok).toBe(true);
  });

  it("refuses a newline, which is how a header is injected", () => {
    for (const bad of ["john@example.test\nBcc: x@y.test", "john@example.test\r\nX: y"]) {
      expect(readDemoEmail(bad), JSON.stringify(bad)).toEqual({ ok: false, reason: "invalid" });
    }
  });
});

describe("2. John is an id, never a name", () => {
  it("the recipient is the fixture's derived entity for THIS user", () => {
    const a = "11111111-2222-4333-8444-555555555555";
    const b = "99999999-8888-4777-8666-555555555555";

    const johnOf = (user: string) => fixtureUuid(DEMO_GEORGE.id, user, "entity/john");

    expect(johnOf(a)).not.toBe(johnOf(b));
    expect(johnOf(a)).toBe(johnOf(a));
    // And not Simba, who shares the fixture and the user.
    expect(johnOf(a)).not.toBe(fixtureUuid(DEMO_GEORGE.id, a, "entity/simba"));
  });

  it("the fixture really does key John that way", () => {
    // If the fixture's key for John ever changes, the contact would bind to an
    // entity that does not exist and the reviewer's email would go nowhere.
    expect(DEMO_GEORGE.entities.map((entity) => entity.key)).toContain("john");
  });
});
