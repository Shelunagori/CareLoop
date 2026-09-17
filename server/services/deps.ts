import "server-only";
import { systemClock } from "@/server/adapters/clock";
import { demoFixtureRepo } from "@/server/repositories/demo-fixture";
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
import { createDevNotifier } from "@/server/adapters/notifier";
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
    notifier: createDevNotifier(),
  };
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
