import type { Db } from "./db";

/**
 * Calling a database function that the generated types do not know about yet.
 *
 * `server/db/types.generated.ts` is produced from the LIVE database and must
 * never be hand-edited, so a function whose migration is written but not yet
 * applied has no generated signature. This is the seam that keeps the build
 * honest in the meantime, and it disappears on the first `npm run db:types`
 * after the migration is reviewed and applied.
 *
 * Note precisely where the cast is: on the NAME and the ARGUMENTS, never on
 * `db.rpc` itself. Extracting the method - `const rpc = db.rpc` - detaches it
 * from its receiver, and supabase-js reads instance state through `this`, so
 * the detached call typechecks perfectly and then dies on `undefined.rest` at
 * runtime. That cost M4 a live acceptance run; it is not repeated here.
 */
export async function callPendingRpc(
  db: Db,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const { data, error } = await db.rpc(name as never, args as never);
  if (error) throw new Error(`${name} failed: ${error.message}`);
  return data;
}
