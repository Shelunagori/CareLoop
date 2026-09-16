import { NextResponse } from "next/server";
import { getCurrentUserId } from "@/server/auth/current-user";
import { authorizeDevSeed } from "@/server/config";
import { runDetectionSweep } from "@/server/services/reconnect";
import { createReconnectDeps } from "@/server/services/deps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Development-only detection trigger.
 *
 * Runs EXACTLY the sweep an ordinary chat turn runs after its response — same
 * function, same bounds, same deps. It exists so acceptance does not require
 * holding a conversation to observe a cadence gap, not because detection has
 * a second entry point.
 *
 * Same four-condition gate as the M3 seeder (server/config.ts): local
 * development, not a deployment, a configured secret, a matching secret. The
 * user is whoever is signed in; the request cannot name one.
 */
export async function POST(request: Request) {
  const auth = authorizeDevSeed(process.env, request.headers.get("x-careloop-dev-secret"));
  if (!auth.allowed) {
    return new NextResponse("Not Found", { status: 404 });
  }

  const userId = await getCurrentUserId();
  if (!userId) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const result = await runDetectionSweep(createReconnectDeps(), {
    userId,
    // No conversation: this is not a turn. The per-conversation offer cap
    // therefore has nothing to match, which is honest rather than convenient.
    conversationId: null,
  });

  // Deliberately no rendered_text in the response. The draft's bytes are
  // inspected on /debug, which is development-only for the same reason.
  return NextResponse.json(result);
}
