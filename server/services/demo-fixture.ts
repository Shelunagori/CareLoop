import type { Clock } from "@/server/adapters/clock";
import { DAY_MS } from "@/core/baseline/day";
import { stableHash } from "@/core/baseline/hash";
import { computeCadenceThreshold } from "@/core/baseline/compute";
import type { EntitiesRepo } from "@/server/repositories/entities";
import type { RelationshipsRepo } from "@/server/repositories/relationships";
import type { EpisodesRepo } from "@/server/repositories/episodes";
import type { FactsRepo } from "@/server/repositories/facts";
import type { InteractionEventsRepo } from "@/server/repositories/interaction-events";
import type {
  DemoCounts,
  DemoFixtureRepo,
  ProfileSnapshot,
} from "@/server/repositories/demo-fixture";
import type { ConversationsRepo } from "@/server/repositories/conversations";
import type { MessagesRepo } from "@/server/repositories/messages";
import { recomputeSeries } from "@/server/services/baseline";
import type { BaselineDeps } from "@/server/services/baseline";
import type { DemoFixtureSpec } from "@/fixtures/demo/types";

/**
 * Seeding and retiring a demo fixture.
 *
 * No `import "server-only"` here, unlike `deps.ts` and `dev-tools.ts`: those
 * construct clients and touch an adapter, while this is a pure interpreter
 * over injected repositories and is exercised directly by tests. The thing
 * that must never reach the browser is the DEPS FACTORY, and that is where the
 * guard sits.
 *
 * This file contains no name, no date, no offset and no relationship kind. It
 * is a small interpreter for a `DemoFixtureSpec`, which is why the canonical
 * cast can live in `fixtures/` and never leak into anything that ships. Swap
 * the spec and the same code seeds a different demo.
 *
 * WHAT IS REAL AND WHAT IS A SHORTCUT, stated plainly because a fixture that
 * quietly fakes its own evidence is worse than no fixture:
 *
 *   REAL - interaction events are written through the ordinary repository and
 *   carry ordinary fingerprints; the baseline is computed by the real pure
 *   engine through the real service; relationships and facts are stored in the
 *   ordinary tables with ordinary confirmation status.
 *
 *   SHORTCUT - the history is written directly rather than being extracted
 *   from transcripts by M2. Every row it writes is a row M2 could have
 *   written; none of them is a state M2 could not produce. The demo's LIVE leg
 *   is deliberately NOT seeded: the sentence about not having seen someone
 *   goes through real extraction, and this file writes no absence event at
 *   all. That is the part of the demo that has to be earned.
 */
export type DemoFixtureDeps = BaselineDeps & {
  clock: Clock;
  entities: EntitiesRepo;
  relationships: RelationshipsRepo;
  episodes: EpisodesRepo;
  facts: FactsRepo;
  interactionEvents: InteractionEventsRepo;
  conversations: ConversationsRepo;
  messages: MessagesRepo;
  demo: DemoFixtureRepo;
};


export type DemoBaselineView = {
  entity: string;
  eventType: string;
  status: string;
  medianGapDays: number | null;
  madDays: number | null;
  derivedThresholdDays: number | null;
  observationCount: number;
  lastEventDaysAgo: number | null;
};

export type DemoSeedResult = {
  fixtureId: string;
  userId: string;
  entities: Array<{ key: string; id: string; displayName: string; type: string }>;
  relationships: Array<{ from: string; to: string; kind: string; status: string }>;
  interactionEvents: number;
  episodes: number;
  baselines: DemoBaselineView[];
};

/**
 * Whole days between a stored event and the anchor, both reduced to their UTC
 * day. The events are written at midnight and `now` is whenever the operator
 * asked, so a plain millisecond division would answer 13.5 and round to 14;
 * comparing days answers the 13 the fixture actually seeded.
 */
function daysBetweenUtcDays(occurredAtIso: string, now: Date): number {
  const occurred = new Date(occurredAtIso);
  const occurredDay = Date.UTC(
    occurred.getUTCFullYear(),
    occurred.getUTCMonth(),
    occurred.getUTCDate(),
  );
  const nowDay = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((nowDay - occurredDay) / DAY_MS);
}

/** Midnight UTC, `daysAgo` before the anchor. Stable to the day, by design. */
function utcMidnight(now: Date, daysAgo: number): Date {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - daysAgo * DAY_MS,
  );
}

/**
 * A deterministic, fixture-owned id.
 *
 * THIS IS THE OWNERSHIP MARKER, and it is the whole point of the redesign that
 * produced it. The previous version claimed a row because its display name
 * matched the spec, which meant a user who already knew someone by one of the
 * fixture's names would have had their real person adopted by the demo and
 * then deleted by the reset. A name is a label people reuse; it was never
 * identity.
 *
 * The id is derived from the fixture id, the user and a logical key, so it is
 * stable across processes, unique per user, and impossible to collide with a
 * `gen_random_uuid()` row by accident. Formatted as a UUID because the column
 * is one: version nibble 8 (the RFC 4122 custom/name-based range) and the
 * 10xx variant bits, so it is a well-formed UUID rather than a hash wearing
 * hyphens.
 */
export function fixtureUuid(fixtureId: string, userId: string, key: string): string {
  const hex = stableHash([fixtureId, userId, key]);
  const version = `8${hex.slice(13, 16)}`;
  const variantNibble = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    version,
    `${variantNibble}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join("-");
}

const entityId = (spec: DemoFixtureSpec, userId: string, key: string) =>
  fixtureUuid(spec.id, userId, `entity/${key}`);

const episodeId = (spec: DemoFixtureSpec, userId: string, index: number) =>
  fixtureUuid(spec.id, userId, `episode/${index}`);

/**
 * The manifest: what this fixture borrowed, and what it must give back.
 *
 * It holds the profile as it was BEFORE the demo touched it, and the list of
 * user-level fact keys the fixture actually created (as opposed to ones the
 * user already had, which it leaves alone and must never delete).
 *
 * It is stored as a fact ANCHORED TO A FIXTURE ENTITY rather than as a
 * user-level fact, for a specific reason: user-level facts are rendered into
 * the model's profile card verbatim, so a manifest stored there would put a
 * JSON blob in front of the model every turn. Anchored to an entity it is
 * invisible to the prompt, and it cascades away with the entity it hangs on -
 * so the reset cannot leave its own bookkeeping behind.
 */
const MANIFEST_KEY = (spec: DemoFixtureSpec) => `${spec.id}:manifest`;

type Manifest = {
  v: 1;
  profile: ProfileSnapshot;
  /** Only keys the fixture CREATED. Never keys it found already there. */
  factKeys: string[];
};

function parseManifest(raw: string): Manifest | null {
  try {
    const parsed = JSON.parse(raw) as Partial<Manifest>;
    if (parsed?.v !== 1 || !parsed.profile) return null;
    return { v: 1, profile: parsed.profile, factKeys: parsed.factKeys ?? [] };
  } catch {
    // A manifest we cannot read is one we must not act on: restoring a profile
    // from a guess is worse than leaving it alone and saying so.
    return null;
  }
}

async function readManifest(
  deps: DemoFixtureDeps,
  input: { userId: string; spec: DemoFixtureSpec; anchorId: string },
): Promise<{ manifest: Manifest | null; factId: string | null }> {
  const row = await deps.facts.find({
    userId: input.userId,
    subjectEntityId: input.anchorId,
    key: MANIFEST_KEY(input.spec),
  });
  if (!row) return { manifest: null, factId: null };
  return { manifest: parseManifest(row.value), factId: row.id };
}

/**
 * Retire everything this fixture owns, and nothing else.
 *
 * Ownership is "reachable from a fixture entity", plus the handful of
 * user-level facts the fixture states. One `delete` on `entities` retires an
 * entire demo run, because the frozen schema already cascades from an entity
 * through events, relationships, signals, opportunities, grants, requests,
 * responses and closures. The episodes go first, since the link table that
 * finds them cascades away with the entity.
 *
 * What it deliberately does NOT touch: conversations and messages. The
 * operator typed those; they are not the fixture's to delete, and a stale
 * transcript cannot resurrect a decision because every decision row is gone.
 */
export async function resetDemoFixture(
  deps: DemoFixtureDeps,
  input: { userId: string; spec: DemoFixtureSpec },
): Promise<{
  entitiesRemoved: number;
  episodesRemoved: number;
  factsRemoved: number;
  profileRestored: boolean;
}> {
  const { spec, userId } = input;
  const anchorId = entityId(spec, userId, spec.entities[0].key);

  // Read the manifest FIRST: it hangs on an entity this reset is about to
  // delete, and it is the only record of what the profile looked like before.
  const { manifest } = await readManifest(deps, { userId, spec, anchorId });

  // Restore before deleting. If anything after this fails, the person's own
  // profile is already back; the leftovers are a second reset away.
  let profileRestored = false;
  if (manifest) {
    if (manifest.profile.existed) {
      await deps.demo.writeProfile({
        userId,
        // null is written as null. Restoring a field to empty is a restore.
        displayName: manifest.profile.displayName,
        familyDisplayName: manifest.profile.familyDisplayName,
      });
    } else {
      // There was no profile row at all before the demo made one.
      await deps.demo.deleteProfile(userId);
    }
    profileRestored = true;
  }

  const ownedEntityIds = await deps.demo.findEntityIds({
    userId,
    ids: spec.entities.map((entity) => entityId(spec, userId, entity.key)),
  });

  const episodesRemoved = await deps.demo.deleteEpisodesByIds({
    userId,
    ids: spec.episodes.map((_, index) => episodeId(spec, userId, index)),
  });

  // One delete retires the run: the frozen schema cascades from an entity
  // through events, relationships, episode_entities, signals, opportunities,
  // grants, requests, responses and closures - and takes the manifest fact
  // with it, since that hangs on a fixture entity too.
  const entitiesRemoved = await deps.demo.deleteEntities({ userId, entityIds: ownedEntityIds });

  // Only the keys the fixture created. A fact the user already had is theirs,
  // whatever its value happens to be.
  const factsRemoved = await deps.demo.deleteUserFacts({
    userId,
    keys: manifest?.factKeys ?? [],
  });

  return { entitiesRemoved, episodesRemoved, factsRemoved, profileRestored };
}

export async function seedDemoFixture(
  deps: DemoFixtureDeps,
  input: { userId: string; spec: DemoFixtureSpec; now?: Date },
): Promise<DemoSeedResult> {
  const { spec, userId } = input;
  const now = input.now ?? deps.clock.now();
  const anchorId = entityId(spec, userId, spec.entities[0].key);

  // BEFORE anything is overwritten. This is the only moment the pre-demo
  // profile still exists to be recorded.
  const profileBefore = await deps.demo.readProfile(userId);

  /* --- entities, by deterministic id --- */
  const present = new Set(
    await deps.demo.findEntityIds({
      userId,
      ids: spec.entities.map((entity) => entityId(spec, userId, entity.key)),
    }),
  );
  const byKey = new Map<string, { id: string; displayName: string; type: string }>();
  for (const entity of spec.entities) {
    const id = entityId(spec, userId, entity.key);
    if (!present.has(id)) {
      // A same-named entity the user already has is NOT this one, and is left
      // entirely alone. Identity is the id, never the label.
      await deps.demo.createEntityWithId({
        id,
        userId,
        type: entity.type,
        subtype: entity.subtype,
        displayName: entity.displayName,
        aliases: entity.aliases ?? [],
      });
    }
    byKey.set(entity.key, { id, displayName: entity.displayName, type: entity.type });
  }

  const idFor = (key: string): string => {
    const row = byKey.get(key);
    if (!row) throw new Error(`demo fixture references unknown entity key: ${key}`);
    return row.id;
  };

  /* --- the manifest, created ONCE --- */
  const existing = await readManifest(deps, { userId, spec, anchorId });
  let manifest: Manifest = existing.manifest ?? {
    v: 1,
    profile: profileBefore,
    factKeys: [],
  };
  if (!existing.factId) {
    await deps.facts.create({
      userId,
      subjectEntityId: anchorId,
      key: MANIFEST_KEY(spec),
      value: JSON.stringify(manifest),
      confidence: 1,
      status: "confirmed",
      evidenceCount: 1,
      sourceObservationIds: [],
      sourceConversationIds: [],
    });
  }
  // A second setup must NOT re-snapshot. By then the profile already carries
  // the fixture's own values, and recording those as "what was there before"
  // would lose the person's real name for good.

  await deps.demo.writeProfile({
    userId,
    displayName: spec.profile.displayName,
    familyDisplayName: spec.profile.familyDisplayName,
  });

  /* --- relationships, confirmed, on the unique edge --- */
  const relationships: DemoSeedResult["relationships"] = [];
  for (const rel of spec.relationships) {
    const fromEntityId = rel.fromKey === null ? null : idFor(rel.fromKey);
    const toEntityId = idFor(rel.toKey);
    const found = await deps.relationships.find({ userId, fromEntityId, toEntityId, kind: rel.kind });
    const row =
      found ??
      (await deps.relationships.create({
        userId,
        fromEntityId,
        toEntityId,
        kind: rel.kind,
        labelRaw: rel.labelRaw,
        confidence: rel.confidence,
        // Confirmed WITH evidence behind it. A confirmed edge with an evidence
        // count of zero is a state the ingestion path cannot produce, and
        // seeding one would be the fixture lying about how it got here.
        status: "confirmed",
        evidenceCount: 2,
        sourceObservationIds: [],
        sourceConversationIds: [],
      }));
    relationships.push({
      from: rel.fromKey === null ? spec.profile.displayName : byKey.get(rel.fromKey)!.displayName,
      to: byKey.get(rel.toKey)!.displayName,
      kind: row.kind,
      status: row.status,
    });
  }

  /* --- facts about the user, recording only what WE created --- */
  const created: string[] = [];
  for (const fact of spec.facts) {
    const subjectEntityId = fact.subjectKey === null ? null : idFor(fact.subjectKey);
    const found = await deps.facts.find({ userId, subjectEntityId, key: fact.key });
    // A fact the user already stated is theirs. Not overwritten, not recorded,
    // and therefore not deleted by the reset either.
    if (found) continue;
    await deps.facts.create({
      userId,
      subjectEntityId,
      key: fact.key,
      value: fact.value,
      confidence: fact.confidence,
      status: "confirmed",
      evidenceCount: 2,
      sourceObservationIds: [],
      sourceConversationIds: [],
    });
    if (fact.subjectKey === null) created.push(fact.key);
  }

  const mergedKeys = [...new Set([...manifest.factKeys, ...created])];
  if (mergedKeys.length !== manifest.factKeys.length) {
    manifest = { ...manifest, factKeys: mergedKeys };
    const row = await deps.facts.find({
      userId,
      subjectEntityId: anchorId,
      key: MANIFEST_KEY(spec),
    });
    if (row) {
      await deps.facts.updateEvidence({
        id: row.id,
        value: JSON.stringify(manifest),
        status: "confirmed",
        evidenceCount: 1,
        sourceObservationIds: [],
        sourceConversationIds: [],
      });
    }
  }

  /* --- the event spine --- */
  let interactionEvents = 0;
  for (const series of spec.eventSeries) {
    const seriesEntityId = idFor(series.entityKey);
    await deps.interactionEvents.insertMany(
      series.dayOffsets.map((daysAgo) => {
        const occurredAt = utcMidnight(now, daysAgo);
        return {
          userId,
          entityId: seriesEntityId,
          eventType: series.eventType,
          occurredAt: occurredAt.toISOString(),
          occurredAtPrecision: "day" as const,
          reportedAt: occurredAt.toISOString(),
          certainty: series.certainty,
          polarity: "positive" as const,
          windowStart: null,
          windowEnd: null,
          sourceObservationId: null,
          // Deterministic and fixture-namespaced, so a second run writes
          // nothing: UNIQUE(user_id, ingest_fingerprint) does the work, not a
          // check the seeder remembers to make.
          ingestFingerprint: stableHash([
            spec.id,
            userId,
            seriesEntityId,
            series.eventType,
            occurredAt.toISOString(),
          ]),
        };
      }),
    );
    interactionEvents += series.dayOffsets.length;
  }

  /* --- episodic memory, by deterministic id --- */
  let episodes = 0;
  for (const [index, episode] of spec.episodes.entries()) {
    const id = episodeId(spec, userId, index);
    const already = await deps.demo.findEpisodeIds({ userId, ids: [id] });
    if (already.length > 0) continue;
    await deps.demo.createEpisodeWithId({
      id,
      userId,
      summary: episode.summary,
      occurredAt: utcMidnight(now, episode.dayOffset).toISOString(),
      precision: episode.precision,
      salience: episode.salience,
    });
    // No embedding: the fixture calls no embedding provider. Relationship
    // memory - which is what the demo turns on - needs none.
    await deps.demo.addEpisodeMembers(id, episode.entityKeys.map(idFor));
    episodes += 1;
  }

  /* --- baselines, through the real engine --- */
  const baselines: DemoBaselineView[] = [];
  for (const series of spec.eventSeries) {
    const seriesEntityId = idFor(series.entityKey);
    const baseline = await recomputeSeries(deps, {
      userId,
      entityId: seriesEntityId,
      eventType: series.eventType,
    });
    const lastOffset = Math.min(...series.dayOffsets);
    baselines.push({
      entity: byKey.get(series.entityKey)!.displayName,
      eventType: series.eventType,
      status: baseline.status,
      medianGapDays: baseline.medianGapDays,
      madDays: baseline.madDays,
      // Derived on the fly, never stored (docs/03 section 10.1).
      derivedThresholdDays:
        baseline.status === "ACTIVE" && baseline.medianGapDays !== null && baseline.madDays !== null
          ? computeCadenceThreshold(baseline.medianGapDays, baseline.madDays)
          : null,
      observationCount: baseline.observationCount,
      lastEventDaysAgo: Number.isFinite(lastOffset) ? lastOffset : null,
    });
  }

  return {
    fixtureId: spec.id,
    userId,
    entities: [...byKey.entries()].map(([key, row]) => ({ key, ...row })),
    relationships,
    interactionEvents,
    episodes,
    baselines,
  };
}

/**
 * A blank conversation to start the next demo in.
 *
 * The problem this solves is a UX one, not a data one. The reset correctly
 * leaves conversations and messages alone - they are the operator's own
 * history, not the fixture's to delete - but the home page opens the LATEST
 * conversation, so a reset demo still reopened the previous run's transcript
 * with all its turns. The database was clean; the screen was not.
 *
 * So: nothing is deleted. A blank conversation is made the latest one, and the
 * old transcripts stay exactly where they are, reachable and intact.
 *
 * Reuse rather than create when the latest is already blank, or two setup
 * calls in a row would leave a trail of empty conversations behind - and the
 * emptiness is checked by asking for ONE message, not by trusting a flag.
 *
 * This lives here, in the development-only demo surface, and not in the
 * conversation service: "start a fresh conversation because a demo is about to
 * run" is not a rule the product should learn.
 */
export async function ensureBlankConversation(
  deps: DemoFixtureDeps,
  input: { userId: string },
): Promise<{ conversationId: string; conversationCreated: boolean }> {
  const latest = await deps.conversations.findLatest(input.userId);
  if (!latest) {
    const created = await deps.conversations.create(input.userId);
    return { conversationId: created.id, conversationCreated: true };
  }

  const recent = await deps.messages.listRecent(latest.id, 1);
  if (recent.length === 0) {
    // Already blank. Calling setup twice with no chat in between must not
    // mint a second empty conversation.
    return { conversationId: latest.id, conversationCreated: false };
  }

  const created = await deps.conversations.create(input.userId);
  return { conversationId: created.id, conversationCreated: true };
}

export async function readDemoState(
  deps: DemoFixtureDeps,
  input: { userId: string; spec: DemoFixtureSpec; now?: Date },
): Promise<{
  fixtureId: string;
  present: boolean;
  entities: Array<{ key: string; id: string; displayName: string }>;
  relationships: Array<{ from: string; to: string; kind: string; status: string }>;
  baselines: DemoBaselineView[];
  counts: DemoCounts;
}> {
  const { spec, userId } = input;
  const now = input.now ?? deps.clock.now();
  // Resolved by fixture id, so a same-named entity of the user's own is never
  // mistaken for part of the demo - in the state view either.
  const wanted = spec.entities.map((entity) => ({
    key: entity.key,
    id: entityId(spec, userId, entity.key),
    displayName: entity.displayName,
  }));
  const presentIds = new Set(
    await deps.demo.findEntityIds({ userId, ids: wanted.map((row) => row.id) }),
  );
  const owned = wanted.filter((row) => presentIds.has(row.id));
  const nameById = new Map(owned.map((row) => [row.id, row.displayName]));
  const idByKey = new Map(owned.map((row) => [row.key, row.id]));

  const relationshipRows = await deps.relationships.listForUser(userId, 400);
  const relationships = spec.relationships.flatMap((rel) => {
    const toId = idByKey.get(rel.toKey);
    const fromId = rel.fromKey === null ? null : (idByKey.get(rel.fromKey) ?? null);
    if (!toId) return [];
    const row = relationshipRows.find(
      (candidate) =>
        candidate.toEntityId === toId &&
        candidate.fromEntityId === fromId &&
        candidate.kind === rel.kind,
    );
    if (!row) return [];
    return [
      {
        from: fromId === null ? spec.profile.displayName : (nameById.get(fromId) ?? "?"),
        to: nameById.get(toId) ?? "?",
        kind: row.kind,
        status: row.status,
      },
    ];
  });

  const baselines: DemoBaselineView[] = [];
  for (const series of spec.eventSeries) {
    const id = idByKey.get(series.entityKey);
    if (!id) continue;
    const baseline = await deps.baselines.find({
      userId,
      entityId: id,
      eventType: series.eventType,
    });
    if (!baseline) continue;
    // From the fixture's OWN most recent event, not from whatever the user
    // last did. `null` here was the other half of the reported bug: the panel
    // could not tell the operator whether the demo was primed to fire.
    const latest = await deps.demo.latestEventAt({
      userId,
      entityId: id,
      eventType: series.eventType,
    });

    baselines.push({
      entity: nameById.get(id) ?? "?",
      eventType: series.eventType,
      status: baseline.status,
      medianGapDays: baseline.medianGapDays,
      madDays: baseline.madDays,
      derivedThresholdDays:
        baseline.status === "ACTIVE" && baseline.medianGapDays !== null && baseline.madDays !== null
          ? computeCadenceThreshold(baseline.medianGapDays, baseline.madDays)
          : null,
      observationCount: baseline.observationCount,
      lastEventDaysAgo: latest === null ? null : daysBetweenUtcDays(latest, now),
    });
  }

  return {
    fixtureId: spec.id,
    present: owned.length === spec.entities.length,
    entities: owned.map(({ key, id, displayName }) => ({ key, id, displayName })),
    relationships,
    baselines,
    // Scoped to the fixture graph, never to the user: a development account
    // carries real work from earlier acceptance runs, and counting that as
    // demo state made a clean fixture report a dirty start.
    counts: await deps.demo.countsForFixture({
      userId,
      entityIds: owned.map((row) => row.id),
    }),
  };
}
