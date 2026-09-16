import type { Db } from "./db";

/**
 * The user's own profile row. The outbound path reads exactly one field from
 * it — `family_display_name`, the label the user chose for themselves — and
 * `created_at` for the cold-start rule.
 */
export type ProfileRecord = {
  id: string;
  displayName: string | null;
  /** SharePayload.fromDisplayName (docs/04 section 11.4). */
  familyDisplayName: string | null;
  createdAt: string;
};

export type ProfilesRepo = {
  find(userId: string): Promise<ProfileRecord | null>;
};

export function profilesRepo(db: Db): ProfilesRepo {
  return {
    async find(userId) {
      const { data, error } = await db
        .from("profiles")
        .select("id, display_name, family_display_name, created_at")
        .eq("id", userId)
        .maybeSingle();
      if (error) throw new Error(`findProfile failed: ${error.message}`);
      if (!data) return null;
      return {
        id: data.id,
        displayName: data.display_name,
        familyDisplayName: data.family_display_name,
        createdAt: data.created_at,
      };
    },
  };
}
