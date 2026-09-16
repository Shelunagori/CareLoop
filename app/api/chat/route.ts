import { after, NextResponse } from "next/server";
import { getCurrentUserId } from "@/server/auth/current-user";
import { ChatRequestSchema } from "@/server/services/chat-request";
import {
  ConversationNotFoundError,
  handleTurn,
} from "@/server/services/conversation";
import {
  createConversationDeps,
  createIngestionDeps,
  createReconnectDeps,
} from "@/server/services/deps";
import { ingestionConfig } from "@/server/config";
import { runIngestionSweep } from "@/server/services/ingestion";
import { runDetectionSweep } from "@/server/services/reconnect";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function jsonError(status: number, error: string, detail?: unknown) {
  return NextResponse.json({ error, detail }, { status });
}

export async function POST(request: Request) {
  const userId = await getCurrentUserId();
  if (!userId) return jsonError(401, "unauthenticated");

  const body = await request.json().catch(() => null);
  const parsed = ChatRequestSchema.safeParse(body);
  if (!parsed.success) {
    // Malformed input is a 4xx, never an unhandled 500.
    return jsonError(400, "invalid_request", parsed.error.issues);
  }

  let turn;
  try {
    turn = await handleTurn(createConversationDeps(), {
      userId,
      conversationId: parsed.data.conversationId,
      text: parsed.data.text,
    });
  } catch (error) {
    if (error instanceof ConversationNotFoundError) {
      // 404 rather than 403: a conversation belonging to someone else must not
      // be distinguishable from one that does not exist.
      return jsonError(404, "conversation_not_found");
    }
    // The failure reason may name a model, a key or a quota. The client gets
    // none of it; the detail stays in the structured log from llm.ts.
    console.error(
      JSON.stringify({
        event: "chat.turn_failed",
        stage: "pre_stream",
        errorName: error instanceof Error ? error.name : "UnknownError",
      }),
    );
    return jsonError(502, "assistant_unavailable");
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const delta of turn.stream) {
          controller.enqueue(encoder.encode(delta));
        }
        controller.close();
      } catch (error) {
        // Headers are already sent, so the only honest signal left is to abort
        // the body. The client drops its partial bubble; nothing was persisted.
        console.error(
          JSON.stringify({
            event: "chat.turn_failed",
            stage: "mid_stream",
            errorName: error instanceof Error ? error.name : "UnknownError",
          }),
        );
        controller.error(error);
      }
    },
  });

  // Post-turn work runs AFTER the response is fully sent, so extraction never
  // delays a single token of the person's reply. The durable job row was
  // already committed alongside the assistant message, so if this instance is
  // reclaimed before or during the sweep, the row simply stays pending and a
  // later request picks it up (R8).
  after(async () => {
    try {
      await runIngestionSweep(createIngestionDeps(), {
        // This turn's job plus a small bounded drain of anything left behind.
        limit: ingestionConfig.drainLimit + 1,
      });
    } catch (error) {
      // Ingestion is never allowed to affect the conversation.
      console.error(
        JSON.stringify({
          event: "ingest.sweep_failed",
          errorName: error instanceof Error ? error.name : "UnknownError",
        }),
      );
    }

    // M4, path B. Separate try/catch and separate deps on purpose: a renderer
    // outage must not roll back ingestion, and neither may reach the reply,
    // which was fully streamed before `after` ran.
    //
    // It is a SWEEP rather than a reaction to this turn's events, because the
    // interesting cadence case is the one where nothing was written: weekly
    // visits, the last one thirteen days ago, and today's chat was about the
    // garden. Bounded in server/config.ts (detectionSweepConfig).
    try {
      await runDetectionSweep(createReconnectDeps(), {
        userId,
        conversationId: turn.conversationId,
      });
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "detection.sweep_failed",
          errorName: error instanceof Error ? error.name : "UnknownError",
        }),
      );
    }
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Conversation-Id": turn.conversationId,
      // Defeats proxy buffering that would otherwise defeat streaming.
      "X-Accel-Buffering": "no",
    },
  });
}
