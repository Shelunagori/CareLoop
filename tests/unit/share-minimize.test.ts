import { describe, expect, it } from "vitest";
import { buildProposal, type ReconnectProposal } from "@/core/detection/proposal";
import { minimize, sanitizeLabel } from "@/core/share/minimize";
import {
  serializeSharePayload,
  SharePayloadSchema,
  SHARE_PAYLOAD_FIELDS,
} from "@/core/share/payload";
import { shareConfig } from "@/core/share/config";
import type { CadenceExplanation, AbsenceExplanation } from "@/core/detection/types";

const CADENCE: CadenceExplanation = {
  detector: "cadence_gap",
  methodVersion: "detection.v1",
  detectionKey: "dk-cadence",
  entityId: "entity-john",
  eventType: "visit",
  medianGapDays: 7,
  madDays: 1,
  thresholdDays: 11,
  daysSinceLast: 13,
  lastEventId: "ev-1",
  lastEventDate: "2026-09-03",
  contributingEventCount: 9,
  baselineInputsHash: "bh-1",
  conversationId: "conv-1",
};

const ABSENCE: AbsenceExplanation = {
  detector: "user_asserted_absence",
  methodVersion: "detection.v1",
  detectionKey: "dk-absence",
  entityId: "entity-john",
  eventType: "visit",
  sourceEventId: "abs-1",
  absenceWindowStart: "2026-09-09T00:00:00.000Z",
  absenceWindowEnd: "2026-09-16T12:00:00.000Z",
  statedPhrase: "this week",
  reportedAt: "2026-09-16T12:00:00.000Z",
  certainty: 0.9,
  baseline: null,
  conversationId: "conv-1",
};

const ACTIVE = {
  status: "ACTIVE" as const,
  medianGapDays: 7,
  madDays: 1,
  dispersion: 0.1428,
  observationCount: 9,
  windowStart: null,
  windowEnd: null,
  reasons: [],
  methodVersion: "baseline.v1",
  inputsHash: "bh-1",
};

describe("1. the cadence proposal carries observable facts only", () => {
  const proposal = buildProposal({
    explanation: CADENCE,
    entityName: "John",
    alsoMention: ["Simba"],
    baseline: ACTIVE,
  });

  it("states elapsed time and the pattern, and nothing else", () => {
    expect(proposal).toEqual({
      entityId: "entity-john",
      entityName: "John",
      alsoMention: ["Simba"],
      eventType: "visit",
      observation: { kind: "no_mention_since", days: 13 },
      pattern: { medianGapDays: 7 },
      question: "ask_if_visiting",
    });
  });

  it("omits timeframe — the system has no evidence for one", () => {
    expect(proposal.timeframe).toBeUndefined();
  });

  it("a call series asks the call question", () => {
    const call = buildProposal({
      explanation: { ...CADENCE, eventType: "call" },
      entityName: "John",
      alsoMention: [],
      baseline: ACTIVE,
    });
    expect(call.question).toBe("ask_if_calling");
    expect(call.alsoMention).toBeUndefined();
  });
});

describe("2. no baseline means no pattern claim", () => {
  it("omits `pattern` entirely for an absence with no baseline", () => {
    const proposal = buildProposal({
      explanation: ABSENCE, entityName: "John", alsoMention: [], baseline: null,
    });
    expect(proposal.pattern).toBeUndefined();
    expect("pattern" in proposal).toBe(false);
  });

  it("omits `pattern` for an IRREGULAR baseline too", () => {
    const proposal = buildProposal({
      explanation: ABSENCE,
      entityName: "John",
      alsoMention: [],
      baseline: { ...ACTIVE, status: "IRREGULAR" },
    });
    expect(proposal.pattern).toBeUndefined();
  });
});

describe("3. minimization is a projection, not a copy", () => {
  const proposal = buildProposal({
    explanation: CADENCE, entityName: "John", alsoMention: ["Simba"], baseline: ACTIVE,
  });
  const payload = minimize({ proposal, profile: { familyDisplayName: "Dad" } });

  it("emits only whitelisted fields", () => {
    expect(Object.keys(payload).every((key) => (SHARE_PAYLOAD_FIELDS as readonly string[]).includes(key))).toBe(true);
    expect(payload).toEqual({
      fromDisplayName: "Dad",
      aboutEntityName: "Simba",
      topic: "visit",
      question: "ask_if_visiting",
    });
  });

  it("drops the recipient's own name — they know who they are", () => {
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain("John");
    expect(serialized).not.toContain("entity-john");
  });

  it("drops elapsed days, the pattern, the observation and every identifier", () => {
    const serialized = `${JSON.stringify(payload)}\n${serializeSharePayload(payload)}`;
    for (const leak of ["13", "no_mention_since", "medianGapDays", "bh-1", "ev-1", "dk-cadence", "conv-1"]) {
      expect(serialized).not.toContain(leak);
    }
  });

  it("never populates freeNote — there is no parameter that could", () => {
    expect(payload.freeNote).toBeUndefined();
  });

  it("falls back to a neutral label when the user has set none", () => {
    const anon = minimize({ proposal, profile: { familyDisplayName: null } });
    expect(anon.fromDisplayName).toBe(shareConfig.defaultFromDisplayName);
  });
});

describe("4. labels are sanitized at the boundary, not trusted", () => {
  it("accepts ordinary names", () => {
    for (const name of ["Dad", "Mum", "Nan", "Jean-Pierre", "O'Brien", "Mr. Fox"]) {
      expect(sanitizeLabel(name)).toBe(name);
    }
  });

  it("refuses a label carrying a denied term", () => {
    expect(sanitizeLabel("Lonely Dad")).toBeNull();
    expect(sanitizeLabel("Dad who is unwell")).toBeNull();
  });

  it("refuses digits, punctuation, markup and overlong text", () => {
    for (const bad of ["Dad2", "Dad!", "<b>Dad</b>", "http://x.test", "D".repeat(shareConfig.maxLabelLength + 1)]) {
      expect(sanitizeLabel(bad)).toBeNull();
    }
  });

  it("a hostile profile label cannot reach the outbound payload", () => {
    const proposal = buildProposal({
      explanation: CADENCE, entityName: "John", alsoMention: ["Isolated"], baseline: ACTIVE,
    });
    const payload = minimize({ proposal, profile: { familyDisplayName: "Depressed Dad" } });
    expect(payload.fromDisplayName).toBe(shareConfig.defaultFromDisplayName);
    // The related name was refused rather than smuggled through.
    expect(payload.aboutEntityName).toBeUndefined();
  });
});

describe("5. serialization walks the whitelist, not the object", () => {
  it("the whitelist is exactly the six fields docs/04 section 11.4 declares", () => {
    expect([...SHARE_PAYLOAD_FIELDS]).toEqual([
      "fromDisplayName",
      "aboutEntityName",
      "topic",
      "timeframe",
      "question",
      "freeNote",
    ]);
  });

  it("serializes nothing outside those six, even when the object carries more", () => {
    const smuggled = {
      fromDisplayName: "Dad",
      topic: "visit",
      question: "ask_if_visiting",
      daysSinceLast: 13,
      baselineInputsHash: "bh-1",
      sourceObservationId: "obs-1",
      summary: "John came round with Simba and they had tea",
    } as unknown as Parameters<typeof serializeSharePayload>[0];
    const serialized = serializeSharePayload(smuggled);
    expect(serialized.split("\n")).toEqual([
      "fromDisplayName: Dad",
      "topic: visit",
      "question: ask_if_visiting",
    ]);
    for (const leak of ["13", "bh-1", "obs-1", "Simba", "daysSinceLast"]) {
      expect(serialized).not.toContain(leak);
    }
  });

  it("ignores a key the type does not declare", () => {
    const smuggled = {
      fromDisplayName: "Dad",
      topic: "visit",
      question: "ask_if_visiting",
      transcript: "PRIVATE_TRANSCRIPT_SENTINEL_7F3A",
    } as unknown as Parameters<typeof serializeSharePayload>[0];
    expect(serializeSharePayload(smuggled)).not.toContain("PRIVATE_TRANSCRIPT_SENTINEL_7F3A");
  });

  it("produces a stable, snapshot-testable string", () => {
    expect(
      serializeSharePayload({
        fromDisplayName: "Dad",
        aboutEntityName: "Simba",
        topic: "visit",
        question: "ask_if_visiting",
      }),
    ).toBe("fromDisplayName: Dad\naboutEntityName: Simba\ntopic: visit\nquestion: ask_if_visiting");
  });

  it("the read-side schema refuses an extra stored key", () => {
    expect(
      SharePayloadSchema.safeParse({
        fromDisplayName: "Dad",
        topic: "visit",
        question: "ask_if_visiting",
        daysSinceLast: 13,
      }).success,
    ).toBe(false);
  });
});

describe("6. the proposal type cannot express an internal state", () => {
  it("has no field for mood, health, risk or urgency", () => {
    const proposal: ReconnectProposal = buildProposal({
      explanation: CADENCE, entityName: "John", alsoMention: [], baseline: ACTIVE,
    });
    const keys = Object.keys(proposal).join(",");
    for (const forbidden of ["mood", "affect", "risk", "health", "score", "urgency", "concern"]) {
      expect(keys).not.toContain(forbidden);
    }
  });
});
