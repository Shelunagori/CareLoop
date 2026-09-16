import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/server/db/types.generated";

/** The typed Supabase client every repository takes. */
export type Db = SupabaseClient<Database>;
