import { NextResponse } from "next/server";
import { getCurrentUserId } from "@/server/auth/current-user";
import { readNoraCutoff, noraConfigured } from "@/core/nora/config";
import { evaluateNoraAvailability } from "@/core/nora/availability";
import { createNoraStatusDeps } from "@/server/services/deps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Whether Nora may run (M12).
 *
 * The browser asks; the server answers. That direction is the whole point of
 * the endpoint. A wake word is a microphone that opens without anyone
 * pressing anything, and the permission to do that expires on a date — so the
 * decision cannot live in a tab that may have been open since before it, in a
 * bundle that may be cached, on a clock that may be wrong, or in a
 * `localStorage` flag from last week. Any of those is a client that still
 * believes; all of them ask here first.
 *
 * The answer is time and configuration only. No credential, no provider name,
 * no file path: a person who is told "Nora is no longer available" is being
 * told a CareLoop product state, not a vendor's billing status.
 */
export async function GET() {
  const userId = await getCurrentUserId();
  if (!userId) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const deps = createNoraStatusDeps();
  const availability = evaluateNoraAvailability({
    now: deps.clock.now(),
    availableUntil: readNoraCutoff(deps.env),
    ...noraConfigured(deps.env),
  });

  return NextResponse.json({
    available: availability.available,
    reason: availability.available ? null : availability.reason,
    availableUntil: availability.availableUntil,
  });
}
