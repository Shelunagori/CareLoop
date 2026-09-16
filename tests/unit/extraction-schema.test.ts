import { describe, expect, it } from "vitest";
import {
  EXTRACTION_CONTRACT_VERSION,
  EXTRACTION_V1_JSON_SCHEMA,
  ExtractionV1LiveSchema,
  ExtractionV1Schema,
} from "@/core/memory/extraction-contract";
import { extractionPromptV1 } from "@/server/prompts/extraction.v1";

/** A payload as recorded before M3 existed: no `interactions` key at all. */
const preM3Payload = {
  entities: [
    {
      mention: "John",
      canonicalName: "John",
      type: "person",
      subtype: null,
      confidence: 0.9,
      sourceSpan: "John",
    },
  ],
  relationships: [],
  facts: [],
  episodes: [],
};

describe("stored-observation compatibility", () => {
  it("parses a pre-M3 payload, defaulting interactions to []", () => {
    const parsed = ExtractionV1Schema.safeParse(preM3Payload);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.interactions).toEqual([]);
      // The rest of the payload survives untouched.
      expect(parsed.data.entities).toHaveLength(1);
    }
  });

  it("means an old observation replays to zero interaction events", () => {
    const parsed = ExtractionV1Schema.parse(preM3Payload);
    expect(parsed.interactions).toHaveLength(0);
  });

  it("keeps the contract version unchanged, so nothing is re-extracted", () => {
    expect(EXTRACTION_CONTRACT_VERSION).toBe("extraction.v1");
    // The prompt revision is what carries the change, per observation.
    expect(extractionPromptV1.ref).toBe("extraction.v1.r3");
  });
});

describe("live provider strictness", () => {
  it("REFUSES a fresh response that omits interactions", () => {
    const parsed = ExtractionV1LiveSchema.safeParse(preM3Payload);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((i) => i.path.includes("interactions"))).toBe(true);
    }
  });

  it("accepts a fresh response with an explicitly empty interactions array", () => {
    const parsed = ExtractionV1LiveSchema.safeParse({ ...preM3Payload, interactions: [] });
    expect(parsed.success).toBe(true);
  });

  it("the JSON schema sent to the provider lists interactions as REQUIRED", () => {
    expect(EXTRACTION_V1_JSON_SCHEMA.required).toContain("interactions");
    // Strict structured output also forbids extra keys.
    expect(EXTRACTION_V1_JSON_SCHEMA.additionalProperties).toBe(false);
  });

  it("describes the interaction item shape the deterministic layer needs", () => {
    const item = EXTRACTION_V1_JSON_SCHEMA.properties.interactions.items;
    expect(item.required).toEqual([
      "participantMention",
      "eventType",
      "polarity",
      "temporal",
      "certainty",
      "sourceSpan",
    ]);
    expect(item.properties.eventType.enum).toEqual(["visit", "call"]);
    expect(item.properties.polarity.enum).toEqual(["positive", "absence"]);
    expect(item.additionalProperties).toBe(false);
  });

  it("the ingestion service uses the strict parser for live responses only", async () => {
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
    const source = readFileSync(path.join(root, "server/services/ingestion.ts"), "utf8");

    // Stored payloads go through the tolerant parser...
    expect(source).toMatch(/ExtractionV1Schema\.safeParse\(observation\.payload\)/);
    // ...fresh provider output through the strict one.
    expect(source).toMatch(/ExtractionV1LiveSchema\.safeParse\(response\.raw\)/);
  });
});
