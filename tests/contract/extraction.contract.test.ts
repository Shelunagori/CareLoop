import { describe, expect, it } from "vitest";
import { ExtractionV1Schema, EXTRACTION_V1_JSON_SCHEMA } from "@/core/memory/extraction-contract";
import { extractionPromptV1 } from "@/server/prompts/extraction.v1";

/**
 * Real-API contract test. Run explicitly:
 *
 *   OPENAI_API_KEY=... npm run test:llm-contract
 *
 * It answers one question: does the live model, under the current prompt
 * version, still return output our schema accepts? That is the thing worth
 * checking before a prompt or model change — and the thing that must never
 * gate a normal test run.
 */
const UTTERANCES = [
  "My son John visited yesterday with his dog Simba.",
  "Nothing much today, just the crossword.",
  "I had tea with Margaret from next door this morning.",
  "John's away with work again this week.",
  "Simba got mud all over the kitchen again, the little menace.",
  "My daughter Anne rang on Sunday to check in.",
];

const hasKey = Boolean(process.env.OPENAI_API_KEY);

describe.skipIf(!hasKey)("extraction contract against the live model", () => {
  it("returns schema-valid output for every representative utterance", async () => {
    // Imported lazily so the module's key check cannot run without a key.
    const { createOpenAiExtraction } = await import("@/server/adapters/openai/extraction");
    const provider = createOpenAiExtraction();

    const failures: Array<{ utterance: string; issues: unknown }> = [];

    for (const utterance of UTTERANCES) {
      const response = await provider.extract({
        promptRef: extractionPromptV1.ref,
        system: extractionPromptV1.system,
        user: utterance,
        schemaName: extractionPromptV1.schemaName,
        jsonSchema: EXTRACTION_V1_JSON_SCHEMA,
      });

      const parsed = ExtractionV1Schema.safeParse(response.raw);
      if (!parsed.success) failures.push({ utterance, issues: parsed.error.issues });
    }

    expect(failures).toEqual([]);
  });

  it("never invents an absolute date the person did not state", async () => {
    const { createOpenAiExtraction } = await import("@/server/adapters/openai/extraction");
    const provider = createOpenAiExtraction();

    const response = await provider.extract({
      promptRef: extractionPromptV1.ref,
      system: extractionPromptV1.system,
      user: "John came round yesterday.",
      schemaName: extractionPromptV1.schemaName,
      jsonSchema: EXTRACTION_V1_JSON_SCHEMA,
    });

    const parsed = ExtractionV1Schema.parse(response.raw);
    for (const episode of parsed.episodes) {
      expect(episode.temporal.absoluteDate).toBeNull();
    }
  });
});
