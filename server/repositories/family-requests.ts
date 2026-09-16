import type { Db } from "./db";

/**
 * M4 reads family_requests and never writes to them — creating one is M5's
 * single transaction (E3). The one question detection needs to ask is whether
 * a loop is already in flight with the family, because starting another while
 * John has been asked something and not answered is the nagging the
 * suppression rules exist to prevent (docs/03 section 10.3).
 *
 * family_requests carries no user_id; ownership is reached through the
 * opportunity, exactly as the RLS policy does (docs/02 section 4.1).
 */
export type FamilyRequestsRepo = {
  countOutstandingForUser(userId: string): Promise<number>;
};

export function familyRequestsRepo(db: Db): FamilyRequestsRepo {
  return {
    async countOutstandingForUser(userId) {
      const { count, error } = await db
        .from("family_requests")
        .select("id, reconnect_opportunities!inner(user_id)", {
          count: "exact",
          head: true,
        })
        // Outstanding = created or delivered but not yet answered, and not
        // expired. `expired` is terminal on both sides and must not silence
        // the companion forever.
        .in("status", ["pending", "delivered"])
        .eq("reconnect_opportunities.user_id", userId);
      if (error) throw new Error(`countOutstandingFamilyRequests failed: ${error.message}`);
      return count ?? 0;
    },
  };
}
