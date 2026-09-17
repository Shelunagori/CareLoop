import type { Db } from "./db";

/**
 * The write and delete surface the demo fixture needs, and nothing else.
 *
 * It lives apart from the ordinary repositories for two reasons. The first is
 * that DELETE exists nowhere else in CareLoop: the product never removes a
 * person's history, so putting a delete on `entities` would widen the
 * production surface for a development convenience. The second is ownership -
 * these deletes are scoped to rows a named fixture created, and that scoping
 * is the whole safety argument, so it belongs in one readable place.
 *
 * Nothing here names a person. The caller supplies which display names the
 * fixture owns; this file has no idea who George is.
 */
export type ProfileSnapshot = {
  existed: boolean;
  displayName: string | null;
  familyDisplayName: string | null;
};

export type DemoFixtureRepo = {
  /** Exactly what is there now, so it can be put back exactly. */
  readProfile(userId: string): Promise<ProfileSnapshot>;
  /**
   * Sets ONLY the two fields the fixture borrows. `created_at` and anything
   * added later are untouched, and null is written as null rather than being
   * skipped - restoring a field to empty is a restore, not a no-op.
   */
  writeProfile(input: {
    userId: string;
    displayName: string | null;
    familyDisplayName: string | null;
  }): Promise<void>;
  /** For the case where there was no profile row before the demo at all. */
  deleteProfile(userId: string): Promise<void>;
  /**
   * Insert with a caller-chosen id. The ordinary repository cannot do this,
   * and should not: a deterministic id is how the FIXTURE proves a row is its
   * own, and production has no business minting one.
   */
  createEntityWithId(input: {
    id: string;
    userId: string;
    type: string;
    subtype: string | null;
    displayName: string;
    aliases: readonly string[];
  }): Promise<void>;
  createEpisodeWithId(input: {
    id: string;
    userId: string;
    summary: string;
    occurredAt: string;
    precision: string;
    salience: number;
  }): Promise<void>;
  addEpisodeMembers(episodeId: string, entityIds: readonly string[]): Promise<void>;
  /** Which of these ids actually exist for this user. Identity, not names. */
  findEntityIds(input: { userId: string; ids: readonly string[] }): Promise<string[]>;
  findEpisodeIds(input: { userId: string; ids: readonly string[] }): Promise<string[]>;
  /** Episodes are deleted by their own ids, never by what they reference. */
  deleteEpisodesByIds(input: { userId: string; ids: readonly string[] }): Promise<number>;
  /**
   * Deleting an entity cascades through the whole chain the frozen schema
   * already declares: interaction_events, relationships, episode_entities,
   * signals -> reconnect_opportunities -> consent_grants / family_requests ->
   * family_responses / closures. One delete retires an entire demo run.
   */
  deleteEntities(input: { userId: string; entityIds: readonly string[] }): Promise<number>;
  deleteUserFacts(input: { userId: string; keys: readonly string[] }): Promise<number>;
  /**
   * Counts for the demo state view, scoped to the FIXTURE GRAPH.
   *
   * Not to the user. A development account accumulates real work - M5
   * acceptance runs leave consent grants, family requests and closures behind
   * on purpose - and counting those as demo state made the panel report a
   * dirty start from a clean fixture. Every count below starts at the
   * deterministic fixture entity ids and walks foreign keys outward.
   */
  countsForFixture(input: { userId: string; entityIds: readonly string[] }): Promise<DemoCounts>;
  /** The most recent fixture-owned event in one series, or null. */
  latestEventAt(input: {
    userId: string;
    entityId: string;
    eventType: string;
  }): Promise<string | null>;
};

export type DemoCounts = {
  interactionEvents: number;
  baselines: number;
  signalsOpen: number;
  opportunitiesOpen: number;
  consentGrants: number;
  familyRequests: number;
  familyResponses: number;
  closures: number;
};

export function demoFixtureRepo(db: Db): DemoFixtureRepo {
  return {
    async readProfile(userId) {
      const { data, error } = await db
        .from("profiles")
        .select("display_name, family_display_name")
        .eq("id", userId)
        .maybeSingle();
      if (error) throw new Error(`readDemoProfile failed: ${error.message}`);
      if (!data) return { existed: false, displayName: null, familyDisplayName: null };
      return {
        existed: true,
        displayName: data.display_name,
        familyDisplayName: data.family_display_name,
      };
    },

    async writeProfile({ userId, displayName, familyDisplayName }) {
      const { error } = await db
        .from("profiles")
        .upsert(
          { id: userId, display_name: displayName, family_display_name: familyDisplayName },
          { onConflict: "id" },
        );
      if (error) throw new Error(`writeDemoProfile failed: ${error.message}`);
    },

    async deleteProfile(userId) {
      const { error } = await db.from("profiles").delete().eq("id", userId);
      if (error) throw new Error(`deleteDemoProfile failed: ${error.message}`);
    },

    async createEntityWithId(input) {
      const { error } = await db.from("entities").insert({
        id: input.id,
        user_id: input.userId,
        type: input.type as never,
        subtype: input.subtype,
        display_name: input.displayName,
        aliases: [...input.aliases],
      });
      if (error) throw new Error(`createDemoEntity failed: ${error.message}`);
    },

    async createEpisodeWithId(input) {
      const { error } = await db.from("episodes").insert({
        id: input.id,
        user_id: input.userId,
        summary: input.summary,
        occurred_at: input.occurredAt,
        occurred_at_precision: input.precision as never,
        salience: input.salience,
      });
      if (error) throw new Error(`createDemoEpisode failed: ${error.message}`);
    },

    async addEpisodeMembers(episodeId, entityIds) {
      if (entityIds.length === 0) return;
      const { error } = await db
        .from("episode_entities")
        .upsert(
          entityIds.map((entityId) => ({ episode_id: episodeId, entity_id: entityId })),
          { onConflict: "episode_id,entity_id" },
        );
      if (error) throw new Error(`addDemoEpisodeMembers failed: ${error.message}`);
    },

    async findEntityIds({ userId, ids }) {
      if (ids.length === 0) return [];
      const { data, error } = await db
        .from("entities")
        .select("id")
        .eq("user_id", userId)
        .in("id", [...ids]);
      if (error) throw new Error(`findDemoEntities failed: ${error.message}`);
      return (data ?? []).map((row) => row.id);
    },

    async findEpisodeIds({ userId, ids }) {
      if (ids.length === 0) return [];
      const { data, error } = await db
        .from("episodes")
        .select("id")
        .eq("user_id", userId)
        .in("id", [...ids]);
      if (error) throw new Error(`findDemoEpisodes failed: ${error.message}`);
      return (data ?? []).map((row) => row.id);
    },

    async deleteEpisodesByIds({ userId, ids }) {
      if (ids.length === 0) return 0;
      const { data, error } = await db
        .from("episodes")
        .delete()
        // By the episode's OWN id. Never by what it references: an unrelated
        // episode that happens to mention a same-named person is not the
        // fixture's to delete.
        .eq("user_id", userId)
        .in("id", [...ids])
        .select("id");
      if (error) throw new Error(`deleteDemoEpisodes failed: ${error.message}`);
      return data?.length ?? 0;
    },

    async deleteEntities({ userId, entityIds }) {
      if (entityIds.length === 0) return 0;
      const { data, error } = await db
        .from("entities")
        .delete()
        .eq("user_id", userId)
        .in("id", [...entityIds])
        .select("id");
      if (error) throw new Error(`deleteDemoEntities failed: ${error.message}`);
      return data?.length ?? 0;
    },

    async deleteUserFacts({ userId, keys }) {
      if (keys.length === 0) return 0;
      const { data, error } = await db
        .from("facts")
        .delete()
        .eq("user_id", userId)
        // Facts about the user themself only. A fact about an entity goes with
        // the entity.
        .is("subject_entity_id", null)
        .in("key", [...keys])
        .select("id");
      if (error) throw new Error(`deleteDemoFacts failed: ${error.message}`);
      return data?.length ?? 0;
    },

    async latestEventAt({ userId, entityId, eventType }) {
      const { data, error } = await db
        .from("interaction_events")
        .select("occurred_at")
        .eq("user_id", userId)
        .eq("entity_id", entityId)
        .eq("event_type", eventType as never)
        // Positive contact only: an absence assertion is evidence of NOT
        // seeing someone, and would be a nonsense answer to "when last?".
        .eq("polarity", "positive")
        .order("occurred_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw new Error(`latestDemoEvent failed: ${error.message}`);
      return data?.occurred_at ?? null;
    },

    async countsForFixture({ userId, entityIds }) {
      const empty: DemoCounts = {
        interactionEvents: 0,
        baselines: 0,
        signalsOpen: 0,
        opportunitiesOpen: 0,
        consentGrants: 0,
        familyRequests: 0,
        familyResponses: 0,
        closures: 0,
      };
      if (entityIds.length === 0) return empty;
      const ids = [...entityIds];

      const countInteractionEvents = async () => {
        const { count, error } = await db
          .from("interaction_events")
          .select("id", { count: "exact", head: true })
          .eq("user_id", userId)
          .in("entity_id", ids);
        if (error) throw new Error(`count interaction_events failed: ${error.message}`);
        return count ?? 0;
      };
      const countBaselines = async () => {
        const { count, error } = await db
          .from("baselines")
          .select("id", { count: "exact", head: true })
          .eq("user_id", userId)
          .in("entity_id", ids);
        if (error) throw new Error(`count baselines failed: ${error.message}`);
        return count ?? 0;
      };
      const countOpenSignals = async () => {
        const { count, error } = await db
          .from("signals")
          .select("id", { count: "exact", head: true })
          .eq("user_id", userId)
          .in("entity_id", ids)
          .eq("status", "detected");
        if (error) throw new Error(`count signals failed: ${error.message}`);
        return count ?? 0;
      };

      // The opportunity ids ARE the fixture's decision graph: everything in
      // the consent and family loop hangs off one of them, so they are
      // fetched once and every downstream count is filtered by them.
      const { data: opportunityRows, error: opportunityError } = await db
        .from("reconnect_opportunities")
        .select("id, status")
        .eq("user_id", userId)
        .in("entity_id", ids);
      if (opportunityError) {
        throw new Error(`load opportunities failed: ${opportunityError.message}`);
      }
      const opportunityIds = (opportunityRows ?? []).map((row) => row.id);
      const opportunitiesOpen = (opportunityRows ?? []).filter((row) =>
        ["proposed", "drafted", "offered", "approved"].includes(row.status),
      ).length;

      const [interactionEvents, baselines, signalsOpen] = await Promise.all([
        countInteractionEvents(),
        countBaselines(),
        countOpenSignals(),
      ]);

      if (opportunityIds.length === 0) {
        return { ...empty, interactionEvents, baselines, signalsOpen };
      }

      const countConsentGrants = async () => {
        const { count, error } = await db
          .from("consent_grants")
          .select("id", { count: "exact", head: true })
          .in("opportunity_id", opportunityIds);
        if (error) throw new Error(`count consent_grants failed: ${error.message}`);
        return count ?? 0;
      };
      const countClosures = async () => {
        const { count, error } = await db
          .from("closures")
          .select("id", { count: "exact", head: true })
          .in("opportunity_id", opportunityIds);
        if (error) throw new Error(`count closures failed: ${error.message}`);
        return count ?? 0;
      };

      const { data: requestRows, error: requestError } = await db
        .from("family_requests")
        .select("id")
        .in("opportunity_id", opportunityIds);
      if (requestError) throw new Error(`load family_requests failed: ${requestError.message}`);
      const requestIds = (requestRows ?? []).map((row) => row.id);

      const countFamilyResponses = async () => {
        if (requestIds.length === 0) return 0;
        const { count, error } = await db
          .from("family_responses")
          .select("id", { count: "exact", head: true })
          .in("request_id", requestIds);
        if (error) throw new Error(`count family_responses failed: ${error.message}`);
        return count ?? 0;
      };

      const [consentGrants, closures, familyResponses] = await Promise.all([
        countConsentGrants(),
        countClosures(),
        countFamilyResponses(),
      ]);

      return {
        interactionEvents,
        baselines,
        signalsOpen,
        opportunitiesOpen,
        consentGrants,
        familyRequests: requestIds.length,
        familyResponses,
        closures,
      };
    },
  };
}
