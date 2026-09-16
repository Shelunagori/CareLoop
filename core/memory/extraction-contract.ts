import { z } from "zod";

/**
 * The extraction contract (docs/05 §14.2).
 *
 * Two representations of one contract:
 *  - `ExtractionV1Schema` — zod, used to validate what comes back. It enforces
 *    OUR invariants (ranges, enums, non-empty strings).
 *  - `EXTRACTION_V1_JSON_SCHEMA` — the strict JSON schema sent to OpenAI, which
 *    guarantees the SHAPE. It is deliberately a simpler subset: strict mode
 *    does not support range or length keywords, which is exactly why zod still
 *    runs on receipt rather than trusting the provider.
 *
 * Note what the model is NOT asked for: entity ids, merge decisions, evidence
 * status, absolute dates it computed itself, or salience. It reports what was
 * said. Everything else is decided by deterministic code.
 */
export const EXTRACTION_CONTRACT_VERSION = "extraction.v1";

export const EntityTypeSchema = z.enum(["person", "pet", "place", "org"]);

export const EntityMentionSchema = z.object({
  /** Exactly as the person referred to it: "John", "his dog Simba", "my son". */
  mention: z.string().min(1),
  /** The bare name to store: "John", "Simba". */
  canonicalName: z.string().min(1),
  type: EntityTypeSchema,
  /** Freeform descriptive only — "dog". Never a relationship kind. */
  subtype: z.string().nullable(),
  confidence: z.number().min(0).max(1),
  sourceSpan: z.string(),
});

export const RelationshipClaimSchema = z.object({
  /** null means the edge starts at the user themself. */
  fromMention: z.string().nullable(),
  toMention: z.string().min(1),
  /** "son", "daughter", "pet", "family_pet", "neighbour"… never a species. */
  kind: z.string().min(1),
  /** True only when the person directly affirmed it this turn. */
  explicitlyConfirmed: z.boolean(),
  confidence: z.number().min(0).max(1),
  sourceSpan: z.string(),
});

export const FactClaimSchema = z.object({
  /** null means the fact is about the user. */
  subjectMention: z.string().nullable(),
  key: z.string().min(1),
  value: z.string().min(1),
  explicitlyConfirmed: z.boolean(),
  confidence: z.number().min(0).max(1),
  sourceSpan: z.string(),
});

export const TemporalClaimSchema = z.object({
  /** The PHRASE the person used. Never a date the model computed. */
  expression: z.string().nullable(),
  /** Only when the person stated a calendar date outright. */
  absoluteDate: z.string().nullable(),
});

/**
 * Interaction claims (M3).
 *
 * The smallest extension that lets deterministic code tell a visit from a call
 * from an absence. Episodes are narrative; these are the countable social facts
 * a baseline is computed from, and they need a type and a polarity that no
 * amount of re-reading a summary can reliably recover.
 *
 * The model still decides nothing: it reports what kind of contact the person
 * described and how sure the sentence is. Whether a row exists, when it
 * happened, and what it means for a rhythm are all decided downstream.
 */
export const InteractionEventTypeSchema = z.enum(["visit", "call"]);
export const InteractionPolaritySchema = z.enum(["positive", "absence"]);

export const InteractionClaimSchema = z.object({
  /** Who the contact was with. Same mention vocabulary as everywhere else. */
  participantMention: z.string().min(1),
  eventType: InteractionEventTypeSchema,
  /** "positive" = it happened. "absence" = they said it did NOT happen. */
  polarity: InteractionPolaritySchema,
  temporal: z.lazy(() => TemporalClaimSchema),
  /** How clearly the message states this contact, 0 to 1. */
  certainty: z.number().min(0).max(1),
  sourceSpan: z.string(),
});

export const EpisodeClaimSchema = z.object({
  /** One sentence, third person, past tense. */
  summary: z.string().min(1),
  participantMentions: z.array(z.string()),
  temporal: TemporalClaimSchema,
  /** Emotion words the PERSON used. Not the model's read of their mood. */
  emotionWords: z.array(z.string()),
  confidence: z.number().min(0).max(1),
  sourceSpan: z.string(),
});

const extractionShape = {
  entities: z.array(EntityMentionSchema),
  relationships: z.array(RelationshipClaimSchema),
  facts: z.array(FactClaimSchema),
  episodes: z.array(EpisodeClaimSchema),
};

/**
 * STORED-OBSERVATION parser. Backward compatible on purpose.
 *
 * `interactions` was added in M3, so observations recorded before it must
 * still parse on replay: they default to [] and yield no interaction events,
 * which is honest because the model was never asked. That compatibility is why
 * EXTRACTION_CONTRACT_VERSION is unchanged - bumping it would re-extract the
 * whole corpus and create a second observation row per message for a field
 * that is purely additive.
 *
 * Use this ONLY for payloads already in the database.
 */
export const ExtractionV1Schema = z.object({
  ...extractionShape,
  interactions: z.array(InteractionClaimSchema).default([]),
});

/**
 * LIVE provider parser. Strict on purpose.
 *
 * A fresh response must carry `interactions` explicitly - an empty array when
 * there was no contact, never a missing key. The provider is sent a strict
 * JSON schema listing it as required, so a response without it means the
 * provider did not honour the contract. Defaulting there would turn a broken
 * extractor into a person whose visits quietly stop counting, which is exactly
 * the kind of silent failure this layer exists to prevent.
 */
export const ExtractionV1LiveSchema = z.object({
  ...extractionShape,
  interactions: z.array(InteractionClaimSchema),
});

export type EntityMention = z.infer<typeof EntityMentionSchema>;
export type RelationshipClaim = z.infer<typeof RelationshipClaimSchema>;
export type FactClaim = z.infer<typeof FactClaimSchema>;
export type EpisodeClaim = z.infer<typeof EpisodeClaimSchema>;
export type InteractionClaim = z.infer<typeof InteractionClaimSchema>;
export type InteractionEventType = z.infer<typeof InteractionEventTypeSchema>;
export type InteractionPolarity = z.infer<typeof InteractionPolaritySchema>;
export type ExtractionV1 = z.infer<typeof ExtractionV1Schema>;
export type ExtractionV1Live = z.infer<typeof ExtractionV1LiveSchema>;

export const EMPTY_EXTRACTION: ExtractionV1 = {
  entities: [],
  relationships: [],
  facts: [],
  episodes: [],
  interactions: [],
};

const nullableString = { type: ["string", "null"] as const };

/**
 * Strict JSON schema for the provider. Every property is required and
 * additionalProperties is false, per OpenAI's structured-output rules;
 * optionality is expressed as a nullable type instead.
 */
export const EXTRACTION_V1_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["entities", "relationships", "facts", "episodes", "interactions"],
  properties: {
    entities: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["mention", "canonicalName", "type", "subtype", "confidence", "sourceSpan"],
        properties: {
          mention: { type: "string" },
          canonicalName: { type: "string" },
          type: { type: "string", enum: ["person", "pet", "place", "org"] },
          subtype: nullableString,
          confidence: { type: "number" },
          sourceSpan: { type: "string" },
        },
      },
    },
    relationships: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "fromMention",
          "toMention",
          "kind",
          "explicitlyConfirmed",
          "confidence",
          "sourceSpan",
        ],
        properties: {
          fromMention: nullableString,
          toMention: { type: "string" },
          kind: { type: "string" },
          explicitlyConfirmed: { type: "boolean" },
          confidence: { type: "number" },
          sourceSpan: { type: "string" },
        },
      },
    },
    facts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "subjectMention",
          "key",
          "value",
          "explicitlyConfirmed",
          "confidence",
          "sourceSpan",
        ],
        properties: {
          subjectMention: nullableString,
          key: { type: "string" },
          value: { type: "string" },
          explicitlyConfirmed: { type: "boolean" },
          confidence: { type: "number" },
          sourceSpan: { type: "string" },
        },
      },
    },
    interactions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "participantMention",
          "eventType",
          "polarity",
          "temporal",
          "certainty",
          "sourceSpan",
        ],
        properties: {
          participantMention: { type: "string" },
          eventType: { type: "string", enum: ["visit", "call"] },
          polarity: { type: "string", enum: ["positive", "absence"] },
          temporal: {
            type: "object",
            additionalProperties: false,
            required: ["expression", "absoluteDate"],
            properties: {
              expression: nullableString,
              absoluteDate: nullableString,
            },
          },
          certainty: { type: "number" },
          sourceSpan: { type: "string" },
        },
      },
    },
    episodes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "summary",
          "participantMentions",
          "temporal",
          "emotionWords",
          "confidence",
          "sourceSpan",
        ],
        properties: {
          summary: { type: "string" },
          participantMentions: { type: "array", items: { type: "string" } },
          temporal: {
            type: "object",
            additionalProperties: false,
            required: ["expression", "absoluteDate"],
            properties: {
              expression: nullableString,
              absoluteDate: nullableString,
            },
          },
          emotionWords: { type: "array", items: { type: "string" } },
          confidence: { type: "number" },
          sourceSpan: { type: "string" },
        },
      },
    },
  },
} as const;
