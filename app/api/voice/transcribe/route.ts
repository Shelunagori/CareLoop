import { NextResponse } from "next/server";
import { getCurrentUserId } from "@/server/auth/current-user";
import { VOICE_LIMITS } from "@/core/voice/limits";
import { transcribeTurn } from "@/server/services/voice";
import { createTranscriptionDeps } from "@/server/services/deps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Speech to text (M8).
 *
 * The narrowest useful endpoint in CareLoop: bytes in, one string out. It runs
 * NO extraction, NO detection, NO memory retrieval and NO consent logic. The
 * transcript it returns is put in front of the person, and only travels
 * further if they send it through the ordinary chat endpoint - which is what
 * keeps voice an input rather than a second way into the system.
 *
 * The audio exists for the duration of this function. It is read into memory,
 * handed to the provider from memory, and dropped. No temporary file, no
 * bucket, no row, no log line containing a byte of it.
 */
export async function POST(request: Request) {
  const userId = await getCurrentUserId();
  if (!userId) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });

  const form = await request.formData().catch(() => null);
  const file = form?.get("audio");
  if (!(file instanceof Blob)) {
    return NextResponse.json({ error: "missing_audio" }, { status: 400 });
  }

  // The SERVER decides, from the bytes it actually received. The browser's own
  // duration cap is a courtesy to the person, not a control.
  const result = await transcribeTurn(createTranscriptionDeps(), {
    audio: new Uint8Array(await file.arrayBuffer()),
    mimeType: file.type,
  });

  if (result.outcome === "rejected") {
    return NextResponse.json(
      { error: result.reason.code, maxBytes: VOICE_LIMITS.maxAudioBytes },
      { status: result.reason.code === "too_large" ? 413 : 415 },
    );
  }
  if (result.outcome === "no_speech") {
    return NextResponse.json({ error: "no_speech_detected" }, { status: 422 });
  }
  if (result.outcome === "provider_failed") {
    // The provider's message may name a model, a key or a quota. The client
    // gets none of it; the detail stays in the structured provider log.
    console.error(
      JSON.stringify({ event: "voice.transcribe_failed", errorName: result.errorName }),
    );
    return NextResponse.json({ error: "transcription_failed" }, { status: 502 });
  }

  // One field. Nothing about the audio, the model or the request travels back.
  return NextResponse.json({ text: result.text });
}
