import { NextResponse } from "next/server";
import { getCurrentUserId } from "@/server/auth/current-user";
import { authorizeDevSeed } from "@/server/config";
import { createDemoFixtureDeps } from "@/server/services/deps";
import { readDemoState } from "@/server/services/demo-fixture";
import { DEMO_GEORGE } from "@/fixtures/demo/george";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Where the demo currently stands (M6 section 12).
 *
 * Ids, statuses and counts. No rendered draft, no plaintext capability token,
 * no prompt and no secret: the one surface that returns a token is the dev
 * notifier inbox, because that token IS the simulated delivery.
 */
export async function GET(request: Request) {
  const auth = authorizeDevSeed(process.env, request.headers.get("x-careloop-dev-secret"));
  if (!auth.allowed) return new NextResponse("Not Found", { status: 404 });

  const userId = await getCurrentUserId();
  if (!userId) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  return NextResponse.json(
    await readDemoState(createDemoFixtureDeps(), { userId, spec: DEMO_GEORGE }),
  );
}
