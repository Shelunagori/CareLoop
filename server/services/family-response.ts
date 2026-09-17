import type { ShareTopic } from "@/core/share/payload";
import { z } from "zod";
import type { Clock } from "@/server/adapters/clock";
import type { Db } from "@/server/repositories/db";
import { callPendingRpc } from "@/server/repositories/rpc";
import type {
  FamilyRequestRecord,
  FamilyRequestsRepo,
} from "@/server/repositories/family-requests";
import type { FamilyResponsesRepo } from "@/server/repositories/family-responses";
import { hashFamilyToken, isTokenExpired, tokenHashPrefix } from "@/core/family/token";
import {
  FamilyReplySchema,
  findReplyChoice,
  replyChoicesFor,
  type FamilyReply,
  type FamilyReplyChoice,
} from "@/core/family/response";
import { SharePayloadSchema, type SharePayload } from "@/core/share/payload";

/**
 * The family surface (docs/04 sections 12.1, 12.4).
 *
 * The URL *is* the capability: no account, no password, no session. The token
 * is looked up by SHA-256 hash, so the plaintext exists only in the link the
 * recipient holds - never in the database, a log or a debug view.
 *
 * What this service can return is deliberately tiny: one approved sentence,
 * one sender label and a set of replies. There is no endpoint here that can
 * return the older adult's history, because there is no code path that reads
 * it - the temptation cannot be satisfied later without a reviewable change.
 */
export type FamilyResponseDeps = {
  clock: Clock;
  db: Db;
  familyRequests: FamilyRequestsRepo;
  familyResponses: FamilyResponsesRepo;
};

export type FamilyView =
  | {
      outcome: "ok";
      requestId: string;
      /** The approved bytes, exactly as sent. */
      message: string;
      fromDisplayName: string;
      /** The approved topic, so the page can ask the matching question. */
      topic: ShareTopic;
      choices: FamilyReplyChoice[];
      alreadyAnswered: boolean;
    }
  | { outcome: "not_found" }
  | { outcome: "expired" };

function readPayload(value: unknown): SharePayload | null {
  const parsed = SharePayloadSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function logEvent(record: Record<string, unknown>): void {
  console.log(JSON.stringify(record));
}

async function resolveRequest(
  deps: FamilyResponseDeps,
  token: string,
): Promise<
  | { ok: true; request: FamilyRequestRecord; payload: SharePayload }
  | { ok: false; view: FamilyView }
> {
  // A malformed or unknown token is indistinguishable from a wrong one.
  if (typeof token !== "string" || token.length < 16 || token.length > 128) {
    return { ok: false, view: { outcome: "not_found" } };
  }

  const request = await deps.familyRequests.findByTokenHash(hashFamilyToken(token));
  if (!request) return { ok: false, view: { outcome: "not_found" } };

  if (isTokenExpired(request.tokenExpiresAt, deps.clock.now())) {
    logEvent({
      event: "family.token_expired",
      requestId: request.id,
      tokenHashPrefix: tokenHashPrefix(request.accessTokenHash),
    });
    return { ok: false, view: { outcome: "expired" } };
  }

  const payload = readPayload(request.payload);
  if (!payload) return { ok: false, view: { outcome: "not_found" } };
  return { ok: true, request, payload };
}

export async function loadFamilyView(
  deps: FamilyResponseDeps,
  token: string,
): Promise<FamilyView> {
  const resolved = await resolveRequest(deps, token);
  if (!resolved.ok) return resolved.view;

  const { request, payload } = resolved;
  await deps.familyRequests.markOpened({
    id: request.id,
    now: deps.clock.now().toISOString(),
  });

  const existing = await deps.familyResponses.findByRequest(request.id);

  return {
    outcome: "ok",
    requestId: request.id,
    // The stored approved bytes. Nothing reformats them on the way out.
    message: request.renderedBody,
    fromDisplayName: payload.fromDisplayName,
    // Surfaced so the page can ask the right question. It is the SERVER's
    // topic, from the approved payload, not something the page guesses.
    topic: payload.topic,
    choices: replyChoicesFor(payload.topic),
    alreadyAnswered: existing !== null,
  };
}

const RecordResultSchema = z.object({
  outcome: z.enum([
    "recorded",
    "already_answered",
    "request_not_found",
    "request_expired",
    "request_not_answerable",
  ]),
  // Opaque identifiers. Validated for presence, not for format: the shape is
  // the database's to choose, and pinning it here would only break the day it
  // changes.
  responseId: z.string().min(1).nullish(),
  closureId: z.string().min(1).nullish(),
});

export type RecordReplyOutcome =
  | { outcome: "recorded" | "already_answered"; responseId: string; closureId: string | null }
  | { outcome: "not_found" }
  | { outcome: "expired" }
  | { outcome: "invalid_choice" }
  | { outcome: "not_answerable" };

/**
 * Records one reply.
 *
 * The choice id is validated against the choices this request's topic actually
 * offers, so the endpoint cannot be driven to store an arbitrary intent. No
 * model is involved: a bounded vocabulary needs no interpreting, which is why
 * M5 adds zero LLM calls anywhere.
 *
 * The response row, the closure and the request's `answered` transition land
 * together in one database function, so a family member double-tapping the
 * link cannot produce two closures - and the older adult cannot be told twice.
 */
export async function recordFamilyReply(
  deps: FamilyResponseDeps,
  input: { token: string; choiceId: string },
): Promise<RecordReplyOutcome> {
  const resolved = await resolveRequest(deps, input.token);
  if (!resolved.ok) {
    return resolved.view.outcome === "expired" ? { outcome: "expired" } : { outcome: "not_found" };
  }

  const { request, payload } = resolved;
  const choice = findReplyChoice(payload.topic, input.choiceId);
  if (!choice) return { outcome: "invalid_choice" };

  const reply: FamilyReply = FamilyReplySchema.parse({
    intent: choice.intent,
    ...(choice.timeframe ? { timeframe: choice.timeframe } : {}),
  });

  const raw = await callPendingRpc(deps.db, "record_family_response", {
    p_request_id: request.id,
    // The family member's own words, as they chose them.
    p_raw_body: choice.label,
    p_parsed: reply,
    p_now: deps.clock.now().toISOString(),
  });

  const parsed = RecordResultSchema.safeParse(raw);
  if (!parsed.success) throw new Error("record_family_response returned an unrecognised shape");

  logEvent({
    event: "family.replied",
    requestId: request.id,
    outcome: parsed.data.outcome,
    intent: reply.intent,
  });

  switch (parsed.data.outcome) {
    case "recorded":
    case "already_answered":
      return {
        outcome: parsed.data.outcome,
        responseId: parsed.data.responseId as string,
        closureId: parsed.data.closureId ?? null,
      };
    case "request_expired":
      return { outcome: "expired" };
    case "request_not_found":
      return { outcome: "not_found" };
    case "request_not_answerable":
      return { outcome: "not_answerable" };
  }
}
