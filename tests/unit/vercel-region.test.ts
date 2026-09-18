import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";

/**
 * WHERE THE FUNCTIONS RUN.
 *
 * Supabase is in ap-southeast-1 (Singapore). Vercel defaults every new project
 * to iad1 (Washington, D.C.), which put a trans-Pacific round trip on every
 * query CareLoop makes. `vercel.json` moves the functions to sin1, the same
 * region as the database.
 *
 * This is guarded because nothing else can guard it: `next build` does not
 * read `vercel.json`, TypeScript does not see it, and deleting the file is a
 * silent, successful deployment that is simply slow again. The only other
 * evidence is the deployment summary, which nobody reads twice.
 */
describe("Vercel function region", () => {
  it("vercel.json exists", () => {
    expect(existsSync("vercel.json"), "vercel.json was removed — functions fall back to iad1").toBe(
      true,
    );
  });

  it("functions run in sin1, the region Supabase is in", () => {
    const config = JSON.parse(readFileSync("vercel.json", "utf8")) as { regions?: unknown };

    // Exactly this, and only this. An extra region is not a free win: Hobby
    // allows one, and a second region far from the database would be slower
    // for whoever landed in it, not faster.
    expect(config.regions).toEqual(["sin1"]);
  });
});
