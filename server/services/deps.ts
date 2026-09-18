import "server-only";
import { systemClock } from "@/server/adapters/clock";
import { demoFixtureRepo } from "@/server/repositories/demo-fixture";
import { createOpenAiTranscription } from "@/server/adapters/openai/transcription";
import { createElevenLabsVoice } from "@/server/adapters/elevenlabs/voice";
import type { SynthesisDeps, TranscriptionDeps } from "@/server/services/voice";
import type { SpeakableDeps } from "@/server/services/speakable";
import type { DemoFixtureDeps } from "@/server/services/demo-fixture";
import { createOpenAiEmbeddings } from "@/server/adapters/openai/embeddings";
import { createOpenAiExtraction } from "@/server/adapters/openai/extraction";
import { createOpenAiLlm } from "@/server/adapters/openai/llm";
import { createServiceRoleClient } from "@/server/db/client";
import { conversationsRepo } from "@/server/repositories/conversations";
import { entitiesRepo } from "@/server/repositories/entities";
import { episodesRepo } from "@/server/repositories/episodes";
import { factsRepo } from "@/server/repositories/facts";
import { jobsRepo } from "@/server/repositories/jobs";
import { messagesRepo } from "@/server/repositories/messages";
import { observationsRepo } from "@/server/repositories/observations";
import { relationshipsRepo } from "@/server/repositories/relationships";
import { interactionEventsRepo } from "@/server/repositories/interaction-events";
import { baselinesRepo } from "@/server/repositories/baselines";
import { signalsRepo } from "@/server/repositories/signals";
import { opportunitiesRepo } from "@/server/repositories/opportunities";
import { profilesRepo } from "@/server/repositories/profiles";
import { familyRequestsRepo } from "@/server/repositories/family-requests";
import { createOpenAiFamilyRender } from "@/server/adapters/openai/family-render";
import { consentGrantsRepo } from "@/server/repositories/consent-grants";
import { familyContactsRepo } from "@/server/repositories/family-contacts";
import { familyResponsesRepo } from "@/server/repositories/family-responses";
import { closuresRepo } from "@/server/repositories/closures";
import { createDevNotifier, type Notifier } from "@/server/adapters/notifier";
import { createBrevoEmailNotifier } from "@/server/adapters/brevo/email-notifier";
import { familyConfig, isDebugSurfaceEnabled, isDemoModeEnabled } from "@/server/config";
import { sha256Hex } from "@/core/share/text-hash";
import type { ConversationDataDeps, ConversationDeps } from "./conversation";
import type { IngestionDeps } from "./ingestion";
import type { BaselineDebugDeps } from "./baseline-debug";
import type { ReconnectDeps } from "./reconnect";
import type { DetectionDebugDeps } from "./detection-debug";
import type { ConsentDeps, ConsentTurnHooksSource } from "./consent-hooks";
import { buildConsentHooks } from "./consent-hooks";
import type { FamilySendDeps } from "./family-send";
import type { FamilyResponseDeps } from "./family-response";
import type { ConsentDebugDeps } from "./consent-debug";
import { loadMemoryForTurn } from "./memory-retrieval";

/**
 * Composition root. Kept apart from the services so they — and their tests —
 * never import the OpenAI SDK, the service-role key, or `server-only`.
 */
export function createConversationDataDeps(): ConversationDataDeps {
  const db = createServiceRoleClient();
  return {
    conversations: conversationsRepo(db),
    messages: messagesRepo(db),
    // Read-only, for the chat page: the pending offer and the greeting name.
    opportunities: opportunitiesRepo(db),
    entities: entitiesRepo(db),
    profiles: profilesRepo(db),
  };
}

export function createConversationDeps(): ConversationDeps {
  const db = createServiceRoleClient();
  const retrieval = {
    entities: entitiesRepo(db),
    relationships: relationshipsRepo(db),
    facts: factsRepo(db),
    episodes: episodesRepo(db),
    embeddings: createOpenAiEmbeddings(),
  };

  return {
    conversations: conversationsRepo(db),
    messages: messagesRepo(db),
    jobs: jobsRepo(db),
    llm: createOpenAiLlm(),
    memory: (input) =>
      loadMemoryForTurn(retrieval, { ...input, now: systemClock.now() }),
    // M5. The hot path gets four small functions, not the family loop's
    // repositories.
    consent: buildConsentHooks(createConsentHookSource(db)),
    // The read model behind the turn's terminal `state` event. Without these
    // the event reports "no offer" on every turn and the reconnect card is
    // retired the instant it is drawn (M8 regression 1).
    opportunities: opportunitiesRepo(db),
    entities: entitiesRepo(db),
  };
}

function createConsentHookSource(db: ReturnType<typeof createServiceRoleClient>): ConsentTurnHooksSource {
  return {
    consent: {
      clock: systemClock,
      opportunities: opportunitiesRepo(db),
      consentGrants: consentGrantsRepo(db),
      entities: entitiesRepo(db),
    },
    closure: {
      clock: systemClock,
      closures: closuresRepo(db),
      familyResponses: familyResponsesRepo(db),
      familyRequests: familyRequestsRepo(db),
      opportunities: opportunitiesRepo(db),
      entities: entitiesRepo(db),
    },
  };
}

/** M5 consent read/write outside a turn (dev tooling, debug). */
export function createConsentDeps(): ConsentDeps {
  const db = createServiceRoleClient();
  return {
    clock: systemClock,
    opportunities: opportunitiesRepo(db),
    consentGrants: consentGrantsRepo(db),
    entities: entitiesRepo(db),
  };
}

export class NotifierNotConfiguredError extends Error {
  readonly name = "NotifierNotConfiguredError";
  constructor() {
    super(
      "No family transport is configured for this environment. " +
        "Local development uses the development notifier; a deployment requires " +
        "CARELOOP_DEMO_MODE=true and the BREVO_* settings. See .env.example.",
    );
  }
}

/**
 * Which transport delivers a family message, and where it is addressed.
 *
 * This used to be `createDevNotifier()` unconditionally, and the audit found
 * what that meant on a deployment: the dev notifier refuses to be constructed
 * outside local development, so the throw happened while EVALUATING the
 * argument - before `sendApprovedOpportunity` ran a single line. George
 * approved, the turn logged `family.send_failed`, no family_request row was
 * ever created, and nothing retried. The same throw silently disabled the
 * expiry sweep on the line below it.
 *
 * So the choice is now explicit, an allow-list, and fails closed. There is
 * deliberately NO fallback from email to the dev notifier: a deployment that
 * cannot send email must stop, not quietly write into an in-process Map that
 * nobody can read.
 */
function chooseNotifier(env: NodeJS.ProcessEnv = process.env): Notifier {
  // Local development keeps the two-tab demo and never calls a provider.
  if (isDebugSurfaceEnabled(env)) return createDevNotifier(env);
  // A public demo deployment delivers by email. Missing BREVO_* settings throw
  // FamilyEmailNotConfiguredError from the adapter, by name.
  if (isDemoModeEnabled(env)) return createBrevoEmailNotifier(env);
  throw new NotifierNotConfiguredError();
}

/**
 * WHERE a family message is addressed, decided here rather than in the send.
 *
 * Local development ensures its own dev-inbox row, as it always has. A
 * deployment REQUIRES an email contact that the reviewer configured for this
 * exact entity, and returns null when there is none - which aborts the send
 * before consent is consumed. Production never fabricates an address.
 */
function chooseContactResolver(
  db: ReturnType<typeof createServiceRoleClient>,
  env: NodeJS.ProcessEnv = process.env,
): FamilySendDeps["resolveContact"] {
  const contacts = familyContactsRepo(db);

  if (isDebugSurfaceEnabled(env)) {
    return async ({ userId, entityId, entityDisplayName }) =>
      contacts.ensure({
        userId,
        entityId,
        channel: familyConfig.devChannel,
        // An opaque digest rather than the entity id: an address is handed to
        // a transport, and internal identifiers have no business travelling.
        address: `dev-inbox:${sha256Hex(`${userId}:${entityId}`).slice(0, 16)}`,
        displayName: entityDisplayName,
      });
  }

  return async ({ userId, entityId }) =>
    contacts.findForEntityAndChannel(userId, entityId, familyConfig.emailChannel);
}

/**
 * The outbound leg. Constructed only in the after-response path and in dev
 * tooling, so the notifier is never instantiated on the hot path.
 */
export function createFamilySendDeps(): FamilySendDeps {
  const db = createServiceRoleClient();
  return {
    clock: systemClock,
    db,
    opportunities: opportunitiesRepo(db),
    consentGrants: consentGrantsRepo(db),
    familyRequests: familyRequestsRepo(db),
    familyContacts: familyContactsRepo(db),
    entities: entitiesRepo(db),
    notifier: chooseNotifier(),
    resolveContact: chooseContactResolver(db),
  };
}

/**
 * Just the contacts repository, for the demo's own configuration step.
 *
 * Narrow on purpose: recording where a demo message goes needs one table, and
 * handing that action the whole send graph would give it a notifier it has no
 * business holding.
 */
export function createFamilyContactDeps() {
  const db = createServiceRoleClient();
  return { familyContacts: familyContactsRepo(db) };
}

/** The family-facing surface. Reads one request by token hash; nothing else. */
export function createFamilyResponseDeps(): FamilyResponseDeps {
  const db = createServiceRoleClient();
  return {
    clock: systemClock,
    db,
    familyRequests: familyRequestsRepo(db),
    familyResponses: familyResponsesRepo(db),
  };
}

/** Post-turn ingestion. Constructed only in the after-response path. */
export function createIngestionDeps(): IngestionDeps {
  const db = createServiceRoleClient();
  return {
    observations: observationsRepo(db),
    entities: entitiesRepo(db),
    relationships: relationshipsRepo(db),
    facts: factsRepo(db),
    episodes: episodesRepo(db),
    jobs: jobsRepo(db),
    messages: messagesRepo(db),
    interactionEvents: interactionEventsRepo(db),
    baselines: baselinesRepo(db),
    extraction: createOpenAiExtraction(),
    embeddings: createOpenAiEmbeddings(),
    clock: systemClock,
  };
}

/** Read-only deps for the development derivation inspector. */
export function createBaselineDebugDeps(): BaselineDebugDeps {
  const db = createServiceRoleClient();
  return {
    entities: entitiesRepo(db),
    interactionEvents: interactionEventsRepo(db),
    baselines: baselinesRepo(db),
    clock: systemClock,
  };
}

/**
 * Development-only seeding deps (app/api/dev/seed-events). Same repositories
 * as production; only the caller is gated.
 */
/**
 * The development-only demo fixture. Constructed nowhere but the demo routes,
 * so the delete surface it carries cannot be reached from the product.
 */
/** M8 voice I/O. Constructed only by the two voice routes. */
export function createTranscriptionDeps(): TranscriptionDeps {
  return { speechToText: createOpenAiTranscription() };
}

/**
 * Never throws when ElevenLabs is unconfigured: the adapter returns a provider
 * that declines, so an optional capability cannot break composition. See
 * server/adapters/openai/types.ts.
 */
export function createSynthesisDeps(): SynthesisDeps {
  return { voice: createElevenLabsVoice() };
}

/**
 * What the speak endpoint is allowed to read. Repositories only - there is no
 * model here, and nothing that could produce a sentence rather than find one.
 */
export function createSpeakableDeps(): SpeakableDeps {
  const db = createServiceRoleClient();
  return {
    clock: systemClock,
    conversations: conversationsRepo(db),
    messages: messagesRepo(db),
    opportunities: opportunitiesRepo(db),
    entities: entitiesRepo(db),
    closures: closuresRepo(db),
    familyRequests: familyRequestsRepo(db),
    familyResponses: familyResponsesRepo(db),
  };
}

export function createDemoFixtureDeps(): DemoFixtureDeps {
  const db = createServiceRoleClient();
  return {
    clock: systemClock,
    entities: entitiesRepo(db),
    relationships: relationshipsRepo(db),
    episodes: episodesRepo(db),
    facts: factsRepo(db),
    interactionEvents: interactionEventsRepo(db),
    baselines: baselinesRepo(db),
    conversations: conversationsRepo(db),
    messages: messagesRepo(db),
    demo: demoFixtureRepo(db),
  };
}

export function createM3SeedDeps() {
  const db = createServiceRoleClient();
  return {
    entities: entitiesRepo(db),
    interactionEvents: interactionEventsRepo(db),
    baselines: baselinesRepo(db),
    clock: systemClock,
  };
}

/**
 * M4 detection -> draft. Constructed only in the after-response path and in
 * the development detection endpoint, so the family renderer is never
 * instantiated on the hot path.
 */
export function createReconnectDeps(): ReconnectDeps {
  const db = createServiceRoleClient();
  return {
    clock: systemClock,
    signals: signalsRepo(db),
    opportunities: opportunitiesRepo(db),
    baselines: baselinesRepo(db),
    interactionEvents: interactionEventsRepo(db),
    entities: entitiesRepo(db),
    relationships: relationshipsRepo(db),
    observations: observationsRepo(db),
    profiles: profilesRepo(db),
    familyRequests: familyRequestsRepo(db),
    conversations: conversationsRepo(db),
    familyRender: createOpenAiFamilyRender(),
  };
}

/** Read-only deps for the development detection inspector. */
export function createDetectionDebugDeps(): DetectionDebugDeps {
  const db = createServiceRoleClient();
  return {
    clock: systemClock,
    signals: signalsRepo(db),
    opportunities: opportunitiesRepo(db),
    entities: entitiesRepo(db),
  };
}

/** Read-only deps for the development consent + family inspector. */
export function createConsentDebugDeps(): ConsentDebugDeps {
  const db = createServiceRoleClient();
  return {
    clock: systemClock,
    opportunities: opportunitiesRepo(db),
    consentGrants: consentGrantsRepo(db),
    familyRequests: familyRequestsRepo(db),
    familyResponses: familyResponsesRepo(db),
    closures: closuresRepo(db),
    entities: entitiesRepo(db),
  };
}
