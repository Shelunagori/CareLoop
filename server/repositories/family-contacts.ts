import type { Db } from "./db";

/**
 * Family contacts hold IDENTITY and no capability at all (R7): who John is and
 * how to reach him. The token that grants read access to one approved sentence
 * lives on the request, not here.
 */
export type FamilyContactRecord = {
  id: string;
  entityId: string;
  channel: string;
  address: string;
  displayName: string | null;
};

export type FamilyContactsRepo = {
  /**
   * Every contact the user has configured, bounded.
   *
   * Added for the wellbeing share (M12e), which — unlike a reconnect offer —
   * is not ABOUT a particular person, so it has to work out who could
   * receive it. The rule that consumes this refuses to guess: one contact
   * means one recipient, and anything else means no offer.
   */
  listForUser(userId: string, limit: number): Promise<FamilyContactRecord[]>;
  findForEntity(userId: string, entityId: string): Promise<FamilyContactRecord | null>;
  /**
   * The contact for ONE channel.
   *
   * `findForEntity` returns whichever row is oldest, which was unambiguous
   * while "dev" was the only channel. Once a user can have both a dev-inbox
   * and an email contact for the same person, "the first one" is a coin flip
   * about where somebody's family message goes - so the caller names the
   * channel it means.
   */
  findForEntityAndChannel(
    userId: string,
    entityId: string,
    channel: string,
  ): Promise<FamilyContactRecord | null>;
  /**
   * Reached from a request during a delivery RETRY, where the entity is not in
   * hand and re-deriving the address would risk addressing a different
   * contact than the one the obligation was created against.
   */
  findById(id: string): Promise<FamilyContactRecord | null>;
  /** Idempotent on (user_id, entity_id, channel, address). */
  ensure(input: {
    userId: string;
    entityId: string;
    channel: string;
    address: string;
    displayName: string | null;
  }): Promise<FamilyContactRecord>;
};

const SELECT = "id, entity_id, channel, address, display_name";

type Row = {
  id: string;
  entity_id: string;
  channel: string;
  address: string;
  display_name: string | null;
};

const toRecord = (row: Row): FamilyContactRecord => ({
  id: row.id,
  entityId: row.entity_id,
  channel: row.channel,
  address: row.address,
  displayName: row.display_name,
});

export function familyContactsRepo(db: Db): FamilyContactsRepo {
  return {
    async listForUser(userId, limit) {
      const { data, error } = await db
        .from("family_contacts")
        .select(SELECT)
        .eq("user_id", userId)
        .order("created_at", { ascending: true })
        .limit(limit);
      if (error) throw new Error(`listFamilyContacts failed: ${error.message}`);
      return (data ?? []).map(toRecord);
    },

    async findForEntity(userId, entityId) {
      const { data, error } = await db
        .from("family_contacts")
        .select(SELECT)
        .eq("user_id", userId)
        .eq("entity_id", entityId)
        .order("created_at", { ascending: true })
        .limit(1)
        .maybeSingle();
      if (error) throw new Error(`findFamilyContact failed: ${error.message}`);
      return data ? toRecord(data) : null;
    },

    async findForEntityAndChannel(userId, entityId, channel) {
      const { data, error } = await db
        .from("family_contacts")
        .select(SELECT)
        .eq("user_id", userId)
        .eq("entity_id", entityId)
        .eq("channel", channel)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw new Error(`findFamilyContactForChannel failed: ${error.message}`);
      return data ? toRecord(data) : null;
    },

    async findById(id) {
      const { data, error } = await db
        .from("family_contacts")
        .select(SELECT)
        .eq("id", id)
        .maybeSingle();
      if (error) throw new Error(`findFamilyContactById failed: ${error.message}`);
      return data ? toRecord(data) : null;
    },

    async ensure(input) {
      const { data, error } = await db
        .from("family_contacts")
        .upsert(
          {
            user_id: input.userId,
            entity_id: input.entityId,
            channel: input.channel,
            address: input.address,
            display_name: input.displayName,
          },
          { onConflict: "user_id,entity_id,channel,address" },
        )
        .select(SELECT)
        .single();
      if (error) throw new Error(`ensureFamilyContact failed: ${error.message}`);
      return toRecord(data);
    },
  };
}
