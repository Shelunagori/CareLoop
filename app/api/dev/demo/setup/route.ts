import { NextResponse } from "next/server";
import { z } from "zod";
import { getCurrentUserId } from "@/server/auth/current-user";
import { authorizeDevSeed } from "@/server/config";
import { createDemoFixtureDeps } from "@/server/services/deps";
import {
  ensureBlankConversation,
  readDemoState,
  resetDemoFixture,
  seedDemoFixture,
} from "@/server/services/demo-fixture";
import { clearNotifierInbox } from "@/server/services/dev-tools";
import { DEMO_GEORGE } from "@/fixtures/demo/george";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Development-only demo setup (M6).
 *
 * One call, because an operator about to run a demo in front of someone wants
 * one command and a state report, not a sequence they can get half-way
 * through. `reset` retires everything the fixture owns; `seed` writes it back.
 * Neither touches the rest of the database, and neither requires
 * `supabase db reset` - restarting the scenario is seconds, not minutes.
 *
 * Behind the same four-condition gate as every other dev route, and returning
 * a bare 404 anywhere else: the route does not advertise its own existence.
 */
const SetupRequestSchema = z
  .object({
    /** false seeds on top of whatever is there. Default is a clean start. */
    reset: z.boolean().default(true),
  })
  .default({ reset: true });

export async function POST(request: Request) {
  const auth = authorizeDevSeed(process.env, request.headers.get("x-careloop-dev-secret"));
  if (!auth.allowed) return new NextResponse("Not Found", { status: 404 });

  const userId = await getCurrentUserId();
  if (!userId) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const parsed = SetupRequestSchema.safeParse(await request.json().catch(() => undefined));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_request", detail: parsed.error.issues }, { status: 400 });
  }

  const deps = createDemoFixtureDeps();
  const removed = parsed.data.reset
    ? await resetDemoFixture(deps, { userId, spec: DEMO_GEORGE })
    : null;
  // A reset clears the development notifier's outbox as well, so the family
  // side of the demo does not open holding last run's reply link.
  if (parsed.data.reset) clearNotifierInbox();
  const seeded = await seedDemoFixture(deps, { userId, spec: DEMO_GEORGE });
  const state = await readDemoState(deps, { userId, spec: DEMO_GEORGE });

  // Nothing is deleted. A blank conversation is simply made the latest one, so
  // reloading `/` opens an empty chat while every earlier transcript stays
  // exactly where it was.
  const conversation = await ensureBlankConversation(deps, { userId });

  return NextResponse.json({
    removed,
    seeded,
    state,
    // Named explicitly rather than spread: this is the response contract the
    // demo operator reads, and it should be greppable from the route.
    conversationId: conversation.conversationId,
    conversationCreated: conversation.conversationCreated,
  });
}
