import { NextResponse } from "next/server";
import { authorizeDevSeed } from "@/server/config";
import { readNotifierInbox } from "@/server/services/dev-tools";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The development notifier's inbox.
 *
 * It exists so a human can click the capability link during local acceptance,
 * which means it DOES return a plaintext token - and that is precisely why it
 * sits behind the same four-condition gate as the other dev routes and returns
 * a bare 404 everywhere else. `/debug` never shows a token; this does, and
 * only here.
 *
 * The inbox is in-process and per-runtime. It is an acceptance aid, not a
 * delivery record: the delivery record is the `family_requests` row.
 */
export async function GET(request: Request) {
  const auth = authorizeDevSeed(process.env, request.headers.get("x-careloop-dev-secret"));
  if (!auth.allowed) return new NextResponse("Not Found", { status: 404 });
  return NextResponse.json({ messages: readNotifierInbox() });
}
