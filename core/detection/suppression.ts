import { DAY_MS } from "@/core/baseline/day";
import { detectionConfig, type DetectionConfig } from "./config";
import type { SignalType } from "./types";

/**
 * Suppression policy (docs/03 section 10.3).
 *
 * Pure, first-class, and in ONE file for two reasons. The failure mode that
 * kills this product is nagging, so the rules that prevent it have to be
 * readable by someone who is not an engineer. And "why didn't CareLoop say
 * anything?" has to have an answer — which it does, because every refusal
 * returns a machine-readable code that is written onto the signal row.
 *
 * What this is NOT: the thing that stops one signal producing two
 * opportunities (F3). That is structural —
 * UNIQUE(reconnect_opportunities.signal_id) plus an atomic materialization.
 * Suppression is TIME-DEPENDENT pacing and is legitimately allowed to answer
 * "yes" twice for the same signal on two attempts. Keeping the two apart is
 * what stops a cooldown tweak from quietly reintroducing duplicate offers.
 */
export const SUPPRESSION_REASONS = [
  "open_opportunity_exists",
  "family_request_outstanding",
  "decline_quiet_period",
  "decline_cooldown",
  "offer_cooldown",
  "account_too_new_for_cadence",
  "conversation_offer_cap",
  "weekly_offer_cap",
] as const;

export type SuppressionReason = (typeof SUPPRESSION_REASONS)[number];

/**
 * A deterministic snapshot, assembled by the service layer from repository
 * reads. No query runs inside this module: that is what lets every rule be
 * tested against a literal object.
 */
export type SuppressionInput = {
  signalType: SignalType;
  entityId: string;
  /**
   * When this account's history begins. Deliberately the earliest evidence the
   * account holds, not the auth row's creation time — see the service layer.
   */
  accountStartedAt: Date;
  /** open = proposed | drafted | offered | approved, for THIS entity. */
  openOpportunityCountForEntity: number;
  /** offered_at of every opportunity ever offered for THIS entity. */
  offeredAtForEntity: readonly Date[];
  /** resolved_at of every DECLINED opportunity for THIS entity. */
  declinedAtForEntity: readonly Date[];
  /** family_requests for this user that are neither answered nor expired. */
  outstandingFamilyRequestCount: number;
  /** Offers already made in the conversation this detection is running from. */
  offersInConversation: number;
  /** offered_at across the whole account, any entity. */
  offeredAtForAccount: readonly Date[];
};

export type SuppressionDecision =
  | { allowed: true }
  | {
      allowed: false;
      reason: SuppressionReason;
      /** Numbers behind the refusal, for the debug view. Never prose. */
      detail: Record<string, number>;
    };

function daysSince(from: Date, now: Date): number {
  return (now.getTime() - from.getTime()) / DAY_MS;
}

function mostRecent(dates: readonly Date[]): Date | null {
  let best: Date | null = null;
  for (const date of dates) {
    if (best === null || date.getTime() > best.getTime()) best = date;
  }
  return best;
}

/**
 * The end of a quiet period triggered by two declines close together, or null.
 * Measured from the LATER decline of the offending pair, so a third decline
 * extends it rather than restarting an unrelated clock.
 */
function quietPeriodEnd(declines: readonly Date[], config: DetectionConfig): Date | null {
  const sorted = [...declines].sort((a, b) => b.getTime() - a.getTime());
  const needed = config.declineCountForQuietPeriod;
  if (sorted.length < needed) return null;

  let end: Date | null = null;
  for (let i = 0; i + needed - 1 < sorted.length; i += 1) {
    const newest = sorted[i];
    const oldest = sorted[i + needed - 1];
    if (daysSince(oldest, newest) <= config.declineWindowDays) {
      const candidate = new Date(newest.getTime() + config.declineQuietPeriodDays * DAY_MS);
      if (end === null || candidate.getTime() > end.getTime()) end = candidate;
    }
  }
  return end;
}

/**
 * Precedence, when several rules are true at once. First match wins, and the
 * order is deliberate rather than incidental:
 *
 *  1. open_opportunity_exists      — a loop for this entity is already running
 *  2. family_request_outstanding   — a loop is running with the family too
 *  3. decline_quiet_period         — the strongest "no" the user has given
 *  4. decline_cooldown             — a single "no"
 *  5. offer_cooldown               — we already asked recently
 *  6. account_too_new_for_cadence  — inferred evidence, too little history
 *  7. conversation_offer_cap       — global pacing, this conversation
 *  8. weekly_offer_cap             — global pacing, this week
 *
 * Reasons the USER effectively gave come before reasons the SYSTEM invented,
 * and specific reasons come before global ones, because the reason recorded on
 * the row is the one a human will read when asking why nothing was said.
 */
export function evaluateSuppression(
  input: SuppressionInput,
  now: Date,
  config: DetectionConfig = detectionConfig,
): SuppressionDecision {
  // 1. At most one open opportunity per entity. `approved` counts as open:
  //    between approval and send the loop is still in flight, and starting a
  //    second one would be exactly the nagging these rules exist to prevent.
  if (input.openOpportunityCountForEntity > 0) {
    return {
      allowed: false,
      reason: "open_opportunity_exists",
      detail: { open: input.openOpportunityCountForEntity },
    };
  }

  // 2. Nothing new while the family has been asked something and not answered.
  if (input.outstandingFamilyRequestCount > 0) {
    return {
      allowed: false,
      reason: "family_request_outstanding",
      detail: { outstanding: input.outstandingFamilyRequestCount },
    };
  }

  // 3. Two declines close together mean "stop asking about this person".
  const quietEnd = quietPeriodEnd(input.declinedAtForEntity, config);
  if (quietEnd !== null && now.getTime() < quietEnd.getTime()) {
    return {
      allowed: false,
      reason: "decline_quiet_period",
      detail: {
        declines: input.declinedAtForEntity.length,
        daysRemaining: daysSince(now, quietEnd),
      },
    };
  }

  // 4. A single decline. Boundary: exactly at the cooldown is ALLOWED.
  const lastDecline = mostRecent(input.declinedAtForEntity);
  if (lastDecline !== null && daysSince(lastDecline, now) < config.declineCooldownDays) {
    return {
      allowed: false,
      reason: "decline_cooldown",
      detail: { daysSinceDecline: daysSince(lastDecline, now) },
    };
  }

  // 5. We asked recently, whatever the answer was.
  const lastOffer = mostRecent(input.offeredAtForEntity);
  if (lastOffer !== null && daysSince(lastOffer, now) < config.offerCooldownDays) {
    return {
      allowed: false,
      reason: "offer_cooldown",
      detail: { daysSinceOffer: daysSince(lastOffer, now) },
    };
  }

  // 6. Cold start — CADENCE ONLY. An explicit absence assertion is the user's
  //    own statement and is never suppressed for being early (docs/03 s9).
  if (input.signalType === "cadence_gap") {
    const accountAgeDays = daysSince(input.accountStartedAt, now);
    if (accountAgeDays < config.newAccountCadenceQuietDays) {
      return {
        allowed: false,
        reason: "account_too_new_for_cadence",
        detail: { accountAgeDays, needDays: config.newAccountCadenceQuietDays },
      };
    }
  }

  // 7. One offer per conversation, so a single sitting cannot become a queue.
  if (input.offersInConversation >= config.maxOffersPerConversation) {
    return {
      allowed: false,
      reason: "conversation_offer_cap",
      detail: {
        offers: input.offersInConversation,
        max: config.maxOffersPerConversation,
      },
    };
  }

  // 8. Global weekly ceiling across every entity.
  const cutoff = now.getTime() - config.offerWeekDays * DAY_MS;
  const offersThisWeek = input.offeredAtForAccount.filter(
    (at) => at.getTime() >= cutoff && at.getTime() <= now.getTime(),
  ).length;
  if (offersThisWeek >= config.maxOffersPerWeek) {
    return {
      allowed: false,
      reason: "weekly_offer_cap",
      detail: { offers: offersThisWeek, max: config.maxOffersPerWeek },
    };
  }

  return { allowed: true };
}
