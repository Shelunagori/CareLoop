import { SHARE_PAYLOAD_FIELDS, type SharePayload } from "@/core/share/payload";

/**
 * What a consent grant records (docs/04 section 11.3).
 *
 * The scope names the RECIPIENT, the PURPOSE and the exact fields that will
 * leave - derived from the payload actually being shared, not from a hardcoded
 * list, so it cannot drift from what is really sent. Everything else the grant
 * holds is a snapshot: the payload, the rendered bytes and their hash, copied
 * rather than rebuilt.
 *
 * Why snapshot the rendered text: consent to "ask John if he's visiting" and
 * consent to a specific sentence are different things, and only the second is
 * verifiable afterwards. The user is never surprised by what their family
 * received, which is the actual trust requirement.
 */
export const CONSENT_PURPOSE = "reconnect_request" as const;

export type ConsentScope = {
  recipientEntityId: string;
  purpose: typeof CONSENT_PURPOSE;
  /** The SharePayload fields that are actually populated in what is sent. */
  fields: string[];
};

export function buildConsentScope(input: {
  recipientEntityId: string;
  payload: SharePayload;
}): ConsentScope {
  const fields = SHARE_PAYLOAD_FIELDS.filter(
    (field) => input.payload[field] !== undefined && input.payload[field] !== null,
  );
  return {
    recipientEntityId: input.recipientEntityId,
    purpose: CONSENT_PURPOSE,
    fields: [...fields],
  };
}

/** How long an approval remains authority to execute the send (F2). */
export const CONSENT_WINDOW_HOURS = 72;

export function consentExpiresAt(grantedAt: Date, windowHours = CONSENT_WINDOW_HOURS): Date {
  return new Date(grantedAt.getTime() + windowHours * 3_600_000);
}
