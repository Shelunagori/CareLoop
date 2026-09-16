import { NextResponse } from "next/server";
import { familyConfig } from "@/server/config";
import { recordFamilyReply } from "@/server/services/family-response";
import { createFamilyResponseDeps } from "@/server/services/deps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The family member's reply.
 *
 * A form post, one field, validated against the choices this request's topic
 * actually offers. There is no free-text field and therefore no parse, no
 * prompt and no model call - the whole of M5 adds zero LLM calls.
 *
 * Idempotent by construction: the response row, the closure and the request's
 * `answered` transition land in one database function behind
 * UNIQUE(family_responses.request_id), so a double-tap cannot make the older
 * adult hear the news twice.
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ token: string }> },
) {
  const { token } = await context.params;
  const form = await request.formData().catch(() => null);
  const choiceId = form?.get("choice");

  const back = (query: string) =>
    NextResponse.redirect(
      new URL(`${familyConfig.respondPath}/${encodeURIComponent(token)}${query}`, request.url),
      // 303: turn the POST into a GET so a refresh cannot resubmit.
      { status: 303 },
    );

  if (typeof choiceId !== "string" || choiceId.length === 0) return back("?error=1");

  const result = await recordFamilyReply(createFamilyResponseDeps(), { token, choiceId });

  switch (result.outcome) {
    case "recorded":
    case "already_answered":
      return back("?answered=1");
    case "expired":
    case "not_found":
    case "not_answerable":
    case "invalid_choice":
      // The page re-renders and shows the honest state; the token itself is
      // never echoed into an error message.
      return back("?error=1");
  }
}
