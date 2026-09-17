import { after, NextResponse } from "next/server";
import { getCurrentUserId } from "@/server/auth/current-user";
import { ChatRequestSchema } from "@/server/services/chat-request";
import {
  ConversationNotFoundError,
  handleTurn,
} from "@/server/services/conversation";
import {
  createConversationDeps,
  createFamilySendDeps,
  createIngestionDeps,
  createReconnectDeps,
} from "@/server/services/deps";
import { ingestionConfig } from "@/server/config";
import { runIngestionSweep } from "@/server/services/ingestion";
import { runDetectionSweep } from "@/server/services/reconnect";
import {
  expireOverdueFamilyRequests,
  sendApprovedOpportunity,
} from "@/server/services/family-send";

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
        // Newline-delimited JSON, one turn event per line. Framed rather than
        // flat text so the browser is handed the reconnect offer as FIELDS -
        // recipient, opportunity id, the exact stored bytes - instead of being
        // asked to recover them by reading the assistant's prose. What gets
        // persisted is unchanged; this is the wire only.
        for await (const event of turn.stream) {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
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
    // M5, the outbound leg. FIRST in the after-response path, because the
    // person has just said yes and the message going out is the thing they are
    // waiting on - but still after the response is flushed, so a notifier
    // outage can never cost them their reply.
    //
    // ZERO model calls happen in here. The bytes were rendered, guarded,
    // stored, hashed and shown before the approval; sending is a byte copy.
    if (turn.pendingSendOpportunityId !== null) {
      try {
        await sendApprovedOpportunity(createFamilySendDeps(), {
          userId,
          opportunityId: turn.pendingSendOpportunityId,
        });
      } catch (error) {
        // The obligation is durable (E3): the request row, the spent grant and
        // the consumed opportunity are already committed. This failure is
        // transport, so the row stays `pending` and a later turn retries the
        // same bytes. The person is never asked to approve anything twice.
        console.error(
          JSON.stringify({
            event: "family.send_failed",
            opportunityId: turn.pendingSendOpportunityId,
            errorName: error instanceof Error ? error.name : "UnknownError",
          }),
        );
      }
    }

    // The lazy half of the family-request lifecycle. A request whose read
    // window has closed stops being outstanding the moment the clock says so,
    // but the ROW has to learn that too - otherwise it suppresses reconnects
    // about that person forever. This is the bounded sweep that retires them,
    // on a path that is already running and already after the response.
    try {
      await expireOverdueFamilyRequests(createFamilySendDeps(), { userId });
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "family.expiry_sweep_failed",
          errorName: error instanceof Error ? error.name : "UnknownError",
        }),
      );
    }

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
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Conversation-Id": turn.conversationId,
      // Defeats proxy buffering that would otherwise defeat streaming.
      "X-Accel-Buffering": "no",
    },
  });
}
