import { describe, expect, it } from "vitest";
import {
  FAMILY_TOKEN_BYTES,
  FAMILY_TOKEN_WINDOW_DAYS,
  familyTokenExpiresAt,
  hashFamilyToken,
  isTokenExpired,
  mintFamilyToken,
  tokenHashEquals,
  tokenHashPrefix,
} from "@/core/family/token";
import {
  FAMILY_REPLY_INTENTS,
  FamilyReplySchema,
  findReplyChoice,
  replyChoicesFor,
} from "@/core/family/response";
import { closureMarker, renderClosureSentence, type ClosureFact } from "@/core/family/closure";
import { findDeniedTerm } from "@/core/safety/deny-list";

const NOW = new Date("2026-09-16T12:00:00.000Z");
const DAY = 86_400_000;

describe("1. the capability token", () => {
  it("is 32 random bytes, base64url", () => {
    const { plaintext } = mintFamilyToken();
    expect(Buffer.from(plaintext, "base64url")).toHaveLength(FAMILY_TOKEN_BYTES);
    // base64url: no +, / or = padding, so it survives a URL path unescaped.
    expect(plaintext).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("is unguessable — a thousand mints collide never", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i += 1) seen.add(mintFamilyToken().plaintext);
    expect(seen.size).toBe(1000);
  });

  it("stores only the hash, and the hash does not reveal the token", () => {
    const { plaintext, hash } = mintFamilyToken();
    expect(hash).toHaveLength(64);
    expect(hash).not.toContain(plaintext);
    expect(hashFamilyToken(plaintext)).toBe(hash);
  });

  it("hashes are compared in constant time", () => {
    const a = hashFamilyToken("one");
    const b = hashFamilyToken("two");
    expect(tokenHashEquals(a, a)).toBe(true);
    expect(tokenHashEquals(a, b)).toBe(false);
    // Different lengths must not throw; timingSafeEqual would.
    expect(tokenHashEquals(a, "short")).toBe(false);
  });

  it("a log prefix is useless as a credential", () => {
    const { hash } = mintFamilyToken();
    const prefix = tokenHashPrefix(hash);
    expect(prefix).toHaveLength(8);
    expect(hash.startsWith(prefix)).toBe(true);
  });
});

describe("2. the token window", () => {
  it("runs seven days from CREATION, not delivery", () => {
    expect(familyTokenExpiresAt(NOW).getTime() - NOW.getTime()).toBe(
      FAMILY_TOKEN_WINDOW_DAYS * DAY,
    );
  });

  it("is invalid exactly AT expiry, valid an instant before", () => {
    const expiresAt = familyTokenExpiresAt(NOW).toISOString();
    expect(isTokenExpired(expiresAt, new Date(Date.parse(expiresAt) - 1))).toBe(false);
    expect(isTokenExpired(expiresAt, new Date(Date.parse(expiresAt)))).toBe(true);
    expect(isTokenExpired(expiresAt, new Date(Date.parse(expiresAt) + 1))).toBe(true);
  });
});

describe("3. bounded reply choices, so no model is needed", () => {
  it("offers visit choices for a visit and call choices for a call", () => {
    expect(replyChoicesFor("visit").some((c) => /visit/i.test(c.label))).toBe(true);
    expect(replyChoicesFor("call").some((c) => /call/i.test(c.label))).toBe(true);
    expect(replyChoicesFor("call").some((c) => /visiting/i.test(c.label))).toBe(false);
  });

  it("every choice parses against the reply schema", () => {
    for (const topic of ["visit", "call"] as const) {
      for (const choice of replyChoicesFor(topic)) {
        expect(
          FamilyReplySchema.safeParse({
            intent: choice.intent,
            ...(choice.timeframe ? { timeframe: choice.timeframe } : {}),
          }).success,
        ).toBe(true);
      }
    }
  });

  it("refuses a choice id that this topic does not offer", () => {
    expect(findReplyChoice("visit", "yes_weekend")).not.toBeNull();
    expect(findReplyChoice("call", "yes_weekend")).toBeNull();
    expect(findReplyChoice("visit", "../../etc/passwd")).toBeNull();
    expect(findReplyChoice("visit", "")).toBeNull();
  });
});

describe("4. the closure is factual and nothing more", () => {
  const fact = (overrides: Partial<ClosureFact> = {}): ClosureFact => ({
    opportunityId: "opp-1",
    familyRequestId: "req-1",
    responseId: "res-1",
    entityName: "John",
    topic: "visit",
    responseIntent: "yes",
    timeframe: "this weekend",
    createdAt: NOW.toISOString(),
    ...overrides,
  });

  it("reports what was answered", () => {
    expect(renderClosureSentence(fact())).toBe(
      "John replied that they are planning to visit this weekend.",
    );
    expect(renderClosureSentence(fact({ responseIntent: "no", timeframe: undefined }))).toBe(
      "John replied that they are not able to visit just now.",
    );
    expect(renderClosureSentence(fact({ responseIntent: "unsure" }))).toBe(
      "John replied that they are not sure yet.",
    );
    expect(renderClosureSentence(fact({ topic: "call", responseIntent: "yes", timeframe: "soon" }))).toBe(
      "John replied that they are planning to call soon.",
    );
  });

  it("the stored answer is a bare polarity; the TOPIC supplies the verb", () => {
    // The regression this pins: an earlier vocabulary stored `visiting` and
    // reused it for a call, so the recorded answer to "will you ring them?"
    // was literally the word "visiting". Every intent must now read correctly
    // under every topic, because the intent no longer names an activity.
    for (const intent of FAMILY_REPLY_INTENTS) {
      expect(renderClosureSentence(fact({ topic: "call", responseIntent: intent })))
        .not.toContain("visit");
      expect(renderClosureSentence(fact({ topic: "visit", responseIntent: intent })))
        .not.toContain("call");
    }
    expect(FAMILY_REPLY_INTENTS).toEqual(["yes", "no", "unsure", "other"]);
    for (const name of FAMILY_REPLY_INTENTS) {
      expect(name, "an intent must not name an activity").not.toMatch(/visit|call/);
    }
  });

  it("every choice offered for a topic carries a topic-neutral intent", () => {
    for (const topic of ["visit", "call"] as const) {
      for (const choice of replyChoicesFor(topic)) {
        expect(FAMILY_REPLY_INTENTS).toContain(choice.intent);
        expect(choice.intent).not.toMatch(/visit|call/);
      }
    }
  });

  it("never infers an emotion or a state", () => {
    for (const intent of ["yes", "no", "unsure", "other"] as const) {
      for (const topic of ["visit", "call"] as const) {
        const sentence = renderClosureSentence(fact({ responseIntent: intent, topic }));
        expect(findDeniedTerm(sentence), sentence).toBeNull();
        for (const forbidden of ["misses", "worried", "happy", "cheer", "lonely", "sad"]) {
          expect(sentence.toLowerCase(), sentence).not.toContain(forbidden);
        }
      }
    }
  });

  it("the marker carries four fields and no family wording", () => {
    const marker = closureMarker(fact());
    expect(marker).toEqual({
      type: "family_response",
      entityName: "John",
      response: "yes",
      timeframe: "this weekend",
    });
    expect(JSON.stringify(marker)).not.toContain("opp-1");
    expect(JSON.stringify(marker)).not.toContain("req-1");
  });

  it("omits the timeframe rather than inventing one", () => {
    expect(closureMarker(fact({ timeframe: undefined })).timeframe).toBeUndefined();
  });
});
