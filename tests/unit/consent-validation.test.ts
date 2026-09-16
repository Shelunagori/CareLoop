import { describe, expect, it } from "vitest";
import {
  checkApprovalPreconditions,
  checkSendPreconditions,
  grantState,
  type SendPrecheckInput,
} from "@/core/consent/validation";
import { consentExpiresAt, buildConsentScope, CONSENT_WINDOW_HOURS } from "@/core/consent/grant";
import { deepEqual } from "@/core/consent/deep-equal";
import { sha256Hex } from "@/core/share/text-hash";
import type { SharePayload } from "@/core/share/payload";

const NOW = new Date("2026-09-16T12:00:00.000Z");
const HOUR = 3_600_000;
const TEXT = "Dad was wondering — are you and Simba able to visit soon?";
const HASH = sha256Hex(TEXT);
const PAYLOAD: SharePayload = {
  fromDisplayName: "Dad",
  aboutEntityName: "Simba",
  topic: "visit",
  question: "ask_if_visiting",
};

function precheckInput(overrides: {
  grant?: Partial<SendPrecheckInput["grant"]>;
  opportunity?: Partial<SendPrecheckInput["opportunity"]>;
  now?: Date;
} = {}): SendPrecheckInput {
  return {
    grant: {
      renderedTextSnapshot: TEXT,
      renderedTextHash: HASH,
      payloadSnapshot: { ...PAYLOAD },
      expiresAt: new Date(NOW.getTime() + 72 * HOUR).toISOString(),
      usedAt: null,
      revokedAt: null,
      ...overrides.grant,
    },
    opportunity: {
      status: "approved",
      renderedText: TEXT,
      renderedTextHash: HASH,
      sharePayload: { ...PAYLOAD },
      ...overrides.opportunity,
    },
    now: overrides.now ?? NOW,
  };
}

const refuse = (input: SendPrecheckInput) => {
  const result = checkSendPreconditions(input);
  if (result.ok) throw new Error("expected refusal");
  return result.failure;
};

describe("1. grant state is derived, never stored", () => {
  const base = { expiresAt: new Date(NOW.getTime() + HOUR).toISOString() };

  it("is active while unused, unrevoked and in window", () => {
    expect(grantState({ ...base, usedAt: null, revokedAt: null }, NOW)).toBe("active");
  });

  it("is used once used, whatever the window says", () => {
    // The action is complete and cannot be un-performed; continuing to enforce
    // the window would mean invalidating a message already received.
    const past = { expiresAt: new Date(NOW.getTime() - HOUR).toISOString() };
    expect(grantState({ ...past, usedAt: NOW.toISOString(), revokedAt: null }, NOW)).toBe("used");
  });

  it("is revoked when revoked", () => {
    expect(grantState({ ...base, usedAt: null, revokedAt: NOW.toISOString() }, NOW)).toBe("revoked");
  });

  it("expires exactly AT the boundary, not after it", () => {
    const at = { expiresAt: NOW.toISOString(), usedAt: null, revokedAt: null };
    expect(grantState(at, NOW)).toBe("expired");
    const justBefore = {
      expiresAt: new Date(NOW.getTime() + 1).toISOString(),
      usedAt: null,
      revokedAt: null,
    };
    expect(grantState(justBefore, NOW)).toBe("active");
  });

  it("the window is 72 hours from approval and is never extended here", () => {
    expect(consentExpiresAt(NOW).getTime() - NOW.getTime()).toBe(CONSENT_WINDOW_HOURS * HOUR);
  });
});

describe("2. the five send preconditions", () => {
  it("passes a clean chain and hands back the exact bytes", () => {
    const result = checkSendPreconditions(precheckInput());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.bytes).toBe(TEXT);
  });

  it("refuses a used, revoked or expired grant", () => {
    expect(refuse(precheckInput({ grant: { usedAt: NOW.toISOString() } }))).toBe(
      "grant_already_used",
    );
    expect(refuse(precheckInput({ grant: { revokedAt: NOW.toISOString() } }))).toBe(
      "grant_revoked",
    );
    expect(refuse(precheckInput({ grant: { expiresAt: NOW.toISOString() } }))).toBe(
      "grant_expired",
    );
  });

  it("refuses an opportunity that is not approved", () => {
    for (const status of ["drafted", "offered", "consumed", "declined", "expired"] as const) {
      expect(refuse(precheckInput({ opportunity: { status } }))).toBe(
        "opportunity_not_approved",
      );
    }
  });

  it("refuses a snapshot whose own hash no longer recomputes", () => {
    expect(
      refuse(precheckInput({ grant: { renderedTextSnapshot: `${TEXT} ` } })),
    ).toBe("snapshot_hash_mismatch");
  });

  it("refuses when the opportunity's hash has moved", () => {
    expect(
      refuse(precheckInput({ opportunity: { renderedTextHash: sha256Hex("something else") } })),
    ).toBe("opportunity_hash_mismatch");
  });

  it("refuses when the stored text no longer matches the approved bytes", () => {
    // Both hashes can be made to agree by someone who edited the text AND
    // recomputed the hash. Comparing the bytes costs nothing and closes it.
    const edited = `${TEXT}!`;
    expect(
      refuse(
        precheckInput({
          opportunity: { renderedText: edited, renderedTextHash: HASH },
        }),
      ),
    ).toBe("rendered_text_mismatch");
  });

  it("refuses when the payload has changed", () => {
    expect(
      refuse(
        precheckInput({
          opportunity: { sharePayload: { ...PAYLOAD, aboutEntityName: "Rex" } },
        }),
      ),
    ).toBe("payload_mismatch");
  });

  it("refuses a draft that is missing entirely", () => {
    expect(refuse(precheckInput({ opportunity: { renderedText: null } }))).toBe(
      "opportunity_draft_missing",
    );
  });

  it("accepts a payload whose keys came back in a different order", () => {
    // Postgres does not promise jsonb key order; refusing a legitimate send
    // over it would be as bad a failure as allowing an illegitimate one.
    const reordered = {
      question: PAYLOAD.question,
      topic: PAYLOAD.topic,
      aboutEntityName: PAYLOAD.aboutEntityName,
      fromDisplayName: PAYLOAD.fromDisplayName,
    };
    expect(checkSendPreconditions(precheckInput({ opportunity: { sharePayload: reordered } })).ok).toBe(true);
  });
});

describe("3. approval preconditions", () => {
  const opportunity = {
    status: "offered" as const,
    expiresAt: new Date(NOW.getTime() + HOUR).toISOString(),
    renderedText: TEXT,
    renderedTextHash: HASH,
    sharePayload: PAYLOAD,
  };

  it("accepts an offered, unexpired, fully drafted opportunity", () => {
    expect(checkApprovalPreconditions({ opportunity, now: NOW }).ok).toBe(true);
  });

  it("refuses anything not `offered`", () => {
    for (const status of ["proposed", "drafted", "approved", "consumed", "declined", "expired"] as const) {
      const result = checkApprovalPreconditions({
        opportunity: { ...opportunity, status },
        now: NOW,
      });
      expect(result.ok).toBe(false);
    }
  });

  it("refuses exactly AT expiry — a stale opportunity may not be approved", () => {
    const at = checkApprovalPreconditions({
      opportunity: { ...opportunity, expiresAt: NOW.toISOString() },
      now: NOW,
    });
    expect(at.ok).toBe(false);
    if (!at.ok) expect(at.failure).toBe("opportunity_expired");

    const justBefore = checkApprovalPreconditions({
      opportunity: { ...opportunity, expiresAt: new Date(NOW.getTime() + 1).toISOString() },
      now: NOW,
    });
    expect(justBefore.ok).toBe(true);
  });

  it("refuses when text, hash or payload is missing", () => {
    for (const patch of [
      { renderedText: null },
      { renderedTextHash: null },
      { sharePayload: null },
    ]) {
      const result = checkApprovalPreconditions({
        opportunity: { ...opportunity, ...patch },
        now: NOW,
      });
      expect(result.ok).toBe(false);
    }
  });
});

describe("4. the scope names what actually leaves", () => {
  it("lists only the populated SharePayload fields", () => {
    expect(buildConsentScope({ recipientEntityId: "e1", payload: PAYLOAD })).toEqual({
      recipientEntityId: "e1",
      purpose: "reconnect_request",
      fields: ["fromDisplayName", "aboutEntityName", "topic", "question"],
    });
  });

  it("omits fields that are not being shared", () => {
    const minimal: SharePayload = {
      fromDisplayName: "Dad",
      topic: "call",
      question: "ask_if_calling",
    };
    expect(buildConsentScope({ recipientEntityId: "e1", payload: minimal }).fields).toEqual([
      "fromDisplayName",
      "topic",
      "question",
    ]);
  });
});

describe("5. deep equality", () => {
  it("ignores key order but not content", () => {
    expect(deepEqual({ a: 1, b: { c: 2 } }, { b: { c: 2 }, a: 1 })).toBe(true);
    expect(deepEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(deepEqual({ a: 1 }, { a: "1" })).toBe(false);
    expect(deepEqual([1, 2], [2, 1])).toBe(false);
    expect(deepEqual(null, undefined)).toBe(false);
  });
});
