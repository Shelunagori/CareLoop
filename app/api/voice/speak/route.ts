import { NextResponse } from "next/server";
import { getCurrentUserId } from "@/server/auth/current-user";
import { VOICE_LIMITS } from "@/core/voice/limits";
import { speakText } from "@/server/services/voice";
import { resolveSpeakable } from "@/server/services/speakable";
import { SpeakRequestSchema } from "@/server/services/speak-request";
import { createSpeakableDeps, createSynthesisDeps } from "@/server/services/deps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Text to speech (M8).
 *
 * It speaks text the person can already read, and it establishes that for
 * itself. The request names an OBJECT - an assistant message, the offer on the
 * table, a closure - and the server resolves it, proves it belongs to the
 * caller and derives the words from storage. No sentence supplied by a browser
 * is ever synthesised, because a browser is not authoritative about what
 * CareLoop said, and an endpoint that trusted it would be a general-purpose
 * speech proxy wearing CareLoop's voice.
 *
 * There is no prompt here, no model choosing words, and no rewriting for
 * "naturalness" - if this endpoint could improve a sentence on its way to the
 * speaker, the spoken CareLoop and the written CareLoop would be two different
 * companions, and only one of them would be the one under test.
 *
 * That is also why the exact-text chain survives voice untouched: reading the
 * approved draft aloud is a rendering of the stored bytes, and the bytes that
 * get sent are still the ones that were shown and approved.
 */
export async function POST(request: Request) {
  const userId = await getCurrentUserId();
  if (!userId) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const parsed = SpeakRequestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "invalid_request" }, { status: 400 });

  const speakable = await resolveSpeakable(createSpeakableDeps(), {
    userId,
    conversationId: parsed.data.conversationId,
    source: parsed.data.source,
  });
  if (speakable.outcome === "not_found") {
    // 404 rather than 403: an object belonging to someone else must not be
    // distinguishable from one that does not exist.
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const result = await speakText(createSynthesisDeps(), { text: speakable.text });

  if (result.outcome === "unavailable") {
    // Absent credentials are a configuration fact, not an error: CareLoop stays
    // fully usable - typed and spoken - with no voice output at all. The
    // provider itself says so; this route runs no environment check of its own.
    return NextResponse.json({ error: "speech_unavailable" }, { status: 503 });
  }
  if (result.outcome === "rejected") {
    return NextResponse.json(
      { error: result.reason.code, maxCharacters: VOICE_LIMITS.maxSpeakCharacters },
      { status: result.reason.code === "too_long" ? 413 : 400 },
    );
  }
  if (result.outcome === "provider_failed") {
    console.error(
      JSON.stringify({ event: "voice.synthesize_failed", errorName: result.errorName }),
    );
    // A failure here costs the person nothing they cannot read. The reply is
    // already on screen and the conversation is unaffected.
    return NextResponse.json({ error: "speech_failed" }, { status: 502 });
  }

  return new Response(Buffer.from(result.audio), {
    headers: {
      "Content-Type": result.mimeType,
      "Cache-Control": "no-store",
      "Content-Length": String(result.audio.byteLength),
    },
  });
}
