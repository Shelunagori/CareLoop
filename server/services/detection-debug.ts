import type { Clock } from "@/server/adapters/clock";
import type { EntitiesRepo } from "@/server/repositories/entities";
import type { OpportunitiesRepo } from "@/server/repositories/opportunities";
import type { SignalsRepo } from "@/server/repositories/signals";
import { detectionSweepConfig } from "@/server/config";
import { DAY_MS } from "@/core/baseline/day";
import type { OpportunityStatus } from "@/core/consent/status";
import { buildFallbackText, lastResortText } from "@/core/share/fallback";
import { SharePayloadSchema } from "@/core/share/payload";
import { sha256Hex } from "@/core/share/text-hash";

/**
 * The detection half of the development inspector (docs/03 section 8.3).
 *
 * It exists for one question a demo always gets: "how do you know it isn't
 * just the model guessing?" The answer is the structured explanation, the
 * suppression reason, the exact payload that left, and a hash that can be
 * recomputed in front of you.
 *
 * Read-only and derivational — nothing here writes, and nothing here is a
 * caregiver dashboard. It shows ONE signed-in person their own audit rows.
 */
export type DetectionDebugDeps = {
  clock: Clock;
  signals: SignalsRepo;
  opportunities: OpportunitiesRepo;
  entities: EntitiesRepo;
};

export type OpportunityView = {
  id: string;
  status: OpportunityStatus;
  createdAt: string;
  expiresAt: string;
  /** Derived at read time; expiry is evaluated, never swept. */
  expired: boolean;
  offeredAt: string | null;
  resolvedAt: string | null;
  proposal: unknown;
  sharePayload: unknown;
  renderedText: string | null;
  renderedTextHash: string | null;
  /** Recomputed here, so the stored hash is proved rather than restated. */
  hashMatchesText: boolean | null;
  /**
   * Whether the stored draft is the deterministic template. Derived by
   * rebuilding the template from the stored payload and comparing bytes —
   * which is why no "fallback_used" column was added: the row already
   * contains everything needed to answer.
   */
  fallbackUsed: boolean | null;
};

export type SignalView = {
  id: string;
  signalType: string;
  status: string;
  entityId: string;
  entityName: string;
  detectedAt: string;
  materializedAt: string | null;
  suppressionReason: string | null;
  explanation: unknown;
  opportunity: OpportunityView | null;
};

function describeFallback(
  sharePayload: unknown,
  renderedText: string | null,
): boolean | null {
  if (renderedText === null) return null;
  const parsed = SharePayloadSchema.safeParse(sharePayload);
  if (!parsed.success) return null;
  return (
    renderedText === buildFallbackText(parsed.data) ||
    renderedText === lastResortText(parsed.data.question)
  );
}

export async function loadDetectionDebug(
  deps: DetectionDebugDeps,
  input: { userId: string; now: Date },
): Promise<SignalView[]> {
  const since = new Date(
    input.now.getTime() - detectionSweepConfig.signalHistoryLookbackDays * DAY_MS,
  ).toISOString();

  const [signals, entities] = await Promise.all([
    deps.signals.listRecent(input.userId, since, detectionSweepConfig.signalHistoryLimit),
    deps.entities.listForUser(input.userId, 400),
  ]);
  const nameById = new Map(entities.map((entity) => [entity.id, entity.displayName]));

  const views: SignalView[] = [];
  for (const signal of signals) {
    const opportunity = await deps.opportunities.findBySignal(signal.id);
    views.push({
      id: signal.id,
      signalType: signal.signalType,
      status: signal.status,
      entityId: signal.entityId,
      entityName: nameById.get(signal.entityId) ?? "(deleted entity)",
      detectedAt: signal.detectedAt,
      materializedAt: signal.materializedAt,
      suppressionReason: signal.suppressionReason,
      explanation: signal.explanation,
      opportunity: opportunity
        ? {
            id: opportunity.id,
            status: opportunity.status,
            createdAt: opportunity.createdAt,
            expiresAt: opportunity.expiresAt,
            expired: Date.parse(opportunity.expiresAt) <= input.now.getTime(),
            offeredAt: opportunity.offeredAt,
            resolvedAt: opportunity.resolvedAt,
            proposal: opportunity.proposal,
            sharePayload: opportunity.sharePayload,
            renderedText: opportunity.renderedText,
            renderedTextHash: opportunity.renderedTextHash,
            hashMatchesText:
              opportunity.renderedText === null || opportunity.renderedTextHash === null
                ? null
                : sha256Hex(opportunity.renderedText) === opportunity.renderedTextHash,
            fallbackUsed: describeFallback(opportunity.sharePayload, opportunity.renderedText),
          }
        : null,
    });
  }

  return views;
}
