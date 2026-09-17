import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Conditional-update guards.
 *
 * Every state transition in the consent and family loop is a CONDITIONAL
 * update: the predicate is what makes two concurrent requests unable to
 * approve twice, spend consent twice, or tell the older adult the same news
 * twice. Drop the predicate and the code still typechecks, still passes a
 * single-threaded test, and is wrong exactly when it matters.
 *
 * These are source assertions because the property is about the WHERE clause,
 * and the in-memory fakes model those clauses rather than executing them.
 */
const read = (path: string) => readFileSync(path, "utf8");

function methodBody(source: string, method: string): string {
  const start = source.indexOf(`async ${method}(`);
  if (start < 0) throw new Error(`method ${method} not found`);
  const end = source.indexOf("\n    },", start);
  if (end < 0) throw new Error(`end of ${method} not found`);
  return source.slice(start, end);
}

describe("1. consent grants are single-use, unrevoked and in-window", () => {
  const repo = read("server/repositories/consent-grants.ts");

  it("markUsed refuses a used, revoked or expired grant", () => {
    const body = methodBody(repo, "markUsed");
    expect(body).toContain('.is("used_at", null)');
    expect(body).toContain('.is("revoked_at", null)');
    expect(body).toContain('.gt("expires_at", now)');
  });

  it("markRevoked refuses a grant that has already been spent", () => {
    const body = methodBody(repo, "markRevoked");
    expect(body).toContain('.is("used_at", null)');
    expect(body).toContain('.is("revoked_at", null)');
  });

  it("create is idempotent on the opportunity", () => {
    const body = methodBody(repo, "create");
    // Either the pre-check or the unique-violation reload would do; both are
    // present, and the second is what actually holds under concurrency.
    expect(body).toContain('.eq("opportunity_id", input.opportunityId)');
    expect(repo).toContain("Lost the race on UNIQUE(opportunity_id)");
  });
});

describe("2. opportunity transitions are conditional", () => {
  const repo = read("server/repositories/opportunities.ts");

  it("each transition names the state it moves FROM", () => {
    expect(methodBody(repo, "markOffered")).toContain('.eq("status", "drafted")');
    expect(methodBody(repo, "markApproved")).toContain('.eq("status", "offered")');
    expect(methodBody(repo, "markDeclined")).toContain('.eq("status", "offered")');
    expect(methodBody(repo, "saveDraft")).toContain('.eq("status", "proposed")');
  });

  it("offering and approving both refuse a stale opportunity", () => {
    expect(methodBody(repo, "markOffered")).toContain('.gt("expires_at", now)');
    expect(methodBody(repo, "markApproved")).toContain('.gt("expires_at", now)');
  });

  it("expiry is pre-approval only and never extends the clock", () => {
    const body = methodBody(repo, "markExpired");
    expect(body).toContain('.in("status", ["proposed", "drafted", "offered"])');
    expect(body).toContain('.lte("expires_at", now)');
    expect(body).not.toContain("expires_at:");
  });
});

describe("3. the family request keeps one identity", () => {
  const repo = read("server/repositories/family-requests.ts");

  it("a lost insert race reloads rather than throwing", () => {
    // UNIQUE(opportunity_id) is what actually guarantees one request; the
    // pre-check is only a fast path. The load-bearing line is this one: when
    // the insert loses, we must return the winner's request, not an error --
    // otherwise a retried send reports failure for a message already sent.
    const body = methodBody(repo, "create");
    const afterInsert = body.slice(body.indexOf("if (error)"));
    expect(afterInsert).toContain("findByOpportunity");
    expect(afterInsert).toContain("created: false");
  });

  it("rotateToken only touches an UNDELIVERED request, and only the token", () => {
    const body = methodBody(repo, "rotateToken");
    // Pending only. A delivered request's link is already in the family
    // member's hands; rotating its hash would break a capability someone was
    // handed, which is a worse failure than the one rotation exists to fix.
    expect(body).toContain('.eq("status", "pending")');
    expect(body).not.toContain('"delivered"');
    // Same bytes, same window, same consent. A new capability and nothing else.
    expect(body).toContain("access_token_hash: accessTokenHash");
    expect(body).not.toContain("token_expires_at:");
    expect(body).not.toContain("rendered_body:");
  });

  it("markDelivered only moves a pending request", () => {
    // Transport reporting success twice must not re-stamp delivered_at, and
    // must never move an ANSWERED request backwards to delivered.
    const body = methodBody(repo, "markDelivered");
    expect(body).toContain('.eq("status", "pending")');
  });

  it("expiry is conditional on the clock, never on the caller's belief", () => {
    for (const method of ["markExpired", "expireOverdueForUser"] as const) {
      const body = methodBody(repo, method);
      expect(body, method).toContain('.in("status", ["pending", "delivered"])');
      expect(body, method).toContain('.lte("token_expires_at", now)');
    }
  });

  it("the sweep re-states both conditions on the WRITE, not only the read", () => {
    // `expireOverdueForUser` selects then updates, because family_requests has
    // no user_id and PostgREST cannot filter an UPDATE through a join. Between
    // those two statements another path can answer one of the rows, so the
    // conditions must appear on BOTH - counting them is the point, since a
    // predicate present only on the read looks identical to a grep.
    const body = methodBody(repo, "expireOverdueForUser");
    const occurrences = (needle: string) => body.split(needle).length - 1;
    expect(occurrences('.in("status", ["pending", "delivered"])')).toBe(2);
    expect(occurrences('.lte("token_expires_at", now)')).toBe(2);
  });

  it("an outstanding request must still be inside its window", () => {
    // Defensive against the lazy transition not having run yet: a stale row
    // that kept counting would suppress reconnects about that person forever.
    expect(methodBody(repo, "countOutstandingForUser")).toContain(
      '.gt("token_expires_at", now)',
    );
  });

  it("the token is only ever looked up by hash", () => {
    expect(methodBody(repo, "findByTokenHash")).toContain('.eq("access_token_hash", tokenHash)');
    expect(repo).not.toContain("access_token:");
  });
});

describe("4. a closure is surfaced once", () => {
  const repo = read("server/repositories/closures.ts");

  it("markSurfaced refuses a closure that was already told", () => {
    expect(methodBody(repo, "markSurfaced")).toContain('.is("surfaced_at", null)');
  });

});

describe("5. every demo read and delete is scoped to the fixture", () => {
  const repo = read("server/repositories/demo-fixture.ts");

  it("no delete can reach beyond the caller's own rows", () => {
    // The entire safety argument for a development reset is this predicate.
    // Without it a mistyped id is someone else's history.
    for (const method of ["deleteEpisodesByIds", "deleteEntities", "deleteUserFacts"] as const) {
      expect(methodBody(repo, method), method).toContain('.eq("user_id", userId)');
    }
  });

  it("entity and episode deletion is bounded by an explicit id list", () => {
    expect(methodBody(repo, "deleteEntities")).toContain('.in("id", [...entityIds])');
    // By the episode's OWN id. An episode is never deleted for what it
    // happens to mention.
    expect(methodBody(repo, "deleteEpisodesByIds")).toContain('.in("id", [...ids])');
    expect(methodBody(repo, "deleteEpisodesByIds")).not.toContain("episode_entities");
  });

  it("the fixture writes with caller-chosen ids, which is how it proves ownership", () => {
    // A deterministic id is the ownership marker. If these inserts ever stop
    // carrying one, ownership silently falls back to guessing by name.
    expect(methodBody(repo, "createEntityWithId")).toContain("id: input.id");
    expect(methodBody(repo, "createEpisodeWithId")).toContain("id: input.id");
    expect(methodBody(repo, "findEntityIds")).toContain('.in("id", [...ids])');
  });

  it("demo counts start from the fixture's entity ids, never from user_id alone", () => {
    const body = methodBody(repo, "countsForFixture");
    // Every count reachable from an entity is filtered by the fixture's ids.
    const occurrences = body.split('.in("entity_id", ids)').length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(4);
    // And the decision graph is reached by FOREIGN KEY, not by user.
    expect(body).toContain('.in("opportunity_id", opportunityIds)');
    expect(body).toContain('.in("request_id", requestIds)');
    // A count that filtered only by user would have produced the live bug.
    expect(body).not.toMatch(/from\("consent_grants"\)[\s\S]{0,200}?eq\("user_id"/);
    expect(body).not.toMatch(/from\("closures"\)[\s\S]{0,200}?eq\("user_id"/);
  });

  it("the fixture's last event is its own, positive, and the most recent", () => {
    const body = methodBody(repo, "latestEventAt");
    expect(body).toContain('.eq("entity_id", entityId)');
    expect(body).toContain('.eq("event_type", eventType as never)');
    // An absence assertion is evidence of NOT seeing someone; it can never be
    // the answer to "when did they last visit?".
    expect(body).toContain('.eq("polarity", "positive")');
    expect(body).toContain('.order("occurred_at", { ascending: false })');
    expect(body).toContain(".limit(1)");
  });

  it("the profile delete names one row, by primary key", () => {
    // `profiles` is keyed by `id`, not `user_id`, so the usual scope guard
    // would not catch a widened predicate here. A delete that matched more
    // than one row would remove other people's profiles outright.
    const body = methodBody(repo, "deleteProfile");
    expect(body).toContain('.eq("id", userId)');
    expect(body).not.toMatch(/\.neq\(|\.gt\(|\.in\(/);
  });

  it("the profile is put back field by field, nulls included", () => {
    const body = methodBody(repo, "writeProfile");
    // Both columns are always written, so restoring a field to empty is a
    // restore rather than a skipped no-op. And no other column is touched.
    expect(body).toContain("display_name: displayName");
    expect(body).toContain("family_display_name: familyDisplayName");
    expect(body).not.toContain("created_at");
  });

  it("fact deletion touches only facts about the user, and only named keys", () => {
    const body = methodBody(repo, "deleteUserFacts");
    // A fact ABOUT an entity goes with the entity; this method must not
    // widen into one.
    expect(body).toContain('.is("subject_entity_id", null)');
    expect(body).toContain('.in("key", [...keys])');
  });

  it("an empty id list deletes nothing at all", () => {
    for (const method of ["deleteEpisodesByIds", "deleteEntities", "deleteUserFacts"] as const) {
      // `in("id", [])` is a filter that matches nothing in PostgREST, but
      // relying on that is relying on a library's edge case. The guard is
      // explicit and comes first.
      expect(methodBody(repo, method), method).toMatch(/length === 0\) return 0;/);
    }
  });

  it("the demo repository is the only file in the codebase that deletes", () => {
    // DELETE exists nowhere else: the product never removes a person's
    // history, and a development convenience must not widen that surface.
    const offenders = readdirSync("server/repositories")
      .filter((file) => file.endsWith(".ts") && file !== "demo-fixture.ts")
      .filter((file) => /\.delete\(\)/.test(read(`server/repositories/${file}`)));
    expect(offenders).toEqual([]);
  });
});

describe("6. no repository detaches a client method", () => {
  it("the M5 repositories call through the client", () => {
    for (const file of [
      "server/repositories/consent-grants.ts",
      "server/repositories/family-contacts.ts",
      "server/repositories/family-requests.ts",
      "server/repositories/family-responses.ts",
      "server/repositories/closures.ts",
      "server/repositories/rpc.ts",
    ]) {
      const detached = /(?:const|let|var)\s+\w+\s*=\s*db\.\w+\s*(?:as[^;]*)?;/.exec(read(file));
      expect(detached?.[0] ?? null, file).toBeNull();
    }
  });
});
