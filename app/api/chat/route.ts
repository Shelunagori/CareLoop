import { NextResponse } from "next/server";
import { getCurrentUserId } from "@/server/auth/current-user";
import { ChatRequestSchema } from "@/server/services/chat-request";
import {
  ConversationNotFoundError,
  handleTurn,
} from "@/server/services/conversation";
import { createConversationDeps } from "@/server/services/deps";

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
