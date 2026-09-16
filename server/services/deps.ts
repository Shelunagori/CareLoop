import "server-only";
import { systemClock } from "@/server/adapters/clock";
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
import type { ConversationDataDeps, ConversationDeps } from "./conversation";
import type { IngestionDeps } from "./ingestion";
import type { BaselineDebugDeps } from "./baseline-debug";
import { loadMemoryForTurn } from "./memory-retrieval";

/**
 * Composition root. Kept apart from the services so they — and their tests —
 * never import the OpenAI SDK, the service-role key, or `server-only`.
 */
export function createConversationDataDeps(): ConversationDataDeps {
  const db = createServiceRoleClient();
  return { conversations: conversationsRepo(db), messages: messagesRepo(db) };
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
export function createM3SeedDeps() {
  const db = createServiceRoleClient();
  return {
    entities: entitiesRepo(db),
    interactionEvents: interactionEventsRepo(db),
    baselines: baselinesRepo(db),
    clock: systemClock,
  };
}
